import { randomUUID } from "node:crypto";
import type { Page } from "playwright-core";
import { createHiddenPage, getBrowser } from "../session";
import { crawlDatabase } from "../crawler/controller";
import { assertAvailable, pace } from "../crawler/page";
import { buildPageState } from "../page-state";
import { readStableSnapshot } from "../workflow";
import { cleanDescription, coreEquipmentDescription } from "../crawler/compact";
import {
  equipmentIdentity,
  safeEquipmentUrl,
  pageText,
  type EquipmentCandidate,
} from "./equipment-pricing";
import { verifyPetCandidate, type PetPricingItem, type PetSource } from "./pet-pricing";

export const PET_SEARCH_URL =
  "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=show_overall_search_pet";
type Choices = [string | number, string][];
export type PetSearchConfig = {
  names: Record<string, string>;
  skills: Choices;
  highNeidans: Choices;
  lowNeidans: Choices;
};
const MAX_PAGES = 3,
  MAX_ROWS = 60,
  MAX_DETAILS = 20;

/** These are the public OverallPetSearcher parameters, without server or price constraints. */
export function petQuery(item: PetPricingItem, config: PetSearchConfig) {
  const ids = Object.entries(config.names)
    .filter(([, name]) => name === item.name)
    .map(([id]) => id);
  if (!ids.length) throw new Error("官网召唤兽类型目录未识别“" + item.name + "”，未发起宽泛查询");
  const args: Record<string, string | number> = { type: ids.join(",") };
  if (item.level !== null && item.level >= 0 && item.level <= 180)
    args.level_min = args.level_max = item.level;
  const fields = new Map(item.fields.map((field) => [field.name, field.value]));
  for (const [name, parameter] of [
    ["攻击资质", "attack_aptitude"],
    ["防御资质", "defence_aptitude"],
    ["体力资质", "physical_aptitude"],
    ["法力资质", "magic_aptitude"],
    ["速度资质", "speed_aptitude_min"],
    ["灵性", "lingxing"],
  ]) {
    const value = fields.get(name);
    const base = value?.match(/^([0-9]+)(?:\s*\+\s*[0-9]+)?$/)?.[1];
    if (base !== undefined && Number(base) <= 10000) args[parameter] = Number(base);
  }
  if (args.speed_aptitude_min !== undefined) args.speed_aptitude_max = args.speed_aptitude_min;
  const growth = fields.get("成长");
  if (growth && /^\d\.\d{1,3}$/.test(growth)) args.growth = Math.round(Number(growth) * 1000);
  if (["是否宝宝", "宝宝"].some((name) => /^(?:是|1)$/.test(fields.get(name) || "")))
    args.is_baobao = 1;
  const skills = item.skills.flatMap((name) =>
    config.skills.filter(([, label]) => label === name).map(([id]) => String(id)),
  );
  if (skills.length) args.skill = [...new Set(skills)].join(",");
  if (item.skills.length) args.skill_num = item.skills.length;
  for (const [key, choices] of [
    ["high_neidan", config.highNeidans],
    ["low_neidan", config.lowNeidans],
  ] as const) {
    const matched = item.innerSkills.flatMap((skill) =>
      choices.filter(([, name]) => name === skill.name).map(([id]) => String(id)),
    );
    if (matched.length) args[key] = matched.join(",");
  }
  return args;
}

type PetObservation = {
  productId: unknown;
  serverId: unknown;
  productName: unknown;
  visibleName: string;
  storageType: unknown;
  petStorageType: unknown;
  rawPrice: unknown;
  prices: string[];
  selling: unknown;
  body: string;
  fields: { name: string; value: string }[];
  parsedFields: { name: string; value: string }[];
  skills: string[];
  expectedSkills: string[];
  innerSkills: { name: string; level: string }[];
  expectedInner: { name: string; level: string }[];
  equipment: { name: string; description: string }[];
  expectedEquipment: { name: string; description: string }[];
};
const normalized = (value: string) => value.replace(/[\s：:，,（）()【】]/g, "").toLowerCase();
const canonical = (value: string) =>
  /^\d+(?:\.\d+)?$/.test(value.trim()) ? String(Number(value)) : normalized(value);
const same = (a: string[], b: string[]) =>
  JSON.stringify(a.map(normalized).sort()) === JSON.stringify(b.map(normalized).sort());

/** Validate the visible principal product against its own official JSON, never the target pet. */
export function petObservationSource(observed: PetObservation, url: string) {
  const scalar = (value: unknown) =>
    typeof value === "string" || typeof value === "number" ? String(value) : "";
  if (
    !scalar(observed.productId) ||
    !scalar(observed.serverId) ||
    !observed.visibleName ||
    observed.visibleName !== observed.productName ||
    equipmentIdentity(url) !== scalar(observed.serverId) + ":" + scalar(observed.productId) ||
    !scalar(observed.petStorageType) ||
    scalar(observed.storageType) !== scalar(observed.petStorageType)
  )
    throw new Error("无法把独立宝宝属性绑定到当前商品ID，报价未采用");
  const fields = new Map<string, string>();
  for (const field of observed.fields) {
    const old = fields.get(field.name);
    if (old !== undefined && canonical(old) !== canonical(field.value))
      throw new Error("主宝宝属性重复且不一致：" + field.name);
    fields.set(field.name, field.value);
  }
  for (const field of observed.parsedFields) {
    const visible = fields.get(field.name);
    if (visible !== undefined && canonical(visible) !== canonical(field.value))
      throw new Error("主宝宝数据与可见属性不一致：" + field.name);
    // Only the official type directory supplies the otherwise absent type label.
    if (field.name === "类型" && visible === undefined) fields.set(field.name, field.value);
    else if (visible === undefined) throw new Error("主宝宝关键属性未显示：" + field.name);
  }
  if (!same(observed.skills, observed.expectedSkills))
    throw new Error("主宝宝完整技能未显示或与商品数据不一致");
  const innerKey = (skill: { name: string; level: string }) => skill.name + skill.level + "层";
  if (
    observed.innerSkills.some((skill) => !skill.name || !/^[1-5]$/.test(skill.level)) ||
    !same(observed.innerSkills.map(innerKey), observed.expectedInner.map(innerKey))
  )
    throw new Error("主宝宝内丹名称、层数或完整列表未核对");
  const gearKey = (gear: { name: string; description: string }) =>
    gear.name + coreEquipmentDescription(gear.description);
  if (
    observed.equipment.some((gear) => !gear.name || !coreEquipmentDescription(gear.description)) ||
    !same(observed.equipment.map(gearKey), observed.expectedEquipment.map(gearKey))
  )
    throw new Error("主宝宝随身装备未完整显示或与商品数据不一致");
  const prices = [
    ...new Set(
      observed.prices.flatMap((value) => {
        const match = value.replace(/,/g, "").match(/(?:[¥￥]\s*)?(\d+(?:\.\d{1,2})?)/);
        return match ? [Number(match[1])] : [];
      }),
    ),
  ];
  const price = prices.length === 1 ? prices[0] : null;
  if (
    price === null ||
    price <= 0 ||
    !Number.isFinite(price) ||
    !/^(?:\d+(?:\.\d+)?)$/.test(scalar(observed.rawPrice).trim()) ||
    Number(observed.rawPrice) !== price
  )
    throw new Error("主宝宝数据价格与可见人民币挂牌价不明确或不一致");
  const off =
    /商品已下架|商品已售出|商品不存在|(?:状态|是否上架)\s*[：:]?\s*(?:已下架|未上架|已售出)/.test(
      observed.body,
    ) ||
    observed.selling === 0 ||
    observed.selling === false;
  const on =
    !off &&
    (observed.selling === 1 ||
      observed.selling === true ||
      /(?:状态|是否上架)\s*[：:]?\s*(?:已上架|上架中)/.test(observed.body));
  if (!on && !off) throw new Error("无法确认独立宝宝当前在售状态");
  const escape = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const text = [
    "召唤兽",
    ...[...fields].map(([name, value]) => name + "：" + value),
    "技能：" + (observed.skills.join("、") || "无"),
    "内丹：" +
      (observed.innerSkills.map((skill) => skill.name + "(" + skill.level + "层)").join("、") ||
        "无"),
    "宝宝装备：" + (observed.equipment.length ? "" : "无"),
    on ? "在售" : "商品已下架",
    "挂牌价：¥" + price,
  ].join("\n");
  const html =
    "<main><pre>" +
    escape(text) +
    "</pre>" +
    observed.equipment
      .map(
        (gear) =>
          '<img data_equip_name="' +
          escape(gear.name) +
          '" data_equip_desc="' +
          escape(cleanDescription(gear.description)) +
          '">',
      )
      .join("") +
    "</main>";
  return { text, price, html };
}

export async function petPageSource(page: Page, signal: AbortSignal) {
  signal.throwIfAborted();
  await assertAvailable(page);
  const observed = await page.evaluate(() => {
    const g = window as unknown as Record<string, any>;
    const raw = g.equip || g.EquipInfo;
    const panel = document.querySelector<HTMLElement>("#equip_desc_panel");
    const info = document.querySelector<HTMLElement>("#info_panel");
    const root = panel?.closest<HTMLElement>(".infoList.goodsInfo");
    const excluded =
      '#search_result, #bottomRecommands, #recommd_list, #recommend, .recommend, .recommd, .recommandWrp, .goodsRemmds, [id$="TipsBox"], [role="tooltip"]';
    const visible = (node: Element) =>
      node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      !node.closest(excluded);
    if (
      !raw ||
      !panel ||
      !info ||
      !root ||
      !visible(panel) ||
      !visible(info) ||
      info.closest(".infoList.goodsInfo") !== root
    )
      throw new Error("官网独立宝宝主商品区域未识别，未采用推荐内容");
    if (/加载中|正在加载|展开全部(?:技能|装备|内丹)/.test(panel.innerText))
      throw new Error("宝宝详情尚未展开完整");
    const input = document.querySelector<HTMLInputElement>("#equip_desc_value");
    let pet: Record<string, any>;
    try {
      pet = JSON.parse(input?.value || "");
    } catch {
      throw new Error("官网主宝宝JSON详情未识别");
    }
    const hasValues = (value: unknown) =>
      Array.isArray(value)
        ? value.length > 0
        : value && typeof value === "object"
          ? Object.keys(value).length > 0
          : typeof value === "string"
            ? value.trim() !== "" && value.trim() !== "0"
            : !!value;
    if (
      [pet?.evol_skill_list, pet?.evol_skills, pet?.other?.EvolSkill, pet?.other?.evol_skills].some(
        hasValues,
      )
    )
      throw new Error("主宝宝含赐福配置，独立模板可见信息尚未核对，报价未采用");
    if (
      !pet ||
      !Array.isArray(pet.all_skills) ||
      !Array.isArray(pet.neidan) ||
      !Array.isArray(pet.equip_list)
    )
      throw new Error("官网主宝宝完整技能、内丹或装备列表未确认");
    const fieldName = (name: string) =>
      name
        .trim()
        .replace(/\s/g, "")
        .replace(/[：:]$/, "")
        .replace(/^成长率$/, "成长")
        .replace(/^躲避资质$/, "躲闪资质");
    const fields: { name: string; value: string }[] = [];
    const add = (name: string, value: string) => {
      name = fieldName(name);
      value = value.trim();
      if (name && value) fields.push({ name, value });
    };
    for (const label of panel.querySelectorAll<HTMLElement>("th, td, dt")) {
      const value = label.nextElementSibling;
      if (
        value instanceof HTMLElement &&
        visible(label) &&
        visible(value) &&
        /^(?:TD|DD)$/.test(value.tagName) &&
        (label.tagName === "TH" || label.tagName === "DT" || /[：:]\s*$/.test(label.innerText))
      )
        add(label.innerText, value.innerText);
    }
    const fieldText = panel.innerText.split(
      /(?:^|\n)\s*(?:赐福技能|技能|内丹|(?:召唤兽|宝宝)?装备)\s*(?:[（(:：]|\n|$)/,
    )[0];
    for (const match of fieldText
      .replace(/[ \t]+(?=[^\s：:\n]{1,20}[：:])/g, "\n")
      .matchAll(/(?:^|[\n\t；])([^：:\n\t；]{1,30})[：:]\s*([^\n\t；]+)/g))
      add(match[1], match[2]);
    const headingLevel = panel.innerText.match(/(?:^|\s)等级\s*[：:]\s*(\d{1,3})(?:\s|$)/)?.[1];
    if (headingLevel && !fields.some((field) => field.name === "等级")) add("等级", headingLevel);
    const type = g.CBG_GAME_CONFIG?.pet_info?.[String(pet.type_id)];
    if (typeof type !== "string" || !type) throw new Error("官网主宝宝类型目录未识别");
    const parsedFields = [
      { name: "类型", value: type },
      ...[
        ["等级", "pet_grade"],
        ["成长", "growth"],
        ["攻击资质", "attack_aptitude"],
        ["防御资质", "defence_aptitude"],
        ["体力资质", "physical_aptitude"],
        ["法力资质", "magic_aptitude"],
        ["速度资质", "speed_aptitude"],
        ["躲闪资质", "avoid_aptitude"],
      ].map(([name, key]) => {
        const bonus = name.endsWith("资质") ? pet[key.replace("_aptitude", "_ext")] : undefined;
        return { name, value: String(pet[key] ?? "") + (bonus ? " +" + String(bonus) : "") };
      }),
    ];
    if (parsedFields.some((field) => !field.value)) throw new Error("官网主宝宝关键数据缺失");
    const icons = Array.from(panel.querySelectorAll<HTMLImageElement>("img"))
      .filter(visible)
      .map((icon) => {
        const attrs: Record<string, string> = {};
        let node: Element | null = icon;
        for (let depth = 0; depth < 3 && node && node !== panel; depth++, node = node.parentElement)
          for (const attr of node.attributes)
            if (attr.name.startsWith("data"))
              attrs[attr.name.replace(/^data-/, "data_")] ||= attr.value;
        return { attrs, src: icon.getAttribute("src") || "" };
      });
    const skills = icons
      .filter(
        ({ attrs, src }) =>
          attrs.data_skill_type === "cifu" ||
          (!attrs.data_skill_type &&
            /\/skill\//.test(src) &&
            !!(attrs.data_equip_name || attrs.data_store_name)),
      )
      .map(({ attrs }) => attrs.data_equip_name || attrs.data_store_name || "");
    const expectedSkills = pet.all_skills.map(
      (id: unknown) => g.CBG_GAME_CONFIG?.pet_skill_desc?.[String(id)]?.name || "",
    );
    if (skills.some((name) => !name) || expectedSkills.some((name: string) => !name))
      throw new Error("官网主宝宝技能名称未完整识别");
    const innerSkills = icons
      .filter(({ attrs }) => attrs.data_skill_type === "neidan")
      .map(({ attrs }) => ({
        name: attrs.data_equip_name || attrs.data_store_name || "",
        level: attrs.data_equip_level || "",
      }));
    const expectedInner = pet.neidan.map((skill: Record<string, unknown>) => ({
      name: typeof skill.name === "string" ? skill.name : "",
      level:
        typeof skill.level === "number" || typeof skill.level === "string"
          ? String(skill.level)
          : "",
    }));
    const equipment = icons
      .filter(({ attrs, src }) => !attrs.data_skill_type && /\/(?:equip|pet_shipin)\//.test(src))
      .map(({ attrs }) => ({
        name: attrs.data_equip_name || "",
        description: attrs.data_equip_desc || "",
      }));
    const expectedEquipment = pet.equip_list
      .filter(Boolean)
      .map((gear: Record<string, unknown>) => ({
        name: typeof gear.name === "string" ? gear.name : "",
        description: typeof gear.desc === "string" ? gear.desc : "",
      }));
    const certification = String(pet.sp_skill_id ?? pet.sp_skill ?? "0");
    if (certification !== "0") {
      const name = g.CBG_GAME_CONFIG?.pet_skill_desc?.[certification]?.name;
      if (!name) throw new Error("认证技能未完整识别");
      if (!fields.some((field) => field.name === "认证技能")) add("认证技能", name);
    }
    const body = root.cloneNode(true) as HTMLElement;
    body
      .querySelectorAll(excluded + ", #equip_price_addon_info, script, style")
      .forEach((node) => node.remove());
    return {
      productId: raw.eid,
      serverId: raw.serverid ?? raw.server_id,
      productName: raw.equip_name,
      visibleName:
        info.innerText
          .match(/(?:^|\s)ID\s*[：:]\s*(.+?)(?=\s+等级\s*[：:]|\r?\n|$)/i)?.[1]
          ?.trim() || "",
      storageType: raw.storage_type,
      petStorageType: g.StorageStype?.pet,
      rawPrice: raw.price,
      prices: Array.from(info.querySelectorAll<HTMLElement>("[data_price], [data-price], .price"))
        .filter((node) => visible(node) && !node.closest("#equip_price_addon_info"))
        .map(
          (node) =>
            node.getAttribute("data_price") || node.getAttribute("data-price") || node.innerText,
        ),
      selling: raw.is_selling,
      body: body.textContent || "",
      fields,
      parsedFields,
      skills,
      expectedSkills,
      innerSkills,
      expectedInner,
      equipment,
      expectedEquipment,
    };
  });
  signal.throwIfAborted();
  return petObservationSource(observed, page.url());
}

/** Separate work pages share the existing login; they never navigate the role list. */
export function petSourceFromPages(
  searchPage: Page,
  detailPage: Page,
  signal: AbortSignal,
): PetSource & { close(): Promise<void> } {
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
    if (closing) throw new Error("宝宝查询页面已关闭");
    const safe = safeEquipmentUrl(url);
    if (cache.has(safe)) return cache.get(safe)!;
    await pace(requestSignal, 600, 400);
    await detailPage.goto(safe, { waitUntil: "domcontentloaded", timeout: 15000 });
    requestSignal.throwIfAborted();
    if (equipmentIdentity(detailPage.url()) !== equipmentIdentity(safe))
      throw new Error("宝宝详情跳转到另一商品，报价未采用");
    const value = await petPageSource(detailPage, requestSignal);
    cache.set(safe, value.html);
    return value.html;
  };
  return {
    close,
    readSource,
    async findCandidates(items, requestSignal) {
      requestSignal = AbortSignal.any([signal, requestSignal]);
      requestSignal.throwIfAborted();
      if (closing) throw new Error("宝宝查询页面已关闭");
      const queries: string[] = [],
        records: unknown[] = [];
      const results: Awaited<ReturnType<PetSource["findCandidates"]>>["items"] = [];
      for (const item of items) {
        requestSignal.throwIfAborted();
        if (item.fields.some((field) => /赐福/.test(field.name))) {
          results.push({
            key: item.key,
            candidates: [],
            note: "目标宝宝含赐福字段，独立模板暂无法完整核对，保留未定价",
          });
          continue;
        }
        if (Date.now() >= deadline) {
          results.push({
            key: item.key,
            candidates: [],
            note: "达到本件商品查价时间上限，未完成所有宝宝查询",
          });
          continue;
        }
        await searchPage.goto(PET_SEARCH_URL, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });
        requestSignal.throwIfAborted();
        await assertAvailable(searchPage);
        if (!buildPageState(await readStableSnapshot(searchPage)).isLoggedIn)
          throw new Error("藏宝阁登录已失效，请在采集页扫码登录后继续宝宝查价");
        await searchPage.waitForFunction(
          () => {
            const g = window as unknown as Record<string, any>;
            return (
              typeof g.overall_search === "function" &&
              typeof g.ajax_with_recommend === "function" &&
              g.SaleablePetNameInfo &&
              g.PetSkills?.length
            );
          },
          undefined,
          { timeout: 15000 },
        );
        const config = await searchPage.evaluate(() => {
          const g = window as unknown as Record<string, any>;
          return {
            names: g.SaleablePetNameInfo || {},
            skills: g.PetSkills || [],
            highNeidans: g.HighNeidans || [],
            lowNeidans: g.LowNeidans || [],
          };
        });
        let args: ReturnType<typeof petQuery>;
        try {
          args = petQuery(item, config);
        } catch (error) {
          results.push({
            key: item.key,
            candidates: [],
            note: error instanceof Error ? error.message : "官网宝宝类型未识别",
          });
          continue;
        }
        const act = "overall_search_pet";
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
          if (typeof original !== "function") throw new Error("官网宝宝查询组件发生变化");
          g.ajax_with_recommend = function (options: Record<string, any>, ...rest: unknown[]) {
            const success = options.onSuccess,
              failure = options.onFailure;
            return original.call(
              this,
              {
                ...options,
                onSuccess(result: Record<string, any>) {
                  g.__cbgPetResult = {
                    page: Number(options.data?.page),
                    ok: result.status === 0 && Array.isArray(result.msg),
                    count: Array.isArray(result.msg) ? result.msg.length : -1,
                    error: typeof result.msg === "string" ? result.msg.slice(0, 200) : "",
                  };
                  success?.(result);
                },
                onFailure(...values: unknown[]) {
                  failure?.(...values);
                  g.__cbgPetResult = {
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
                throw new Error("宝宝查询类别与预期不符");
              g.__cbgPetResult = null;
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
              const result = globals.__cbgPetResult;
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
            const result = (window as unknown as Record<string, any>).__cbgPetResult;
            if (!result?.ok) throw new Error(result?.error || "官网宝宝查询未成功");
            const root = document.querySelector<HTMLElement>("#search_result");
            if (!root?.checkVisibility()) throw new Error("宝宝列表尚未加载");
            const rows = Array.from(root.querySelectorAll<HTMLAnchorElement>("a.soldImg[href]"))
              .filter((a) => a.checkVisibility())
              .map((a) => ({
                url: canonicalEquipmentUrl(a.href),
                name: a.querySelector("img")?.getAttribute("data_equip_name") || "",
                type: a.querySelector("img")?.getAttribute("data_equip_type") || "",
              }));
            const empty = result.count === 0 && /没有符合|没有找到|暂无/.test(root.innerText);
            if (!rows.length && !empty) throw new Error("宝宝列表为空但未确认没有匹配商品");
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
            if (row.type && !String(args.type).split(",").includes(row.type)) {
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
              const text = pageText(html);
              const price = text.match(/挂牌价：¥(\d+(?:\.\d+)?)/)?.[1];
              candidate = {
                ...candidate,
                price: price ? Number(price) : null,
                priceType: "listing",
                quote: text,
              };
              candidate = verifyPetCandidate(item, candidate, html, new Date().toISOString());
              if (candidate.verified) candidates.push(candidate);
              else rejected.push(candidate);
            } catch (error) {
              requestSignal.throwIfAborted();
              if (error instanceof Error && /登录|安全验证|频繁|网站繁忙/.test(error.message))
                throw error;
              rejected.push({
                ...candidate,
                reason: error instanceof Error ? error.message : "无法读取宝宝详情",
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

export async function createPetSource(signal: AbortSignal) {
  signal.throwIfAborted();
  const db = crawlDatabase(),
    owner = "pet-" + randomUUID();
  const acquire = () =>
    db
      .prepare(
        "INSERT INTO crawl_lock VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE crawl_lock.expires_at < ? OR crawl_lock.owner=?",
      )
      .run(owner, Date.now() + 120000, Date.now(), owner).changes === 1;
  if (!acquire()) throw new Error("角色采集正在使用浏览器，请先暂停采集再查宝宝价格");
  const lease = new AbortController();
  const combined = AbortSignal.any([signal, lease.signal]);
  const timer = setInterval(() => {
    try {
      if (!acquire()) lease.abort(new Error("宝宝查询锁已失效，请重试"));
    } catch (error) {
      lease.abort(error);
    }
  }, 30000);
  let searchPage: Page | undefined, detailPage: Page | undefined;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
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
    const source = petSourceFromPages(searchPage, detailPage, combined);
    let cleanup: Promise<void> | undefined;
    const close = () => {
      cleanup ||= source.close().finally(() => {
        combined.removeEventListener("abort", abort);
        release();
      });
      return cleanup;
    };
    const abort = () => {
      void close();
    };
    combined.addEventListener("abort", abort, { once: true });
    if (combined.aborted) void close();
    return { ...source, close };
  } catch (error) {
    await Promise.allSettled([searchPage?.close(), detailPage?.close()]);
    release();
    throw error;
  }
}
