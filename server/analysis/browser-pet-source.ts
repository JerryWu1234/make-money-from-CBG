import type { Page } from "playwright-core";
import { createHiddenPage, getBrowser } from "../session";
import { assertAvailable, pace } from "../crawler/page";
import { buildPageState } from "../page-state";
import { readStableSnapshot } from "../workflow";
import { cleanDescription } from "../crawler/compact";
import {
  equipmentIdentity,
  safeEquipmentUrl,
  pageText,
  type EquipmentCandidate,
} from "./equipment-pricing";
import {
  petEquipmentDescription,
  verifyPetCandidate,
  type PetEquipment,
  type PetMatchType,
  type PetPricingItem,
  type PetSource,
} from "./pet-pricing";

export const PET_SEARCH_URL =
  "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=show_overall_search_pet";
type Choices = [string | number, string][];
export type PetSearchConfig = {
  names: Record<string, string>;
  skills: Choices;
  highNeidans: Choices;
  lowNeidans: Choices;
  officialTypeIds?: string[];
};
const MAX_PAGES = 3,
  MAX_ROWS = 60,
  MAX_DETAILS = 20;

/** These are the public OverallPetSearcher parameters, without server or price constraints. */
export type PetQueryMode = PetMatchType | "diagnostic";
export function petQuery(
  item: PetPricingItem,
  config: PetSearchConfig,
  matchType: PetQueryMode = "exact",
) {
  const ids = Object.entries(config.names)
    .filter(([, name]) => name === item.name)
    .map(([id]) => id);
  if (!ids.length) {
    if (config.officialTypeIds?.length)
      throw new Error(
        `官网类型目录确认“${item.name}”（${config.officialTypeIds.join(",")}），但没有独立可交易筛选定义；特殊类型保留未定价，不替换为其他宝宝`,
      );
    throw new Error("官网召唤兽类型目录未识别“" + item.name + "”，未发起宽泛查询");
  }
  const args: Record<string, string | number> = { type: ids.join(",") };
  if (item.level !== null && item.level >= 0 && item.level <= 180)
    args.level_min = args.level_max = item.level;
  const fields = new Map(item.fields.map((field) => [field.name, field.value]));
  if (matchType === "diagnostic") {
    if (["是否宝宝", "宝宝"].some((name) => /^(?:是|1)$/.test(fields.get(name) || "")))
      args.is_baobao = 1;
    return args;
  }
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
    if (base !== undefined && Number(base) <= 10000) {
      const tolerance =
        matchType === "similar" && name.endsWith("资质") ? (name === "速度资质" ? 0.1 : 0.05) : 0;
      args[parameter] = Math.ceil(Number(base) * (1 - tolerance));
    }
  }
  if (args.speed_aptitude_min !== undefined) {
    const speed = Number(fields.get("速度资质")?.match(/^([0-9]+)/)?.[1]);
    args.speed_aptitude_max =
      matchType === "similar" ? Math.min(10000, Math.floor(speed * 1.1)) : args.speed_aptitude_min;
  }
  const growth = fields.get("成长");
  if (growth && /^\d\.\d{1,3}$/.test(growth)) args.growth = Math.round(Number(growth) * 1000);
  if (["是否宝宝", "宝宝"].some((name) => /^(?:是|1)$/.test(fields.get(name) || "")))
    args.is_baobao = 1;
  const mappedSkills = item.skills.map((name) => {
    const observed = item.skillObservations?.find((skill) => skill.rawName === name);
    if (observed && observed.state !== "current") return [];
    const matches = config.skills.filter(([, label]) => label === name);
    if (observed?.id)
      return matches.filter(([id]) => String(id) === observed.id).map(([id]) => String(id));
    return matches.length === 1 ? [String(matches[0][0])] : [];
  });
  const skills = mappedSkills.flat();
  if (skills.length) args.skill = [...new Set(skills)].join(",");
  // Partial names, future/conditional skills and ambiguous IDs cannot establish a current count.
  if (
    item.skills.length &&
    mappedSkills.every((ids) => ids.length === 1) &&
    new Set(skills).size === item.skills.length
  )
    args.skill_num = item.skills.length;
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
  equipment: PetEquipment[];
  expectedEquipment: PetEquipment[];
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
  const gearKey = (gear: PetEquipment) =>
    (gear.accessory ? "饰品" : "装备") + gear.name + petEquipmentDescription(gear);
  if (
    observed.equipment.some((gear) => !gear.name || !petEquipmentDescription(gear)) ||
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
          (gear.accessory ? '" data_equip_location="RolePetShipin' : "") +
          '" data_equip_desc="' +
          escape(cleanDescription(gear.description)) +
          '">',
      )
      .join("") +
    "</main>";
  return { text, price, html };
}

export async function petPageSource(page: Page, signal: AbortSignal) {
  try {
    return await readMainPet(page, signal);
  } catch (error) {
    signal.throwIfAborted();
    const diagnostics = await page
      .evaluate(() => {
        const excluded =
          '#search_result, #bottomRecommands, #recommd_list, #recommend, .recommend, .recommd, .recommandWrp, .goodsRemmds, [id$="TipsBox"], [role="tooltip"]';
        const describe = (selector: string) =>
          Array.from(document.querySelectorAll<HTMLElement>(selector))
            .filter((node) => !node.closest(excluded))
            .slice(0, 3)
            .map((node) => {
              const ancestors = [];
              for (
                let parent = node.parentElement, count = 0;
                parent && count < 3;
                parent = parent.parentElement, count++
              )
                ancestors.push({
                  tag: parent.tagName,
                  id: parent.id.slice(0, 80),
                  className: String(parent.className).slice(0, 120),
                });
              return { visible: node.checkVisibility(), ancestors };
            });
        return {
          panels: describe("#equip_desc_panel"),
          info: describe("#info_panel"),
          jsonInputs: Array.from(document.querySelectorAll("#equip_desc_value")).filter(
            (node) => !node.closest(excluded),
          ).length,
          mainPrices: Array.from(document.querySelectorAll<HTMLElement>("#info_panel .price"))
            .filter(
              (node) =>
                node.checkVisibility() &&
                !node.closest(excluded) &&
                !node.closest("#equip_price_addon_info"),
            )
            .slice(0, 3)
            .map((node) => node.innerText.slice(0, 80)),
        };
      })
      .catch(() => null);
    const failure =
      error instanceof Error && error.name !== "TimeoutError"
        ? error
        : new Error("主宝宝属性、商品信息或价格区域未加载完成");
    throw Object.assign(failure, { petDiagnostics: diagnostics });
  }
}

/** Resolve a unique public attribute region, without depending on one template's panel ID. */
export function petRegionReady(excluded: string) {
  const visible = (node: Element) =>
    node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
    !node.closest(excluded);
  document
    .querySelectorAll("[data-cbg-pet-main-panel]")
    .forEach((node) => node.removeAttribute("data-cbg-pet-main-panel"));
  const infos = Array.from(document.querySelectorAll<HTMLElement>("#info_panel")).filter(visible);
  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement>("#equip_desc_value"),
  ).filter((node) => !node.closest(excluded));
  const g = window as unknown as Record<string, any>;
  if (
    !(g.equip || g.EquipInfo) ||
    infos.length !== 1 ||
    inputs.length !== 1 ||
    !inputs[0].value.trim()
  )
    return false;
  const panels = Array.from(document.querySelectorAll<HTMLElement>("#equip_desc_panel")).filter(
    visible,
  );
  if (panels.length > 1) return false;
  let panel = panels[0];
  if (!panel) {
    const hasStats = (node: HTMLElement) => {
      const text = node.innerText.replace(/\s/g, "");
      return (
        ["成长", "攻击资质", "防御资质", "体力资质", "法力资质", "速度资质"].every((name) =>
          text.includes(name),
        ) && /躲[闪避]资质/.test(text)
      );
    };
    let region = infos[0].parentElement;
    while (region && region !== document.body && region !== document.documentElement) {
      const tables = Array.from(region.querySelectorAll<HTMLElement>("table, dl")).filter(
        (node) => visible(node) && hasStats(node),
      );
      const leaves = tables.filter(
        (node) => !tables.some((other) => other !== node && node.contains(other)),
      );
      if (leaves.length > 1) return false;
      if (leaves.length === 1) {
        let candidate: HTMLElement | null = leaves[0];
        while (candidate && candidate !== region && !candidate.contains(infos[0])) {
          const text = candidate.innerText.replace(/\s/g, "");
          if (
            text.length <= 20_000 &&
            /技能/.test(text) &&
            /内丹/.test(text) &&
            /装备/.test(text)
          ) {
            panel = candidate;
            break;
          }
          candidate = candidate.parentElement;
        }
        break;
      }
      region = region.parentElement;
    }
  }
  if (
    !panel ||
    !visible(panel) ||
    !panel.innerText.trim() ||
    /加载中|正在加载/.test(panel.innerText) ||
    !infos[0].innerText.trim()
  )
    return false;
  const priceReady = Array.from(
    infos[0].querySelectorAll<HTMLElement>(".price, [data_price], [data-price]"),
  ).some(
    (node) =>
      visible(node) &&
      !node.closest("#equip_price_addon_info") &&
      (node.innerText.trim() || node.getAttribute("data_price") || node.getAttribute("data-price")),
  );
  if (priceReady) panel.setAttribute("data-cbg-pet-main-panel", "true");
  return priceReady;
}

async function readMainPet(page: Page, signal: AbortSignal) {
  signal.throwIfAborted();
  await assertAvailable(page);
  const excluded =
    '#search_result, #bottomRecommands, #recommd_list, #recommend, .recommend, .recommd, .recommandWrp, .goodsRemmds, [id$="TipsBox"], [role="tooltip"]';
  await page.waitForFunction(petRegionReady, excluded, { timeout: 5000 });
  signal.throwIfAborted();
  await assertAvailable(page);
  const observed = await page.evaluate((excluded) => {
    const g = window as unknown as Record<string, any>;
    const raw = g.equip || g.EquipInfo;
    const visible = (node: Element) =>
      node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      !node.closest(excluded);
    const panels = Array.from(
      document.querySelectorAll<HTMLElement>("[data-cbg-pet-main-panel]"),
    ).filter(visible);
    const infos = Array.from(document.querySelectorAll<HTMLElement>("#info_panel")).filter(visible);
    const panel = panels.length === 1 ? panels[0] : null;
    const info = infos.length === 1 ? infos[0] : null;
    let root = panel?.parentElement;
    while (root && root !== document.body && info && !root.contains(info))
      root = root.parentElement;
    if (
      !raw ||
      !panel ||
      !info ||
      !root ||
      !visible(panel) ||
      !visible(info) ||
      root === document.body ||
      root === document.documentElement ||
      !root.contains(info) ||
      root.closest(excluded)
    )
      throw new Error("官网独立宝宝主商品区域未识别，未采用推荐内容");
    if (/加载中|正在加载|展开全部(?:技能|装备|内丹)/.test(panel.innerText))
      throw new Error("宝宝详情尚未展开完整");
    const inputs = Array.from(
      document.querySelectorAll<HTMLInputElement>("#equip_desc_value"),
    ).filter((node) => !node.closest(excluded));
    const input = inputs.length === 1 ? inputs[0] : null;
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
      .map(({ attrs, src }) => ({
        name: attrs.data_equip_name || "",
        description: attrs.data_equip_desc || "",
        accessory: /\/images\/pet_shipin\//.test(src),
      }));
    const expectedEquipment = pet.equip_list
      .filter(Boolean)
      .map((gear: Record<string, unknown>) => ({
        name: typeof gear.name === "string" ? gear.name : "",
        description: typeof gear.desc === "string" ? gear.desc : "",
        accessory: typeof gear.icon === "string" && /\/images\/pet_shipin\//.test(gear.icon),
      }));
    const certification = String(pet.sp_skill_id ?? pet.sp_skill ?? "0");
    if (certification !== "0") {
      const name = g.CBG_GAME_CONFIG?.pet_skill_desc?.[certification]?.name;
      if (!name) throw new Error("认证技能未完整识别");
      if (!fields.some((field) => field.name === "认证技能")) add("认证技能", name);
    }
    // Status text comes only from the two bound principal regions, not their broader wrapper.
    const body = [info, panel]
      .map((region) => {
        const copy = region.cloneNode(true) as HTMLElement;
        copy
          .querySelectorAll(
            excluded + ", #equip_price_addon_info, script, style, nav, header, footer",
          )
          .forEach((node) => node.remove());
        return copy.textContent || "";
      })
      .join("\n");
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
      body,
      fields,
      parsedFields,
      skills,
      expectedSkills,
      innerSkills,
      expectedInner,
      equipment,
      expectedEquipment,
    };
  }, excluded);
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
            searchState: "unsupported",
            note: "目标宝宝含赐福字段，独立模板暂无法完整核对，保留未定价",
          });
          continue;
        }
        if (Date.now() >= deadline) {
          results.push({
            key: item.key,
            candidates: [],
            searchState: "pending",
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
        const config = await searchPage.evaluate((name) => {
          const g = window as unknown as Record<string, any>;
          return {
            names: g.SaleablePetNameInfo || {},
            skills: g.PetSkills || [],
            highNeidans: g.HighNeidans || [],
            lowNeidans: g.LowNeidans || [],
            officialTypeIds: Object.entries(g.CBG_GAME_CONFIG?.pet_info || {})
              .filter(([, value]) => value === name)
              .map(([id]) => id),
          };
        }, item.name);
        let args: ReturnType<typeof petQuery>;
        try {
          args = petQuery(item, config);
        } catch (error) {
          results.push({
            key: item.key,
            candidates: [],
            searchState: "unsupported",
            note: error instanceof Error ? error.message : "官网宝宝类型未识别",
          });
          continue;
        }
        const act = "overall_search_pet";
        let query = "";
        const notes: string[] = [];
        const candidates: EquipmentCandidate[] = [],
          rejected: EquipmentCandidate[] = [],
          diagnosticSources: EquipmentCandidate[] = [];
        let similarAttempted = false;
        let failedDetails = 0;
        const allSeen = new Set<string>();
        let count = 0,
          details = 0;
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
        for (const matchType of ["exact", "similar", "diagnostic"] as const) {
          if (
            matchType === "similar" &&
            candidates.some((candidate) => candidate.matchType !== "similar")
          )
            break;
          if (matchType === "diagnostic" && count > 0) break;
          args = petQuery(item, config, matchType);
          query =
            "全服 / 综合排序 / " + item.name + " / " + matchType + " / " + JSON.stringify(args);
          const seen = new Set<string>();
          const detailFailures: { url: string; reason: string; diagnostics: unknown }[] = [];
          let rows = 0,
            readDetails = 0,
            lastPage = 0,
            exhausted = false;
          const acceptedCount = () =>
            matchType === "diagnostic"
              ? diagnosticSources.length
              : candidates.filter((candidate) =>
                  matchType === "exact"
                    ? candidate.matchType !== "similar"
                    : candidate.matchType === "similar",
                ).length;
          const sampleLimit = matchType === "similar" ? 5 : 3;
          for (
            let pageNumber = 1;
            pageNumber <= MAX_PAGES &&
            count < MAX_ROWS &&
            acceptedCount() < sampleLimit &&
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
            if (pageNumber === 1) {
              queries.push(query);
              item.query = query;
              if (matchType === "similar") similarAttempted = true;
            }
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
              rows++;
              if (!allSeen.has(identity)) {
                allSeen.add(identity);
                count++;
              }
              if (row.type && !String(args.type).split(",").includes(row.type)) {
                if (count >= MAX_ROWS) {
                  pageFullyRead = rowIndex === listing.rows.length - 1;
                  break;
                }
                continue;
              }
              const sourceCached = cache.has(safeEquipmentUrl(row.url));
              if ((!sourceCached && details >= MAX_DETAILS) || Date.now() >= deadline) {
                pageFullyRead = false;
                break;
              }
              if (!sourceCached) {
                details++;
                readDetails++;
              }
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
                matchType: matchType === "exact" ? "exact" : "similar",
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
                candidate = verifyPetCandidate(
                  item,
                  candidate,
                  html,
                  new Date().toISOString(),
                  matchType === "exact" ? "exact" : "similar",
                );
                if (matchType === "diagnostic")
                  diagnosticSources.push({
                    ...candidate,
                    verified: false,
                    reason: "仅用于真实独立详情诊断，不计价：" + candidate.reason,
                  });
                else if (candidate.verified) candidates.push(candidate);
                else rejected.push(candidate);
              } catch (error) {
                requestSignal.throwIfAborted();
                if (error instanceof Error && /登录|安全验证|频繁|网站繁忙/.test(error.message))
                  throw error;
                (matchType === "diagnostic" ? diagnosticSources : rejected).push({
                  ...candidate,
                  reason: error instanceof Error ? error.message : "无法读取宝宝详情",
                });
                detailFailures.push({
                  url: row.url,
                  reason:
                    error instanceof Error ? error.message.split("\n")[0] : "无法读取宝宝详情",
                  diagnostics:
                    error && typeof error === "object" && "petDiagnostics" in error
                      ? error.petDiagnostics
                      : null,
                });
                failedDetails++;
              }
              if (count >= MAX_ROWS || acceptedCount() >= sampleLimit) {
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
            `${matchType === "exact" ? "严格" : matchType === "similar" ? "相似" : "诊断"}筛选已查询${lastPage}页、${rows}个列表候选、${readDetails}个新详情；` +
            (exhausted ? "本次筛选结果已读完" : "有限样本查询，未遍历全部在售商品") +
            "。";
          notes.push(note);
          records.push({
            key: item.key,
            act,
            matchType,
            args,
            pages: lastPage,
            rows,
            details: readDetails,
            exhausted,
            detailFailures,
          });
        }
        const distinct = new Map<string, EquipmentCandidate>();
        for (const candidate of [...candidates, ...rejected]) {
          const identity = equipmentIdentity(candidate.url);
          if (!distinct.has(identity)) distinct.set(identity, candidate);
        }
        results.push({
          key: item.key,
          query: item.query,
          searchState:
            candidates.some((candidate) => candidate.matchType !== "similar") ||
            candidates.length >= 3
              ? "completed"
              : failedDetails
                ? "read_failed"
                : Date.now() >= deadline
                  ? "pending"
                  : "completed",
          candidates: [...distinct.values()].slice(0, 10),
          similarAttempted,
          diagnosticSources,
          note: notes.join(" "),
        });
      }
      return { queries, items: results, searchItems: records };
    },
  };
}

export async function createPetSource(signal: AbortSignal) {
  signal.throwIfAborted();
  let searchPage: Page | undefined, detailPage: Page | undefined;
  try {
    const browser = await getBrowser();
    signal.throwIfAborted();
    searchPage = await createHiddenPage(browser);
    signal.throwIfAborted();
    detailPage = await createHiddenPage(browser);
    signal.throwIfAborted();
    return petSourceFromPages(searchPage, detailPage, signal);
  } catch (error) {
    await Promise.allSettled([searchPage?.close(), detailPage?.close()]);
    throw error;
  }
}
