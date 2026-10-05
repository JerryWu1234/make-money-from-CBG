import { createHash } from "node:crypto";
import type { DetailItem, PetSnapshot, SavedRoleRecord } from "../crawler/types";
import { coreEquipmentDescription, itemFromAttributes } from "../crawler/compact";
import { compareListingPrice } from "./valuation-calculator";
import type { ValuationResult } from "./valuation-types";
import {
  equipmentIdentity,
  listingPrices,
  pageText,
  productSource,
  safeEquipmentUrl,
  type EquipmentCandidate,
  type EquipmentPricingItem,
  type EquipmentPricingSnapshot,
} from "./equipment-pricing";

export type PetPricingItem = EquipmentPricingItem & {
  fields: PetSnapshot["fields"];
  skills: string[];
  innerSkills: { name: string; level: string }[];
  equipment: { name: string; description: string }[];
};
export type PetPricingSnapshot = Omit<EquipmentPricingSnapshot, "items"> & {
  items: PetPricingItem[];
};
export type PetSource = {
  findCandidates: (
    items: PetPricingItem[],
    signal: AbortSignal,
  ) => Promise<{
    queries: string[];
    items: Array<{ key: string; candidates: EquipmentCandidate[]; note?: string; query?: string }>;
    searchItems?: unknown[];
  }>;
  readSource: (url: string, signal: AbortSignal) => Promise<string>;
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const normalize = (value: string) => value.replace(/[\s：:，,（）()【】]/g, "").toLowerCase();
const fieldName = (value: string) =>
  value
    .trim()
    .replace(/^成长率$/, "成长")
    .replace(/^躲避资质$/, "躲闪资质");
const ignoredField =
  /^(?:名称|名字|昵称|经验|当前经验|升级经验|忠诚|忠诚度|寿命|剩余寿命|气血|当前气血|魔法|当前魔法)$/;
const mandatory = [
  "类型",
  "等级",
  "成长",
  "攻击资质",
  "防御资质",
  "体力资质",
  "法力资质",
  "速度资质",
  "躲闪资质",
];
const extraSensitive = [
  "携带等级",
  "参战等级",
  "宝宝",
  "是否宝宝",
  "变异",
  "是否变异",
  "进阶",
  "进阶状态",
  "进阶灵性",
  "灵性",
  "特性",
  "特性类型",
  "特性概率",
  "特性几率",
  "特性效果",
  "认证",
  "认证技能",
  "赐福",
  "超技能",
  "超级技能",
  "成品状态",
  "转生",
  "转生次数",
  "神兽类型",
];
const gearDescription = (item: DetailItem) =>
  coreEquipmentDescription(
    item.description ||
      item.tooltip ||
      Object.entries(item.attributes || {})
        .map(([key, value]) => key + "：" + value)
        .join("\n"),
  );

/** A complete capture can be empty; missing or partial capture is never an empty inventory. */
export function petInventory(record: SavedRoleRecord) {
  const tabs = record.detail?.tabs.filter((tab) => tab.name === "召唤兽/孩子") || [];
  const capture = record.detail?.petCapture;
  const issues = [...(capture?.issues || [])];
  if (!capture || capture.version !== 1)
    issues.push("需要重新补采召唤兽，旧详情不证明宝宝资料已采齐");
  if (tabs.length !== 1) issues.push("召唤兽页缺失或重复");
  const items: PetPricingItem[] = [];
  const keys = new Set<string>();
  for (const tab of tabs) {
    if (tab.petCount === undefined || !Array.isArray(tab.pets) || tab.petCount !== tab.pets.length)
      issues.push("召唤兽数量与已采详情不一致");
    for (const pet of tab.pets || []) {
      const key = tab.name + ":" + pet.index;
      if (keys.has(key)) issues.push("召唤兽序号重复，需核对实际只数");
      keys.add(key);
      const fields = pet.fields
        .filter((field) => !ignoredField.test(field.name.trim()))
        .map((field) => ({ name: fieldName(field.name), value: field.value.trim() }));
      const values = new Map(fields.map((field) => [field.name, field.value]));
      const itemIssues: string[] = [];
      for (const name of mandatory) if (!values.get(name)) itemIssues.push("缺少" + name);
      for (const name of mandatory.filter((name) => !["类型", "等级"].includes(name))) {
        const value = values.get(name);
        const numeric =
          name === "成长" ? /^\d+(?:\.\d+)?$/ : /^\d+(?:\.\d+)?(?:\s*\+\s*\d+(?:\.\d+)?)?$/;
        if (value && (!numeric.test(value) || Number(value.match(/^\d+(?:\.\d+)?/)?.[0]) <= 0))
          itemIssues.push(name + "不是完整有效数值");
      }
      if (new Set(fields.map((field) => field.name)).size !== fields.length)
        itemIssues.push("宝宝属性重复，需要核对");
      const levelText = values.get("等级") || "";
      const level = /^\d{1,3}$/.test(levelText) ? Number(levelText) : null;
      if (level === null) itemIssues.push("宝宝等级未识别");
      const skills = pet.skills.map((skill) => skill.name.trim()).sort();
      if (!skills.length && !capture?.complete) itemIssues.push("完整技能列表未采齐");
      if (
        skills.some((name) => !name || /^图标|^技能\s*\d+$/.test(name)) ||
        new Set(skills).size !== skills.length
      )
        itemIssues.push("技能名称缺失或重复");
      const innerSkills = pet.innerSkills.map((skill) => ({
        name: skill.name.trim(),
        level: skill.level?.trim() || "",
      }));
      if (innerSkills.some((skill) => !skill.name || !/^[1-5]$/.test(skill.level)))
        itemIssues.push("内丹名称或层数未采齐");
      const equipment = pet.equipment.map((item) => ({
        name: item.name.trim(),
        description: gearDescription(item),
      }));
      if (equipment.some((item) => !item.name || !item.description))
        itemIssues.push("宝宝装备属性未采齐");
      const name = values.get("类型") || pet.name;
      const description = [
        ...fields.map((field) => field.name + "：" + field.value),
        "技能：" + (skills.join("、") || "无"),
        "内丹：" +
          (innerSkills.map((skill) => skill.name + "(" + skill.level + "层)").join("、") || "无"),
        "宝宝装备：" +
          (equipment.map((item) => item.name + "\n" + item.description).join("\n") || "无"),
      ].join("\n");
      const bound = /不可交易|绑定|专用召唤兽/.test(description);
      items.push({
        key,
        name,
        level,
        category: "召唤兽（含已核对随身装备）",
        description,
        query: "梦幻西游电脑版 藏宝阁 全服 召唤兽 " + name + " " + description.replace(/\n/g, " "),
        status: bound ? "untradable" : itemIssues.length ? "incomplete" : "no_match",
        referencePrice: null,
        candidates: [],
        issues: bound ? [...itemIssues, "绑定或不可交易宝宝不能套用可交易价格"] : itemIssues,
        fields,
        skills,
        innerSkills,
        equipment,
      });
    }
  }
  const captureComplete = !!capture?.complete && !issues.length;
  const inputHash = hash(
    JSON.stringify({
      collectedAt: capture?.collectedAt,
      captureComplete,
      issues,
      items: items.map(({ key, name, fields, skills, innerSkills, equipment }) => ({
        key,
        name,
        fields,
        skills,
        innerSkills,
        equipment,
      })),
    }),
  );
  return { items, issues, captureComplete, inputHash };
}

const decodeAttribute = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
function sourceIcons(html: string) {
  const icons: DetailItem[] = [];
  const issues: string[] = [];
  const stack: { tag: string; attrs: Record<string, string> }[] = [];
  const source = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  const voidTags = new Set([
    "img",
    "br",
    "hr",
    "input",
    "meta",
    "area",
    "base",
    "col",
    "embed",
    "link",
    "param",
    "source",
    "track",
    "wbr",
  ]);
  for (const match of source.matchAll(/<\/?([a-z][\w:-]*)\b[^>]*>/gi)) {
    const tag = match[1].toLowerCase(),
      markup = match[0];
    if (markup.startsWith("</")) {
      let index = stack.length - 1;
      while (index >= 0 && stack[index].tag !== tag) index--;
      if (index >= 0) stack.length = index;
      continue;
    }
    const own = Object.fromEntries(
      [...markup.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/gs)].map(
        (attribute) => [
          attribute[1].toLowerCase(),
          decodeAttribute(attribute[2] ?? attribute[3] ?? attribute[4]),
        ],
      ),
    );
    if (tag === "img") {
      const attrs: Record<string, string> = Object.assign(
        {},
        ...stack.slice(-3).map((entry) => entry.attrs),
        own,
      );
      const type = attrs.data_skill_type || attrs["data-skill-type"];
      const declaredName = attrs.data_equip_name || attrs["data-equip-name"];
      const potential =
        declaredName ||
        type ||
        /data[-_](?:skill[-_]type|equip[-_](?:name|desc))\b/i.test(markup) ||
        attrs.data_equip_desc ||
        attrs["data-equip-desc"] ||
        /(?:skills?|neidan|equipment|\/equip\/)/i.test(attrs.src || "");
      if (!potential) continue;
      const name = declaredName || attrs.alt;
      if (!name || /^图标|^技能\s*\d*$|未知|未命名|unknown/i.test(name)) {
        issues.push("来源存在无法命名的技能、内丹或装备图标");
        continue;
      }
      if (type && !["cifu", "neidan"].includes(type)) {
        issues.push("来源存在无法分类的宝宝技能图标");
        continue;
      }
      const item = itemFromAttributes({ ...attrs, data_equip_name: name }, icons.length);
      if (item.kind === "equipment" && !gearDescription(item)) {
        issues.push("来源装备图标缺少完整属性，或未能确认图标类别");
        continue;
      }
      icons.push(item);
    } else if (!voidTags.has(tag) && !/\/\s*>$/.test(markup)) stack.push({ tag, attrs: own });
  }
  return { icons, issues };
}
function section(text: string, label: string) {
  const match = new RegExp(
    "(?:^|\\n)\\s*(?:" +
      label +
      ")\\s*[：:]?\\s*([^]*?)(?=\\n\\s*(?:技能|内丹|装备|宝宝装备|召唤兽装备|挂牌价|售价|价格|商品状态|在售|公示期)[：:]?|$)",
  ).exec(text);
  return match?.[1].trim() ?? null;
}
const tokens = (value: string) =>
  /^(?:无|未装备|0)$/.test(value.trim())
    ? []
    : value
        .split(/[\s、，,;；|]+/)
        .filter(Boolean)
        .map(normalize)
        .sort();
const equalSet = (a: string[], b: string[]) =>
  JSON.stringify(a.map(normalize).sort()) === JSON.stringify(b.map(normalize).sort());
function sourceFields(html: string, text: string) {
  const fields = new Map<string, string[]>();
  const add = (name: string, value: string) => {
    const key = fieldName(name),
      content = value.trim();
    if (key && content) fields.set(key, [...(fields.get(key) || []), content]);
  };
  for (const line of text.replace(/[ \t]+(?=[^：:\n\s]{1,30}[：:])/g, "\n").split(/[\n\t；]/)) {
    const field = line.trim().match(/^([^：:]{1,30})\s*[：:]\s*(.+)$/);
    if (field) add(field[1], field[2]);
  }
  const source = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  for (const row of source.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) =>
      pageText(cell[1]).trim(),
    );
    if (cells.length === 2) add(cells[0].replace(/[：:]$/, ""), cells[1]);
  }
  return fields;
}
function fieldMatches(fields: Map<string, string[]>, field: { name: string; value: string }) {
  const values = fields.get(fieldName(field.name));
  if (!values?.length) return false;
  const canonical = (value: string) => {
    const text = normalize(value);
    return /^\d+(?:\.\d+)?$/.test(text) ? String(Number(text)) : text;
  };
  // A complete label is required; “等级” must never match “携带等级”.
  // Repeated conflicting fields are ambiguous, even if one happens to match.
  return values.every((value) => canonical(value) === canonical(field.value));
}

/** Only independently read principal product content can establish a price. */
export function verifyPetCandidate(
  item: PetPricingItem,
  candidate: EquipmentCandidate,
  html: string,
  fetchedAt: string,
): EquipmentCandidate {
  const source = productSource(html);
  const text = pageText(source);
  const fields = sourceFields(source, text);
  const reject = (reason: string) => ({
    ...candidate,
    verified: false,
    reason,
    fetchedAt,
    sourceHash: hash(source),
  });
  if (
    candidate.priceType !== "listing" ||
    candidate.price === null ||
    !Number.isFinite(candidate.price) ||
    candidate.price <= 0 ||
    candidate.price > 1e9
  )
    return reject("不是可核对的挂牌人民币价格");
  if (/商品已下架|商品已售出|商品不存在|安全验证|请先登录/.test(text))
    return reject("来源不可用、需要登录或已下架");
  if (/角色编号|人物修炼|召唤兽修炼|角色等级|珍宝阁|梦幻西游手游/.test(text))
    return reject("不是电脑版独立召唤兽商品报价");
  if (!/召唤兽|宠物/.test(text) || item.fields.some((field) => !fieldMatches(fields, field)))
    return reject("宝宝类型、等级、成长、资质或其他关键属性不匹配");
  for (const field of extraSensitive)
    if (fields.has(field) && !item.fields.some((value) => value.name === field))
      return reject("报价多出宝宝价格相关属性“" + field + "”，需补采再核对");
  if (/变异/.test(text) && !/变异/.test(item.description))
    return reject("变异宝宝不能套用普通宝宝价格");
  if (/认证/.test(text) && !/认证/.test(item.description))
    return reject("认证状态未采齐，不能与永久技能混用");
  const { icons, issues: iconIssues } = sourceIcons(source);
  if (iconIssues.length) return reject(iconIssues.join("；"));
  const skillIcons = icons.filter((icon) => icon.kind === "skill");
  const skillSection = section(text, "技能(?:列表)?");
  const sourceSkills = skillIcons.length
    ? skillIcons.map((icon) => icon.name)
    : skillSection === null
      ? null
      : tokens(skillSection);
  if (sourceSkills === null || !equalSet(item.skills, sourceSkills))
    return reject("无法核对完整同名技能组合；技能数量相同也不能套价");
  const innerIcons = icons.filter((icon) => icon.kind === "innerSkill");
  const innerSection = section(text, "内丹");
  const sourceInner = innerIcons.length
    ? innerIcons.map((icon) => icon.name + (icon.level || "") + "层")
    : innerSection === null
      ? null
      : tokens(innerSection);
  if (
    sourceInner === null ||
    !equalSet(
      item.innerSkills.map((skill) => skill.name + skill.level + "层"),
      sourceInner,
    )
  )
    return reject("内丹名称或层数不匹配，或未确认内丹是否为空");
  const sourceGear = icons
    .filter((icon) => icon.kind === "equipment")
    .map((icon) => ({ name: icon.name, description: gearDescription(icon) }));
  const gearSection = section(text, "(?:宝宝|召唤兽)?装备");
  if (!sourceGear.length && (gearSection === null || tokens(gearSection).length))
    return reject("网页未证明随身宝宝装备完整，不能混用含装备报价");
  const gearKey = (gear: { name: string; description: string }) =>
    normalize(gear.name + "\n" + gear.description);
  if (!equalSet(item.equipment.map(gearKey), sourceGear.map(gearKey)))
    return reject("随身宝宝装备不匹配；包价不能另外重复加装备钱");
  if (!candidate.quote || !normalize(text).includes(normalize(candidate.quote)))
    return reject("候选引用不能在原始网页逐字核对");
  const prices = [...new Set(listingPrices(text))];
  if (!listingPrices(candidate.quote).includes(candidate.price))
    return reject("引用缺少该宝宝对应的挂牌价格");
  if (prices.length !== 1 || prices[0] !== candidate.price)
    return reject("主商品挂牌价格不明确或与候选不一致");
  if (!/上架中|在售|公示中|公示期/.test(text)) return reject("无法确认当前在售状态");
  return {
    ...candidate,
    verified: true,
    reason: "独立宝宝商品的挂牌价、完整技能及属性已核对；含匹配随身装备且只计一次",
    fetchedAt,
    sourceHash: hash(source),
    differences: [],
  };
}

export async function searchPetPricing(
  record: SavedRoleRecord,
  signal: AbortSignal,
  source: PetSource,
): Promise<PetPricingSnapshot> {
  const inventory = petInventory(record);
  const snapshot: PetPricingSnapshot = {
    version: 1,
    inputHash: inventory.inputHash,
    searchedAt: new Date().toISOString(),
    provider: "browser",
    model: "browser",
    queries: [],
    rawResponse: null,
    captureComplete: inventory.captureComplete,
    total: null,
    knownTotal: 0,
    items: inventory.items,
    issues: inventory.issues,
  };
  signal.throwIfAborted();
  if (!inventory.captureComplete) return snapshot;
  const searchable = snapshot.items.filter((item) => item.status === "no_match");
  if (!searchable.length) {
    snapshot.total = snapshot.items.length ? null : 0;
    return snapshot;
  }
  const lookupItems = searchable.map((item) => ({
    ...item,
    candidates: [],
    issues: [...item.issues],
  }));
  snapshot.requestText = JSON.stringify(lookupItems);
  snapshot.requestHash = hash(snapshot.requestText);
  const response = await source.findCandidates(lookupItems, signal);
  signal.throwIfAborted();
  snapshot.rawResponse = JSON.stringify(response);
  snapshot.searchItems = response.searchItems;
  snapshot.queries = [...new Set(response.queries.filter((query) => query.trim()))];
  if (!snapshot.queries.length) {
    snapshot.issues.push("本次检索没有实际查询记录，宝宝价格未采纳");
    for (const item of searchable) {
      const result = Array.isArray(response.items)
        ? response.items.find((entry) => entry?.key === item.key)
        : undefined;
      if (typeof result?.note === "string" && result.note.trim())
        item.issues.push(result.note.slice(0, 500));
    }
    return snapshot;
  }
  if (!Array.isArray(response.items) || response.items.length > 100) {
    snapshot.issues.push("宝宝查价结果格式错误");
    return snapshot;
  }
  const results = new Map<string, Record<string, unknown>>();
  for (const entry of response.items) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.key !== "string" ||
      !searchable.some((item) => item.key === entry.key) ||
      results.has(entry.key)
    ) {
      snapshot.issues.push("查价结果有未知或重复的宝宝ID");
      return snapshot;
    }
    results.set(entry.key, entry);
  }
  const pages = new Map<string, Promise<string>>();
  for (const item of searchable) {
    const result = results.get(item.key);
    if (!result || !Array.isArray(result.candidates) || result.candidates.length > 5) {
      item.issues.push("未返回该宝宝的有效候选");
      continue;
    }
    item.query = typeof result.query === "string" ? result.query : "";
    if (typeof result.note === "string" && result.note.trim())
      item.issues.push(result.note.slice(0, 500));
    const seen = new Set<string>();
    for (const raw of result.candidates) {
      if (
        !raw ||
        typeof raw !== "object" ||
        typeof raw.url !== "string" ||
        typeof raw.title !== "string" ||
        typeof raw.quote !== "string" ||
        raw.quote.length > 2000 ||
        raw.url.length > 2000
      )
        continue;
      let candidate: EquipmentCandidate = {
        url: raw.url,
        title: raw.title.slice(0, 300),
        price: typeof raw.price === "number" && Number.isFinite(raw.price) ? raw.price : null,
        priceType: raw.priceType === "listing" ? "listing" : "unknown",
        quote: raw.quote,
        verified: false,
        reason: "",
        fetchedAt: null,
        sourceHash: null,
      };
      try {
        candidate.url = safeEquipmentUrl(candidate.url);
        const identity = equipmentIdentity(candidate.url);
        if (seen.has(identity)) continue;
        seen.add(identity);
        if (!pages.has(identity)) pages.set(identity, source.readSource(candidate.url, signal));
        candidate = verifyPetCandidate(
          item,
          candidate,
          await pages.get(identity)!,
          new Date().toISOString(),
        );
      } catch (error) {
        signal.throwIfAborted();
        candidate.reason = error instanceof Error ? error.message : "无法核对宝宝报价来源";
      }
      item.candidates.push(candidate);
    }
    const verified = item.candidates.filter((candidate) => candidate.verified);
    if (verified.length) {
      const prices = verified.map((candidate) => candidate.price!).sort((a, b) => a - b);
      const middle = Math.floor(prices.length / 2);
      item.referencePrice = round(
        prices.length % 2 ? prices[middle] : (prices[middle - 1] + prices[middle]) / 2,
      );
      item.status = "priced";
      item.issues = verified.length === 1 ? ["仅1条挂牌样本，参考范围有限"] : [];
    } else item.issues.push("没有已核对的同配置宝宝挂牌报价，暂不自动定价");
  }
  snapshot.knownTotal = round(
    snapshot.items.reduce((sum, item) => sum + (item.referencePrice ?? 0), 0),
  );
  snapshot.total = snapshot.items.every((item) => item.status === "priced")
    ? snapshot.knownTotal
    : null;
  return snapshot;
}

/** Compose after equipment pricing; this preserves its value, sources and partial subtotal. */
export function combinePetPricing(
  result: ValuationResult,
  record: SavedRoleRecord,
  pricing?: PetPricingSnapshot,
): ValuationResult {
  const inventory = petInventory(record);
  const snapshot = pricing?.inputHash === inventory.inputHash ? pricing : undefined;
  const age = snapshot ? Date.now() - Date.parse(snapshot.searchedAt) : Infinity;
  const fresh = age >= -60_000 && age < 24 * 60 * 60 * 1000;
  const complete =
    inventory.captureComplete && !!snapshot?.captureComplete && snapshot.total !== null && fresh;
  const petValue = complete ? snapshot!.total : null;
  const value =
    result.model_value !== null && petValue !== null ? round(result.model_value + petValue) : null;
  const comparison = compareListingPrice(value, result.asking_price);
  const missing = [...result.missing_fields];
  if (!snapshot) missing.push("需要核对宝宝资料并实际联网查价");
  else if (!complete)
    missing.push(
      ...snapshot.issues,
      ...snapshot.items
        .filter((item) => item.status !== "priced")
        .map((item) => item.name + "：" + item.issues.join("；")),
    );
  if (snapshot && !fresh) missing.push("宝宝行情已过期，需要开始新批次重新联网查价");
  const suggestions = [...(result.suggestions || [])];
  if (!inventory.captureComplete)
    suggestions.unshift("先补采完整宝宝数量、技能、资质、内丹及随身装备，再开始分析。");
  else if (!complete)
    suggestions.unshift(
      snapshot && !fresh
        ? "开始新批次重新查宝宝价格；旧批次保留当时快照。"
        : "查看宝宝查价的匹配原因；未找到可靠同类报价的宝宝保留未定价。",
    );
  return {
    ...result,
    ...comparison,
    decision: result.decision === "OUT_OF_SCOPE" ? result.decision : comparison.decision,
    model_value: value,
    pet_value: petValue,
    pet_pricing: snapshot,
    price_comparison_scope:
      "裸号本体、人物装备/灵饰与召唤兽（含已核对随身装备）；锦衣和其他道具未计价",
    known_subtotal: round(result.known_subtotal + (fresh ? snapshot?.knownTotal || 0 : 0)),
    items: [
      ...result.items,
      ...(snapshot?.items || []).map((item, index) => ({
        name: "宝宝：" + item.name + "（" + item.key + "）",
        input: item.description,
        formula:
          "同配置宝宝（含匹配随身装备）挂牌价中位数（" +
          item.candidates.filter((candidate) => candidate.verified).length +
          "条样本）；不另加装备价",
        amount: fresh ? item.referencePrice : null,
        confirmed: fresh && item.status === "priced",
        evidence: item.candidates
          .filter((candidate) => candidate.verified)
          .map((candidate) => ({
            path: "/pet_pricing/items/" + index + "/candidates",
            value: candidate.quote,
            reason: candidate.url + " · " + candidate.fetchedAt,
          })),
      })),
    ],
    missing_fields: [...new Set(missing)],
    suggestions: [...new Set(suggestions)],
    reason:
      result.decision === "OUT_OF_SCOPE"
        ? result.reason
        : value === null
          ? "裸号、装备或宝宝尚有未定价部分，展示已算小计，暂无法比较完整挂牌差额。"
          : comparison.price_difference === null
            ? "参考估值¥" + value.toFixed(2) + "；缺少有效挂牌价，暂无法比较。"
            : "参考估值¥" +
              value.toFixed(2) +
              "，挂牌价¥" +
              result.asking_price!.toFixed(2) +
              "；估值比挂牌" +
              (comparison.price_difference >= 0 ? "高" : "低") +
              "¥" +
              Math.abs(comparison.price_difference).toFixed(2) +
              "。",
    next_action: value === null ? suggestions[0] || result.next_action : "",
  };
}
