import type { Page } from "playwright-core";
import { createHiddenPage, getBrowser } from "../session";
import { pace } from "../crawler/page";
import { assertAvailable } from "../crawler/page";
import { createHash } from "node:crypto";
import {
  EQUIPMENT_QUOTE_LIMIT,
  EQUIPMENT_QUOTE_POLICY,
  PRICING_RESUME_POLICY,
} from "./pricing-integrity";
import { resetPricingCursor } from "./pricing-progress";
import { readPetSearchForm } from "./browser-pet-source";
import {
  assertEquipmentUIArguments,
  equipmentCursorMatches,
  equipmentPageSource,
  moveObservedLevelSlider,
  selectObservedMenu,
} from "./browser-equipment-source";
import { createMarketScopeAudit, type GlobalMarketRequest } from "./market-scope";
import {
  equipmentIdentity,
  pageText,
  safeEquipmentUrl,
  type EquipmentCandidate,
  type EquipmentSearchCursor,
} from "./equipment-pricing";
import {
  comparePetGear,
  parsePetGearAttributes,
  petGearReference,
  selectPetGearCandidates,
  type PetGearPricingItem,
} from "./pet-gear-inventory";

/** Observed official navigation entry, rather than a guessed search action. */
export const PET_GEAR_SEARCH_URL =
  "https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py?act=show_pet_equip_search_form";
const PET_GEAR_SEARCH_ACTION = "overall_search_pet_equip";
const MAX_PAGES = 3,
  MAX_DETAILS = 24;

const baseInputs: Record<string, string> = {
  速度: "speed",
  防御: "fangyu",
  魔法: "mofa",
  伤害: "shanghai",
  气血: "hp",
  命中率: "hit_ratio",
};
const addonValues: Record<string, string> = {
  魔力: "addon_fali",
  力量: "addon_liliang",
  灵力: "addon_lingli",
  敏捷: "addon_minjie",
  耐力: "addon_naili",
  体质: "addon_tizhi",
};

export function petGearUIQuery(item: PetGearPricingItem, similar = false) {
  const attributes = parsePetGearAttributes(item.description);
  if (item.accessory || attributes.issues.length || attributes.restricted)
    throw new Error(
      "宝宝装备不能查询：" + (attributes.issues.join("；") || "饰品、绑定或专用装备"),
    );
  const inputs: Record<string, string> = {};
  const addons: string[] = [];
  let addonSum = 0;
  for (const [stat, number] of Object.entries(attributes.stats)) {
    if (baseInputs[stat] && number > 0)
      inputs[baseInputs[stat]] = String(Math.max(1, Math.ceil(number * (similar ? 0.8 : 1))));
    if (addonValues[stat]) {
      if (stat === "敏捷" && number < 0)
        inputs.addon_minjie_reduce = String(
          Math.max(1, Math.ceil(Math.abs(number) * (similar ? 0.8 : 1))),
        );
      else addons.push(addonValues[stat]);
      addonSum += number;
    }
  }
  if (addonSum > 0)
    inputs.addon_sum_min = String(Math.max(1, Math.ceil(addonSum * (similar ? 0.8 : 1))));
  if (attributes.stone)
    inputs.xiang_qian_level = String(Math.max(0, attributes.stone.level - (similar ? 1 : 0)));
  if (attributes.suit) {
    if (!attributes.suit.startsWith("附加状态"))
      throw new Error("未支持的宝宝装备套装筛选：" + attributes.suit);
    const addonStatus = attributes.suit.slice("附加状态".length).trim();
    if (!addonStatus) throw new Error("宝宝装备附加状态名称缺失");
    inputs.addon_status = addonStatus;
  }
  if (attributes.repairFailed !== null)
    inputs.repair_failed_times = String(attributes.repairFailed);
  return {
    level: attributes.level!,
    inputs,
    addons,
    stone: attributes.stone?.stat || null,
    similar,
  };
}

export type PetGearSearchResult = {
  queries: string[];
  items: {
    key: string;
    candidates: EquipmentCandidate[];
    query?: string;
    note?: string;
    searchStatus: "completed" | "read_failed" | "pending";
    searchCursor?: EquipmentSearchCursor;
    skipped?: boolean;
    samplingStopped?: boolean;
    scopeEvidence: GlobalMarketRequest[];
  }[];
  searchItems: unknown[];
};

export function petGearSearchPlanHash(item: PetGearPricingItem) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: "official-pet-gear-first-page-empty-stop-v2",
        resumePolicy: PRICING_RESUME_POLICY,
        priceMethod: EQUIPMENT_QUOTE_POLICY,
        name: item.name,
        description: item.description,
        category: item.rawItem?.attributes?.装备类型 || item.rawItem?.attributes?.部位,
        modes: [petGearUIQuery(item), petGearUIQuery(item, true)],
      }),
    )
    .digest("hex");
}

export async function readPetGearSearchForm(page: Page) {
  await page.waitForFunction(
    () => {
      const g = window as Window & { CaptchaCheck?: { need_captcha?: boolean } };
      const visible = (selector: string) =>
        Array.from(document.querySelectorAll(selector)).some((el) => el.checkVisibility());
      return (
        !!document.querySelector("#server_type_panel li") ||
        g.CaptchaCheck?.need_captcha ||
        visible(
          "#qrcode,#loginContainer,input[type=password],.yidun_popup,.geetest_panel,#captcha_container",
        ) ||
        /\/(?:show_login|login)\.py$/.test(location.pathname) ||
        /系统繁忙|访问过于频繁|请求过于频繁/.test(document.body.innerText)
      );
    },
    undefined,
    { timeout: 15_000 },
  );
  const form = await readPetSearchForm(page, PET_GEAR_SEARCH_URL);
  const metadata = await page.evaluate(() => {
    const slider = document.querySelector<HTMLElement>(".levelSlider#level_slider");
    const text = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim();
    const component = (
      slider as HTMLElement & {
        slider?: { options?: { grid?: unknown; step?: unknown; range?: unknown } };
      }
    )?.slider;
    const options = component?.options;
    const forms = Array.from(document.querySelectorAll<HTMLFormElement>("form"))
      .filter((el) => /query|search/i.test(el.id + " " + el.name))
      .map((el) => {
        const action = new URL(el.action, location.href);
        return {
          id: el.id,
          name: el.name,
          action: action.origin === location.origin ? action.origin + action.pathname : "",
          method: el.method,
          act: el.querySelector<HTMLInputElement>('input[name="act"]')?.value || "",
        };
      });
    return {
      forms,
      sliders: slider
        ? [
            {
              id: slider.id,
              label: text(slider.closest("tr")?.querySelector("th")?.textContent),
              start: text(slider.querySelector(".startPoint .num")?.textContent),
              end: text(slider.querySelector(".endPoint .num")?.textContent),
              grid: typeof options?.grid === "number" ? options.grid : null,
              step: typeof options?.step === "number" ? options.step : null,
              range:
                Array.isArray(options?.range) &&
                options.range.length === 2 &&
                options.range.every((value: unknown) => typeof value === "number")
                  ? options.range
                  : null,
            },
          ]
        : [],
    };
  });
  return { ...form, ...metadata };
}

async function applyPetGearUI(page: Page, item: PetGearPricingItem, similar: boolean) {
  const query = petGearUIQuery(item, similar);
  const args: Record<string, string | number> = {
    level_min: query.level,
    level_max: query.level,
    server_type: "3",
    ...query.inputs,
  };
  for (const addon of query.addons) args[addon] = "1";
  const form = await readPetGearSearchForm(page);
  const actions: unknown[] = [];
  if (!form.buttons.some((button) => button.id === "reset_all" && button.visible))
    throw new Error("官网宝宝装备重置按钮不可用");
  await page.locator("#reset_all").click();
  actions.push({ control: "reset_all", method: "click" });
  const crossReset = page.locator("#btn_reset_user_server");
  if (await crossReset.isVisible()) {
    await crossReset.click();
    actions.push({ control: "btn_reset_user_server", method: "click" });
  }
  for (const control of form.controls) {
    if (!control.visible || !control.id) continue;
    const locator = page.locator("#" + control.id);
    if (["text", "number", "search"].includes(control.type)) await locator.fill("");
    else if (control.type === "checkbox" && (await locator.isEnabled())) await locator.uncheck();
    else if (
      control.type === "select" &&
      ["overall_sel_area", "ovarall_sel_server"].includes(control.id)
    ) {
      const neutral = control.options?.find((option) => option.value === "");
      if (!neutral) throw new Error("官网没有全服地区中性选项");
      await locator.selectOption(neutral.value);
    }
  }
  actions.push(await selectObservedMenu(page, "server_type_panel", "3"));
  actions.push(await moveObservedLevelSlider(page, "level_slider", query.level, query.level));
  for (const [id, value] of Object.entries(query.inputs)) {
    if (
      !form.controls.some(
        (control) => control.id === id && control.visible && control.type === "text",
      )
    )
      throw new Error("官网未提供宝宝装备筛选控件：" + id);
    await page.locator("#" + id).fill(value);
    await page.locator("#" + id).dispatchEvent("change");
    actions.push({ control: id, value, method: "fill" });
  }
  const addonMenu = form.menus.find((menu) => menu.id === "addon_skill_box");
  if (query.addons.some((value) => !addonMenu?.choices.some((choice) => choice.value === value)))
    throw new Error("官网宝宝装备附加属性目录未匹配");
  if (query.addons.length)
    actions.push(await selectObservedMenu(page, "addon_skill_box", query.addons.join(",")));
  if (query.stone) {
    const choices =
      form.menus
        .find((menu) => menu.id === "xiangqian_stone_attr_panel")
        ?.choices.filter((choice) => choice.label === query.stone) || [];
    if (choices.length !== 1) throw new Error("官网精魄灵石目录无法唯一匹配“" + query.stone + "”");
    args.xiangqian_stone_attr = choices[0].value;
    actions.push(await selectObservedMenu(page, "xiangqian_stone_attr_panel", choices[0].value));
  }
  // A stored exact slot label is usable; otherwise the official three-slot query stays broad.
  const category = item.rawItem?.attributes?.装备类型 || item.rawItem?.attributes?.部位;
  if (category) {
    const choices =
      form.menus
        .find((menu) => menu.id === "EquipPosBox")
        ?.choices.filter((choice) => choice.label === category) || [];
    if (choices.length === 1) {
      args.equip_pos = choices[0].value;
      actions.push(await selectObservedMenu(page, "EquipPosBox", choices[0].value));
    }
  }
  return { query, args, actions };
}

async function readPetGearRows(page: Page, pageNumber: number) {
  await page.waitForFunction(
    (pageNumber) => {
      const g = window as Window & { QueryArgs?: { page?: number } };
      const visible = (selector: string) =>
        Array.from(document.querySelectorAll(selector)).some((el) => el.checkVisibility());
      return (
        !visible("#loading_img") &&
        Number(g.QueryArgs?.page) === pageNumber &&
        (!!document.querySelector("#soldList a.soldImg[href]") ||
          /没有符合条件/.test(
            document.querySelector<HTMLElement>("#query_result")?.innerText || "",
          ))
      );
    },
    pageNumber,
    { timeout: 15_000 },
  );
  await assertAvailable(page);
  return page.evaluate(() => {
    const text = document.querySelector<HTMLElement>("#pager_bar")?.innerText || "";
    const totalPages = Number(text.match(/共\s*(\d+)\s*页/)?.[1] || 1);
    const rows = Array.from(
      document.querySelectorAll<HTMLAnchorElement>("#soldList a.soldImg[href]"),
    ).map((anchor) => ({
      url: anchor.href,
      name: anchor.querySelector("img")?.getAttribute("data_equip_name") || "",
      level: anchor.querySelector("img")?.getAttribute("data_equip_level") || "",
      server: anchor.querySelector("img")?.getAttribute("data_serverid") || "",
    }));
    return { totalPages, rows };
  });
}

export async function createPetGearSource(
  signal: AbortSignal,
  budgets: { maxPages?: number; maxDetails?: number } = {},
) {
  signal.throwIfAborted();
  let page: Page | undefined, detailPage: Page | undefined;
  let scopeAudit: ReturnType<typeof createMarketScopeAudit> | undefined;
  const close = async () => {
    signal.removeEventListener("abort", onAbort);
    scopeAudit?.close();
    await Promise.allSettled([
      page && !page.isClosed() ? page.close() : undefined,
      detailPage && !detailPage.isClosed() ? detailPage.close() : undefined,
    ]);
  };
  const onAbort = () => {
    void close();
  };
  try {
    const browser = await getBrowser(true);
    signal.throwIfAborted();
    page = await createHiddenPage(browser);
    signal.addEventListener("abort", onAbort, { once: true });
    signal.throwIfAborted();
    const searchPage = page;
    return {
      async discover() {
        signal.throwIfAborted();
        await searchPage.goto(PET_GEAR_SEARCH_URL, {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        await pace(signal);
        const form = await readPetGearSearchForm(searchPage);
        signal.throwIfAborted();
        return form;
      },
      async findCandidates(
        items: PetGearPricingItem[],
        requestSignal: AbortSignal,
      ): Promise<PetGearSearchResult> {
        const workSignal = AbortSignal.any([signal, requestSignal]);
        workSignal.throwIfAborted();
        const result: PetGearSearchResult = { queries: [], items: [], searchItems: [] };
        scopeAudit ||= createMarketScopeAudit(searchPage);
        const deadline = Date.now() + 120_000;
        let halted = "";
        for (const item of items) {
          workSignal.throwIfAborted();
          if (halted || Date.now() >= deadline) {
            halted ||= "本轮宝宝装备查询预算已结束";
            result.items.push({
              key: item.key,
              candidates: item.candidates,
              query: item.query,
              ...(item.searchCursor ? { searchCursor: item.searchCursor } : {}),
              skipped: true,
              note: "尚未查询；" + halted + "，下次分析继续",
              searchStatus: "pending",
              scopeEvidence: item.scopeEvidence || [],
            });
            continue;
          }
          const candidates = new Map<string, EquipmentCandidate>();
          const scopeEvidence: GlobalMarketRequest[] = [];
          const maxPages = budgets.maxPages ?? MAX_PAGES;
          const maxDetails = budgets.maxDetails ?? MAX_DETAILS;
          let next: EquipmentSearchCursor | undefined;
          let queryText = "",
            details = 0,
            pages = 0,
            failed = false,
            queried = false,
            refreshSkipped = false,
            orderChanged = false;
          let note = "";
          let seen = new Set<string>();
          let failedUrls = new Map<string, number>();
          const enoughSamples = () => {
            const values = [...candidates.values()];
            return (
              (values.filter((candidate) => candidate.verified && candidate.matchType === "exact")
                .length >= EQUIPMENT_QUOTE_LIMIT ||
                (!values.some(
                  (candidate) => candidate.verified && candidate.matchType === "exact",
                ) &&
                  values.filter(
                    (candidate) => candidate.verified && candidate.matchType === "similar",
                  ).length >= EQUIPMENT_QUOTE_LIMIT)) &&
              petGearReference(values).referencePrice !== null
            );
          };
          const budgetEnded = () =>
            details >= maxDetails || pages >= maxPages || Date.now() >= deadline;
          const saveCursor = () => {
            if (!next) return undefined;
            next.seen = [...seen];
            next.failed = [...failedUrls].map(([url, modeIndex]) => ({ url, modeIndex }));
            return next;
          };
          try {
            const planHash = petGearSearchPlanHash(item);
            const reusable = equipmentCursorMatches(item.searchCursor, planHash, 2);
            next = reusable
              ? structuredClone(item.searchCursor!)
              : {
                  version: 1,
                  planHash,
                  modeIndex: 0,
                  pageNumber: 1,
                  rowIndex: 0,
                  pageRowsHash: "",
                  seen: [],
                  failed: [],
                };
            seen = new Set(next.seen);
            failedUrls = new Map(
              next.failed.map(({ url, modeIndex }) => [safeEquipmentUrl(url), modeIndex]),
            );
            const attempted = new Set<string>();
            const readCandidate = async (rawUrl: string, modeIndex: number) => {
              const url = safeEquipmentUrl(rawUrl),
                identity = equipmentIdentity(url);
              attempted.add(identity);
              details++;
              try {
                detailPage ||= await createHiddenPage(browser);
                workSignal.throwIfAborted();
                await detailPage.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
                if (equipmentIdentity(detailPage.url()) !== identity)
                  throw new Error("宝宝装备详情跳转到另一商品，报价未采用");
                await pace(workSignal);
                const source = await equipmentPageSource(detailPage, workSignal, "pet-gear");
                workSignal.throwIfAborted();
                await assertAvailable(detailPage);
                const description = source.html.match(
                  /<pre data-cbg-equipment-description>([\s\S]*?)<\/pre>/,
                )?.[1];
                if (!description) throw new Error("主商品宝宝装备描述缺失，未采用报价");
                const name = source.text.split("\n")[0];
                const match = comparePetGear(item, name, pageText(description));
                const selling = /(?:^|\n)在售(?:\n|$)/.test(source.text);
                candidates.set(identity, {
                  url,
                  title: name,
                  price: source.price,
                  priceType: "listing",
                  quote: source.text,
                  verified: !!match.matchType && selling,
                  reason: !selling
                    ? "商品已下架，未采用报价"
                    : match.reason || "同级同模型、套装及镶嵌类型一致，基础/附加属性差异已核对",
                  ...(match.matchType
                    ? {
                        matchType: match.matchType,
                        differences: match.differences,
                        similarityScore: match.similarityScore,
                      }
                    : {}),
                  fetchedAt: new Date().toISOString(),
                  sourceHash: createHash("sha256").update(source.html).digest("hex"),
                });
                seen.add(identity);
                failedUrls.delete(url);
              } catch (error) {
                workSignal.throwIfAborted();
                failedUrls.set(url, modeIndex);
                throw error;
              }
            };
            // Only a bounded nearest cohort is refreshed; old quotations never inherit a fresh timestamp.
            if (reusable) {
              const refresh = selectPetGearCandidates(item.candidates);
              const refreshIds = new Set<string>();
              for (const candidate of refresh) {
                const identity = equipmentIdentity(safeEquipmentUrl(candidate.url));
                if (refreshIds.has(identity)) continue;
                if (details >= maxDetails || Date.now() >= deadline) break;
                refreshIds.add(identity);
                await readCandidate(candidate.url, next.modeIndex);
              }
              if (
                refreshIds.size <
                new Set(refresh.map((candidate) => equipmentIdentity(candidate.url))).size
              ) {
                refreshSkipped = true;
                throw new Error("保存的宝宝装备报价尚未全部重新核验，本轮预算已结束");
              }
            }
            for (const [url, modeIndex] of failedUrls) {
              if (attempted.has(equipmentIdentity(url))) continue;
              if (details >= maxDetails || Date.now() >= deadline) break;
              await readCandidate(url, modeIndex);
            }
            // Never reuse an old row offset when no quote has ever been adopted.
            // Freshly read the active first page while preserving completed conditions.
            if (
              reusable &&
              next.pageNumber === 1 &&
              !failedUrls.size &&
              !item.candidates.some((candidate) => candidate.verified) &&
              ![...candidates.values()].some((candidate) => candidate.verified)
            ) {
              next.rowIndex = 0;
              next.pageRowsHash = "";
              next.seen = [];
              seen.clear();
            }
            queryStages: for (let modeIndex = next.modeIndex; modeIndex < 2; modeIndex++) {
              if (budgetEnded() || failedUrls.size || (queried && enoughSamples())) break;
              const similar = modeIndex === 1;
              await searchPage.goto(PET_GEAR_SEARCH_URL, {
                waitUntil: "domcontentloaded",
                timeout: 45_000,
              });
              await pace(workSignal);
              const applied = await applyPetGearUI(searchPage, item, similar);
              queryText =
                "全服三年以上 / 宝宝装备 / " + item.name + " / " + JSON.stringify(applied.query);
              result.queries.push(queryText);
              const loadPage = async (pageNumber: number, first: boolean, replay = false) => {
                scopeAudit!.begin(PET_GEAR_SEARCH_ACTION, pageNumber);
                if (first) await searchPage.locator("#btn_do_query").click();
                else
                  await searchPage
                    .locator("#pager_bar")
                    .getByText("下一页", { exact: true })
                    .click();
                await pace(workSignal);
                const listing = await readPetGearRows(searchPage, pageNumber);
                const request = scopeAudit!.confirm();
                scopeEvidence.push(request);
                const submittedArgs = await searchPage.evaluate(() => {
                  const values = (window as unknown as { QueryArgs?: Record<string, unknown> })
                    .QueryArgs;
                  if (!values || typeof values !== "object")
                    throw new Error("官网宝宝装备表单未保存实际查询条件");
                  const filters: Record<string, string | number> = {};
                  for (const [key, value] of Object.entries(values)) {
                    if (["act", "page"].includes(key)) continue;
                    if (
                      /token|cookie|auth|password|nickname|urs|account|fingerprint|safe_code|session/i.test(
                        key,
                      ) ||
                      (typeof value !== "string" && typeof value !== "number")
                    )
                      throw new Error("宝宝装备查询条件含非公开字段，已停止");
                    filters[key] = value;
                  }
                  return filters;
                });
                result.searchItems.push({
                  key: item.key,
                  searchUrl: PET_GEAR_SEARCH_URL,
                  query: applied.query,
                  args: applied.args,
                  submittedArgs,
                  mode: similar ? "similar" : "exact",
                  page: pageNumber,
                  request,
                  actions: applied.actions,
                  rowCount: listing.rows.length,
                  candidateServers: [...new Set(listing.rows.map((row) => row.server))],
                  ...(replay ? { replay: true } : {}),
                });
                assertEquipmentUIArguments(applied.args, submittedArgs);
                queried = true;
                return listing;
              };
              // The site's observed next-page control recreates the saved page without hidden API calls.
              const targetPage = next.pageNumber;
              let listing = await loadPage(1, true, targetPage > 1);
              for (let uiPage = 2; uiPage <= targetPage; uiPage++) {
                if (Date.now() >= deadline) break;
                if (uiPage - 1 >= listing.totalPages)
                  throw new Error("宝宝装备筛选结果页数已变化，请重新核对查询位置");
                listing = await loadPage(uiPage, false, uiPage < targetPage);
              }
              if (Date.now() >= deadline) break;
              for (let pageNumber = targetPage; !budgetEnded(); pageNumber++) {
                workSignal.throwIfAborted();
                pages++;
                const rowsHash = createHash("sha256")
                  .update(JSON.stringify(listing.rows))
                  .digest("hex");
                if (next.pageRowsHash && next.pageRowsHash !== rowsHash) {
                  result.searchItems.push({
                    key: item.key,
                    reason: "result_order_changed",
                    previousCursor: structuredClone(next),
                    currentPageRowsHash: rowsHash,
                    discardedCandidates: [...candidates.values()],
                  });
                  resetPricingCursor(next);
                  candidates.clear();
                  seen.clear();
                  failedUrls.clear();
                  orderChanged = true;
                  break queryStages;
                }
                const startRow = next.pageRowsHash === rowsHash ? next.rowIndex : 0;
                next.pageNumber = pageNumber;
                next.pageRowsHash = rowsHash;
                next.rowIndex = startRow;
                let fullyRead = true;
                for (let rowIndex = startRow; rowIndex < listing.rows.length; rowIndex++) {
                  const row = listing.rows[rowIndex];
                  if (details >= maxDetails || Date.now() >= deadline || enoughSamples()) {
                    fullyRead = false;
                    break;
                  }
                  next.rowIndex = rowIndex + 1;
                  if (row.name !== item.name || Number(row.level) !== item.level) continue;
                  const url = safeEquipmentUrl(row.url),
                    identity = equipmentIdentity(url);
                  if (seen.has(identity)) continue;
                  await readCandidate(url, modeIndex);
                }
                if (!fullyRead || enoughSamples()) break;
                if (
                  pageNumber === 1 &&
                  fullyRead &&
                  !failedUrls.size &&
                  ![...candidates.values()].some((candidate) => candidate.verified) &&
                  listing.totalPages > 1
                ) {
                  next.emptyFirstPageModes = [
                    ...new Set([...(next.emptyFirstPageModes || []), modeIndex]),
                  ];
                  next.modeIndex = modeIndex + 1;
                  next.pageNumber = 1;
                  next.rowIndex = 0;
                  next.pageRowsHash = "";
                  break;
                }
                if (pageNumber >= listing.totalPages) {
                  next.modeIndex = [...candidates.values()].some((candidate) => candidate.verified)
                    ? 2
                    : modeIndex + 1;
                  next.pageNumber = 1;
                  next.rowIndex = 0;
                  next.pageRowsHash = "";
                  break;
                }
                next.pageNumber = pageNumber + 1;
                next.rowIndex = 0;
                next.pageRowsHash = "";
                if (budgetEnded()) break;
                listing = await loadPage(pageNumber + 1, false);
              }
              if (next.modeIndex >= 2 || next.modeIndex === modeIndex) break;
            }
          } catch (error) {
            workSignal.throwIfAborted();
            failed = !refreshSkipped;
            note = error instanceof Error ? error.message : String(error);
            if (
              /登录|安全验证|验证码|繁忙|降低频率|三年以上|单服|地区限制|实际市场查询|实际网络请求/.test(
                note,
              )
            )
              halted = note;
          }
          const samplingStopped =
            !!next?.emptyFirstPageModes?.length &&
            next.modeIndex >= 2 &&
            !failed &&
            !refreshSkipped &&
            !failedUrls.size &&
            !orderChanged &&
            ![...candidates.values()].some((candidate) => candidate.verified);
          const completed =
            !samplingStopped &&
            !failed &&
            !refreshSkipped &&
            !failedUrls.size &&
            !!next &&
            ((queried && enoughSamples()) || next.modeIndex >= 2);
          if (!failed)
            note = samplingStopped
              ? "严格与相近筛选第一页均未取得有效宝宝装备样本，按规则跳过；不继续翻页，不计价，市场售价未知。"
              : orderChanged
                ? "官网结果身份或顺序已变化，旧候选和已读位置已清除，将从第一阶段第一页重新取样。"
                : completed
                  ? enoughSamples()
                    ? "已核验官网结果顺序中的前5件有效宝宝装备挂牌样本，采用算术平均价；有限样本不代表遍历全部在售商品。"
                    : "本次筛选结果已读完，按实际有效样本数计算平均价；没有有效样本则保留未定价。"
                  : "本轮宝宝装备查询预算已用完，已保存筛选阶段、页码和行位置，下一轮继续补查。";
          if (Date.now() >= deadline) halted ||= note;
          const values = [...candidates.values()];
          result.items.push({
            key: item.key,
            candidates: refreshSkipped
              ? item.candidates
              : [
                  ...selectPetGearCandidates(values),
                  ...values.filter((candidate) => !candidate.verified).slice(0, 5),
                ],
            query: queryText,
            note,
            searchStatus:
              failed || failedUrls.size || (orderChanged && (next?.restartCount || 0) > 1)
                ? "read_failed"
                : completed
                  ? "completed"
                  : "pending",
            ...(!completed && next ? { searchCursor: saveCursor() } : {}),
            ...(refreshSkipped ? { skipped: true } : {}),
            ...(samplingStopped ? { samplingStopped: true } : {}),
            scopeEvidence: [...(item.scopeEvidence || []), ...scopeEvidence],
          });
        }
        return result;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
