import { randomUUID } from "node:crypto";
import type { Page } from "playwright-core";
import { createHiddenPage, getBrowser } from "../session";
import { crawlDatabase } from "../crawler/controller";
import { assertAvailable, pace } from "../crawler/page";
import { hoverForInspection } from "../viewport";
import { buildPageState } from "../page-state";
import { readStableSnapshot } from "../workflow";
import { cleanDescription } from "../crawler/compact";
import { parseEquipmentAttributes } from "./equip-attributes";
import {
  equipmentIdentity,
  safeEquipmentUrl,
  verifyEquipmentCandidate,
  type EquipmentCandidate,
  type EquipmentPricingItem,
  type EquipmentSource,
} from "./equipment-pricing";

export const EQUIPMENT_SEARCH_URL =
  "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=show_overall_search_equip";
export const JEWELRY_SEARCH_URL =
  "https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py?act=show_overall_search_lingshi";
const MAX_PAGES = 3,
  MAX_ROWS = 30,
  MAX_DETAILS = 10;
type Choices = Array<[string | number, string]>;
export type EquipmentSearchConfig = {
  kinds: Choices;
  effects: Choices;
  skills: Choices;
  gems: Choices;
};
type Query = Record<string, string | number>;
const isJewelry = (item: EquipmentPricingItem) =>
  /灵饰|戒指|耳饰|手镯|佩饰|配饰/.test(item.category) ||
  /精炼等级/.test(item.description) ||
  [61, 62, 63, 64].includes(Number(item.kindId));

/** Official page fields are coarse filters; only detail verification establishes a match. */
export function equipmentQuery(item: EquipmentPricingItem, config: EquipmentSearchConfig) {
  if (item.level === null) throw new Error("装备等级缺失，不能查询");
  const jewelry = isJewelry(item);
  const fields = parseEquipmentAttributes(item.description).fields;
  const args: Query = jewelry
    ? { equip_level_min: item.level, equip_level_max: item.level, pass_fair_show: "1" }
    : { level_min: item.level, level_max: item.level, front_status: "pass_fair_show" };
  const category = item.category.replace("配饰", "佩饰");
  const kind =
    config.kinds.find(([id]) => item.kindId !== undefined && Number(id) === Number(item.kindId)) ||
    [...config.kinds]
      .sort((a, b) => b[1].length - a[1].length)
      .find(([, label]) => category.includes(label));
  if (kind) args.kindid = String(kind[0]);
  const integer = (field: string, parameter: string) => {
    const values = fields[field];
    if (values?.length !== 1 || !/^\+?\d+$/.test(values[0])) return;
    args[parameter] = Number(values[0].replace("+", ""));
  };
  integer("修理失败", "repair_fail");
  if (jewelry) integer("精炼等级", "jinglian_level");
  else {
    integer("伤害", "damage");
    integer("灵力", "all_wakan");
    integer("锻炼等级", "gem_level");
    for (const [field, key, choices] of [
      ["特效", "special_effect", config.effects],
      ["特技", "special_skill", config.skills],
      ["宝石", "gem_value", config.gems],
    ] as const) {
      const values = (fields[field] || []).flatMap((value) =>
        value.split(/[、，,；;]/).map((part) => part.trim()),
      );
      const matched = values.flatMap((value) => choices.filter(([, label]) => value === label));
      if (matched.length) args[key] = matched.map(([id]) => String(id)).join(",");
    }
    if (args.special_effect) args.special_mode = "and";
  }
  return { jewelry, args };
}

/** Read only the principal equipment description and price, never recommendations. */
export async function equipmentPageSource(page: Page, signal: AbortSignal) {
  signal.throwIfAborted();
  await assertAvailable(page);
  const excluded =
    '#search_result, #recommd_list, #recommend, .recommend, .recommd, #bottomRecommands, .recommandWrp, .goodsRemmds, [id$="TipsBox"]';
  const directPanel = await page
    .locator("#equip_desc_panel")
    .evaluateAll(
      (nodes, excluded) => nodes.some((node) => node.checkVisibility() && !node.closest(excluded)),
      excluded,
    );
  if (!directPanel) {
    const icons = page.locator("img[data_equip_name], img[data-equip-name]");
    const index = await icons.evaluateAll((nodes, excluded) => {
      const candidates = nodes.filter((node) => node.checkVisibility() && !node.closest(excluded));
      return candidates.length === 1 ? nodes.indexOf(candidates[0]) : -1;
    }, excluded);
    if (index < 0) throw new Error("未能确认独立装备的主商品图标，不能采用推荐商品价格");
    const principal = icons.nth(index);
    await principal.evaluate((el) => el.setAttribute("data-cbg-main-equipment", "true"));
    await hoverForInspection(page, principal);
    await page.waitForFunction(
      () => {
        const main = document.querySelector('[data-cbg-main-equipment="true"]');
        if (!main) return false;
        const description =
          main.getAttribute("data_equip_desc") || main.getAttribute("data-equip-desc") || "";
        const name =
          main.getAttribute("data_equip_name") || main.getAttribute("data-equip-name") || "";
        const id = main.getAttribute("data_tip_box") || main.getAttribute("data-tip-box");
        if (!id && /等级\s*[：:]?\s*\d/.test(description)) return true;
        const tips = id
          ? [document.getElementById(id)]
          : Array.from(
              document.querySelectorAll<HTMLElement>(
                '[id$="TipsBox"], [role="tooltip"], .equip_tips',
              ),
            );
        return tips.some(
          (tip) =>
            tip?.checkVisibility() &&
            tip.innerText.includes(name) &&
            /等级\s*[：:]?\s*\d/.test(tip.innerText),
        );
      },
      undefined,
      { timeout: 5000 },
    );
  }
  signal.throwIfAborted();
  const observed = await page.evaluate(
    ({ directPanel, excluded }) => {
      const globals = window as unknown as {
        equip?: Record<string, unknown>;
        EquipInfo?: Record<string, unknown>;
        CBG_GAME_CONFIG?: { equip_info?: Record<string, { name?: unknown; desc?: unknown }> };
      };
      const raw = globals.equip || globals.EquipInfo;
      const panel = directPanel ? document.querySelector<HTMLElement>("#equip_desc_panel") : null;
      const info = directPanel ? document.querySelector<HTMLElement>("#info_panel") : null;
      const root = panel?.closest<HTMLElement>(".infoList.goodsInfo");
      if (
        directPanel &&
        (!panel?.checkVisibility() ||
          !info?.checkVisibility() ||
          !root ||
          info.closest(".infoList.goodsInfo") !== root ||
          root.closest(excluded))
      )
        throw new Error("无法确认独立装备的主商品属性与价格区域");
      const main = document.querySelector<HTMLImageElement>('[data-cbg-main-equipment="true"]');
      if (!directPanel && !main) throw new Error("装备主商品图标已改变");
      const name = directPanel
        ? info!.innerText
            .match(/(?:^|\s)ID\s*[：:]\s*(.+?)(?=\s+等级\s*[：:]|\r?\n|$)/i)?.[1]
            ?.trim() || ""
        : main!.getAttribute("data_equip_name") || main!.getAttribute("data-equip-name") || "";
      const tipId = main?.getAttribute("data_tip_box") || main?.getAttribute("data-tip-box");
      const tips = tipId
        ? [document.getElementById(tipId)]
        : Array.from(
            document.querySelectorAll<HTMLElement>(
              '[id$="TipsBox"], [role="tooltip"], .equip_tips',
            ),
          );
      const tooltip = tips.find(
        (node) => !directPanel && node?.checkVisibility() && node.textContent?.includes(name),
      );
      const prices = Array.from(
        (info || document).querySelectorAll<HTMLElement>("[data_price], [data-price], .price"),
      )
        .filter(
          (node) =>
            node.checkVisibility() &&
            !node.closest(excluded) &&
            !node.closest("#equip_price_addon_info"),
        )
        .map(
          (node) =>
            node.getAttribute("data_price") || node.getAttribute("data-price") || node.innerText,
        );
      const rawPrice =
        raw &&
        (typeof raw.price === "number" ||
          (typeof raw.price === "string" && /^\d+(?:\.\d+)?$/.test(raw.price.trim())))
          ? Number(raw.price)
          : null;
      const model =
        directPanel && (typeof raw?.equip_type === "string" || typeof raw?.equip_type === "number")
          ? globals.CBG_GAME_CONFIG?.equip_info?.[String(raw.equip_type)]
          : undefined;
      if (model && model.name !== raw?.equip_name)
        throw new Error("主商品模型目录名称与当前商品不一致");
      const body = (root || document.body).cloneNode(true) as HTMLElement;
      body
        .querySelectorAll(
          excluded + ", #equip_price_addon_info, script, style, nav, header, footer",
        )
        .forEach((el) => el.remove());
      return {
        name,
        tooltip: tooltip?.innerText?.trim() || "",
        description: directPanel
          ? panel!.innerText.trim()
          : main!.getAttribute("data_equip_desc") || main!.getAttribute("data-equip-desc") || "",
        typeDescription: directPanel
          ? typeof model?.desc === "string"
            ? model.desc
            : ""
          : main?.getAttribute("data_equip_type_desc") ||
            main?.getAttribute("data-equip-type-desc") ||
            "",
        prices,
        rawPrice,
        body: body.textContent || "",
        selling: raw?.is_selling,
        productName: raw?.equip_name,
        productId: raw?.eid,
        serverId: raw?.serverid ?? raw?.server_id,
      };
    },
    { directPanel, excluded },
  );
  const productId =
    typeof observed.productId === "string" || typeof observed.productId === "number"
      ? String(observed.productId)
      : "";
  const serverId =
    typeof observed.serverId === "string" || typeof observed.serverId === "number"
      ? String(observed.serverId)
      : "";
  if (
    !observed.name ||
    !productId ||
    !serverId ||
    observed.productName !== observed.name ||
    equipmentIdentity(page.url()) !== serverId + ":" + productId
  )
    throw new Error("无法把主商品属性绑定到当前商品ID，报价未采用");
  const rawAttributes = parseEquipmentAttributes(observed.description);
  const tipAttributes = parseEquipmentAttributes(observed.tooltip);
  const size = (attributes: typeof rawAttributes) =>
    Object.values(attributes.fields).reduce((total, values) => total + values.length, 0);
  if (rawAttributes.level && tipAttributes.level && rawAttributes.level !== tipAttributes.level)
    throw new Error("主商品数据与提示框等级不一致");
  const description = cleanDescription(
    tipAttributes.level && size(tipAttributes) >= size(rawAttributes)
      ? observed.tooltip
      : observed.description,
  );
  if (!parseEquipmentAttributes(description).level) throw new Error("主商品装备属性尚未读取完整");
  const visiblePrices = [
    ...new Set(
      observed.prices.flatMap((value) => {
        const match = value.replace(/,/g, "").match(/(?:[¥￥]\s*)?(\d+(?:\.\d{1,2})?)/);
        return match ? [Number(match[1])] : [];
      }),
    ),
  ];
  const price = visiblePrices.length === 1 ? visiblePrices[0] : null;
  if (price === null || !Number.isFinite(price) || price <= 0)
    throw new Error("无法确认主商品人民币挂牌价");
  if (
    (directPanel && observed.rawPrice === null) ||
    (observed.rawPrice !== null && observed.rawPrice !== price)
  )
    throw new Error("主商品数据价格与可见价格不一致");
  const status = observed.body.match(
    /(?:是否上架|状态)\s*[：:]?\s*(已上架|上架中|未上架|已下架|已售出)/,
  )?.[1];
  const offShelf =
    status === "未上架" ||
    status === "已下架" ||
    status === "已售出" ||
    observed.selling === false ||
    observed.selling === 0 ||
    /商品已下架|商品已售出|商品不存在/.test(observed.body);
  const selling =
    !offShelf &&
    (status === "已上架" ||
      status === "上架中" ||
      observed.selling === true ||
      observed.selling === 1);
  if (
    !selling &&
    observed.selling !== false &&
    observed.selling !== 0 &&
    !/商品已下架|商品已售出|商品不存在/.test(observed.body)
  )
    throw new Error("无法确认独立装备当前在售状态");
  const restrictions = cleanDescription(observed.typeDescription)
    .split(/\n/)
    .filter((line) => /装备角色|装备对象|装备条件/.test(line) && !description.includes(line));
  const text = [
    observed.name,
    description,
    ...restrictions,
    selling ? "在售" : "商品已下架",
    "挂牌价：¥" + price,
  ].join("\n");
  const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return { text, price, html: "<main><pre>" + escape(text) + "</pre></main>" };
}

/** Separate work pages share the existing login; they never navigate the role list. */
export function equipmentSourceFromPages(
  searchPage: Page,
  detailPage: Page,
  signal: AbortSignal,
): EquipmentSource & { close(): Promise<void> } {
  const cache = new Map<string, string>();
  const deadline = Date.now() + 240_000;
  let closing: Promise<void> | undefined;
  const close = () => {
    if (!closing) {
      signal.removeEventListener("abort", abort);
      closing = Promise.allSettled([searchPage.close(), detailPage.close()]).then(() => {});
    }
    return closing;
  };
  const abort = () => {
    void close();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) void close();
  const readSource = async (url: string, requestSignal: AbortSignal) => {
    requestSignal = AbortSignal.any([signal, requestSignal]);
    requestSignal.throwIfAborted();
    const safe = safeEquipmentUrl(url);
    if (cache.has(safe)) return cache.get(safe)!;
    await pace(requestSignal, 600, 400);
    await detailPage.goto(safe, { waitUntil: "domcontentloaded", timeout: 15000 });
    requestSignal.throwIfAborted();
    if (equipmentIdentity(detailPage.url()) !== equipmentIdentity(safe))
      throw new Error("装备详情跳转到另一商品，报价未采用");
    const value = await equipmentPageSource(detailPage, requestSignal);
    cache.set(safe, value.html);
    return value.html;
  };
  return {
    close,
    readSource,
    async findCandidates(items, requestSignal) {
      requestSignal = AbortSignal.any([signal, requestSignal]);
      const queries: string[] = [],
        records: unknown[] = [];
      const results: Awaited<ReturnType<EquipmentSource["findCandidates"]>>["items"] = [];
      for (const item of items) {
        requestSignal.throwIfAborted();
        if (Date.now() >= deadline) {
          results.push({
            key: item.key,
            candidates: [],
            note: "达到本件商品查价时间上限，未完成所有装备查询",
          });
          continue;
        }
        const jewelry = isJewelry(item);
        await searchPage.goto(jewelry ? JEWELRY_SEARCH_URL : EQUIPMENT_SEARCH_URL, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });
        requestSignal.throwIfAborted();
        await assertAvailable(searchPage);
        if (!buildPageState(await readStableSnapshot(searchPage)).isLoggedIn)
          throw new Error("藏宝阁登录已失效，请在采集页扫码登录后继续装备查价");
        await searchPage.waitForFunction(
          (jewelry) => {
            const globals = window as unknown as {
              overall_search?: unknown;
              ajax_with_recommend?: unknown;
              EquipKinds?: unknown[];
              Kinds?: unknown[];
            };
            return (
              typeof globals.overall_search === "function" &&
              typeof globals.ajax_with_recommend === "function" &&
              !!(jewelry ? globals.Kinds : globals.EquipKinds)?.length
            );
          },
          jewelry,
          { timeout: 15000 },
        );
        const config = await searchPage.evaluate(() => {
          const g = window as unknown as {
            EquipKinds?: Choices;
            Kinds?: Choices;
            SpecialEffects?: Choices;
            SpecialSkills?: Choices;
            Gems?: Choices;
          };
          return {
            kinds: g.EquipKinds || g.Kinds || [],
            effects: g.SpecialEffects || [],
            skills: g.SpecialSkills || [],
            gems: g.Gems || [],
          };
        });
        const { args } = equipmentQuery(item, config);
        const act = jewelry ? "overall_search_lingshi" : "overall_search_equip";
        const query = "全服 / 综合排序 / " + item.name + " / " + JSON.stringify(args);
        queries.push(query);
        item.query = query;
        const candidates: EquipmentCandidate[] = [],
          rejected: EquipmentCandidate[] = [];
        const seen = new Set<string>();
        let count = 0,
          details = 0,
          lastPage = 0,
          exhausted = false;
        await searchPage.evaluate(() => {
          const g = window as unknown as Record<string, any>;
          const original = g.ajax_with_recommend;
          if (typeof original !== "function") throw new Error("官网装备查询组件发生变化");
          g.ajax_with_recommend = function (options: Record<string, any>, ...rest: unknown[]) {
            const success = options.onSuccess,
              failure = options.onFailure;
            return original.call(
              this,
              {
                ...options,
                onSuccess(result: Record<string, any>) {
                  g.__cbgEquipmentResult = {
                    page: Number(options.data?.page),
                    ok: result.status === 0 && Array.isArray(result.msg),
                    count: Array.isArray(result.msg) ? result.msg.length : -1,
                    error: typeof result.msg === "string" ? result.msg.slice(0, 200) : "",
                  };
                  success?.(result);
                },
                onFailure(...values: unknown[]) {
                  failure?.(...values);
                  g.__cbgEquipmentResult = {
                    page: Number(options.data?.page),
                    ok: false,
                    error: "官网查询请求失败",
                  };
                },
              },
              ...rest,
            );
          };
        });
        for (
          let pageNumber = 1;
          pageNumber <= MAX_PAGES &&
          count < MAX_ROWS &&
          details < MAX_DETAILS &&
          candidates.length < 3 &&
          Date.now() < deadline;
          pageNumber++
        ) {
          await pace(requestSignal);
          await searchPage.evaluate(
            ({ args, pageNumber, act }) => {
              const g = window as unknown as Record<string, any>;
              if (g.OverallSearchAct !== act || typeof g.overall_search !== "function")
                throw new Error("装备查询类别与预期不符");
              g.__cbgEquipmentResult = null;
              g.CurSearchValue.arg = args;
              g.CurSearchValue.order_by = { key: "", sort: "DESC" };
              // Use the page's actual search component; do not save query history or copy credentials.
              g.overall_search(args, pageNumber, g.CurSearchValue.order_by);
            },
            { args, pageNumber, act },
          );
          await searchPage.waitForFunction(
            (wanted) => {
              const globals = window as unknown as Record<string, any>;
              if (
                globals.CaptchaCheck?.need_captcha ||
                globals.IsLogin === 0 ||
                globals.LoginInfo?.login === 0 ||
                /show_login\.py/.test(location.pathname) ||
                Array.from(
                  document.querySelectorAll(".yidun_popup, .geetest_panel, #captcha_container"),
                ).some((el) => el.checkVisibility()) ||
                /系统繁忙|访问过于频繁|请求过于频繁/.test(document.body.innerText)
              )
                return true;
              const result = globals.__cbgEquipmentResult;
              const loading = document.querySelector("#loading_img");
              return result?.page === wanted && (!loading || !loading.checkVisibility());
            },
            pageNumber,
            { timeout: 20000, polling: 200 },
          );
          requestSignal.throwIfAborted();
          await assertAvailable(searchPage);
          const listing = await searchPage.evaluate((currentPage) => {
            const canonicalEquipmentUrl = (href: string) => {
              const url = new URL(href, location.href);
              const identityFields = new Set([
                "s",
                "serverid",
                "server_id",
                "eid",
                "equip_id",
                "ordersn",
              ]);
              const canonical = new URL(url.origin + url.pathname);
              for (const key of identityFields) {
                const value = url.searchParams.get(key);
                if (value !== null) canonical.searchParams.set(key, value);
              }
              return canonical.href;
            };
            const result = (window as unknown as Record<string, any>).__cbgEquipmentResult;
            if (!result?.ok) throw new Error(result?.error || "官网装备查询未成功");
            const root = document.querySelector<HTMLElement>("#search_result");
            if (!root?.checkVisibility()) throw new Error("装备列表尚未加载");
            const rows = Array.from(root.querySelectorAll<HTMLAnchorElement>("a.soldImg[href]"))
              .filter((a) => a.checkVisibility())
              .map((a) => ({
                url: canonicalEquipmentUrl(a.href),
                name: a.querySelector("img")?.getAttribute("data_equip_name") || "",
              }));
            const empty = result.count === 0 && /没有符合|没有找到|暂无/.test(root.innerText);
            if (!rows.length && !empty) throw new Error("装备列表为空但未确认没有匹配商品");
            const hasNext = Array.from(
              document.querySelectorAll<HTMLAnchorElement>("#pager a[href]"),
            ).some(
              (a) =>
                a.checkVisibility() &&
                Number(a.getAttribute("href")?.match(/^javascript:goto\((\d+)\)/)?.[1]) ===
                  currentPage + 1,
            );
            return { rows, empty, hasNext };
          }, pageNumber);
          lastPage = pageNumber;
          if (listing.empty) {
            exhausted = true;
            break;
          }
          let added = 0,
            pageFullyRead = true;
          for (const [rowIndex, row] of listing.rows.entries()) {
            requestSignal.throwIfAborted();
            const identity = equipmentIdentity(safeEquipmentUrl(row.url));
            if (seen.has(identity)) continue;
            seen.add(identity);
            added++;
            count++;
            if (row.name !== item.name) {
              if (count >= MAX_ROWS) {
                pageFullyRead = rowIndex === listing.rows.length - 1;
                break;
              }
              continue;
            }
            if (details >= MAX_DETAILS || Date.now() >= deadline) {
              pageFullyRead = false;
              break;
            }
            details++;
            let candidate: EquipmentCandidate = {
              url: row.url,
              title: row.name,
              price: null,
              priceType: "unknown",
              quote: "",
              verified: false,
              reason: "",
              fetchedAt: null,
              sourceHash: null,
            };
            try {
              const html = await readSource(row.url, requestSignal);
              const text = html
                .replace(/<[^>]+>/g, "")
                .replace(/&amp;/g, "&")
                .replace(/&lt;/g, "<")
                .replace(/&gt;/g, ">");
              const price = text.match(/挂牌价：¥(\d+(?:\.\d+)?)/)?.[1];
              candidate = {
                ...candidate,
                price: price ? Number(price) : null,
                priceType: "listing",
                quote: text,
              };
              candidate = verifyEquipmentCandidate(item, candidate, html, new Date().toISOString());
              if (candidate.verified) candidates.push(candidate);
              else rejected.push(candidate);
            } catch (error) {
              requestSignal.throwIfAborted();
              if (error instanceof Error && /登录|安全验证|频繁|网站繁忙/.test(error.message))
                throw error;
              rejected.push({
                ...candidate,
                reason: error instanceof Error ? error.message : "无法读取装备详情",
              });
            }
            if (count >= MAX_ROWS || candidates.length >= 3) {
              pageFullyRead = rowIndex === listing.rows.length - 1;
              break;
            }
          }
          if (!added) break;
          if (!listing.hasNext) {
            exhausted = pageFullyRead;
            break;
          }
        }
        const note =
          `已查询${lastPage}页、${count}个列表候选、${details}个详情；` +
          (exhausted ? "本次筛选结果已读完" : "有限样本查询，未遍历全部在售商品") +
          "。";
        records.push({
          key: item.key,
          act,
          args,
          pages: lastPage,
          rows: count,
          details,
          exhausted,
        });
        results.push({
          key: item.key,
          query,
          candidates: [...candidates, ...rejected].slice(0, 5),
          note,
        });
      }
      return { queries, items: results, searchItems: records };
    },
  };
}

export async function createEquipmentSource(signal: AbortSignal) {
  signal.throwIfAborted();
  const db = crawlDatabase(),
    owner = "equipment-" + randomUUID();
  const acquire = () =>
    db
      .prepare(
        "INSERT INTO crawl_lock VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE crawl_lock.expires_at < ? OR crawl_lock.owner=?",
      )
      .run(owner, Date.now() + 120000, Date.now(), owner).changes === 1;
  if (!acquire()) throw new Error("角色采集正在使用浏览器，请先暂停采集再查装备价格");
  const lease = new AbortController();
  const combined = AbortSignal.any([signal, lease.signal]);
  const timer = setInterval(() => {
    try {
      if (!acquire()) lease.abort(new Error("装备查询锁已失效，请重试"));
    } catch (error) {
      lease.abort(error);
    }
  }, 30000);
  let searchPage: Page | undefined, detailPage: Page | undefined;
  const release = () => {
    clearInterval(timer);
    db.prepare("DELETE FROM crawl_lock WHERE owner=?").run(owner);
  };
  try {
    const browser = await getBrowser();
    combined.throwIfAborted();
    searchPage = await createHiddenPage(browser);
    combined.throwIfAborted();
    detailPage = await createHiddenPage(browser);
    combined.throwIfAborted();
    const source = equipmentSourceFromPages(searchPage, detailPage, combined);
    return {
      ...source,
      close: async () => {
        try {
          await source.close();
        } finally {
          release();
        }
      },
    };
  } catch (error) {
    await Promise.allSettled([searchPage?.close(), detailPage?.close()]);
    release();
    throw error;
  }
}
