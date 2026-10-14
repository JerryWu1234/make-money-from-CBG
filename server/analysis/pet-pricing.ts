import { createHash } from "node:crypto";
import { comparePetGear } from "./pet-gear-match";
import type { DetailItem, PetSnapshot, SavedRoleRecord } from "../crawler/types";
import { cleanDescription, coreEquipmentDescription, itemFromAttributes } from "../crawler/compact";
import { compareListingPrice } from "./valuation-calculator";
import {
  inventoryMatchesSnapshot,
  priceMinimum,
  validateExactPricing,
  EQUIPMENT_QUOTE_LIMIT,
  EQUIPMENT_QUOTE_POLICY,
  PRICING_RESUME_POLICY,
  skippedPricingItem,
} from "./pricing-integrity";
import type { ValuationResult } from "./valuation-types";
import { buildSimilarEstimate, SIMILAR_POLICY_VERSION } from "./pricing-estimate";
import { GLOBAL_MARKET_SCOPE_VERSION, MARKET_SEARCH_UI_VERSION } from "./market-scope";
import {
  currentPetSkills,
  canonicalPetStar,
  petSkillState,
  similarPetSkills,
  petLevelBounds,
  PET_APTITUDE_TOLERANCE,
  PET_GROWTH_TOLERANCE,
  petBlessingState,
  PET_BLESSING_POLICY_VERSION,
  PET_COMPARISON_POLICY_VERSION,
} from "./pet-match";
import {
  finishPricingSearch,
  reconcilePricingCompletion,
  resumePricingItems,
  saveSearchAttempt,
  type PricingSearchState,
} from "./pricing-progress";
import {
  equipmentIdentity,
  listingPrices,
  pageText,
  productSource,
  safeEquipmentUrl,
  type EquipmentCandidate,
  type EquipmentPricingItem,
  type EquipmentPricingSnapshot,
  type EquipmentSearchCursor,
} from "./equipment-pricing";

export type PetEquipment = { name: string; description: string; accessory?: boolean };
export type PetPricingItem = EquipmentPricingItem & {
  fields: PetSnapshot["fields"];
  skills: string[];
  skillObservations?: NonNullable<DetailItem["skillObservation"]>[];
  innerSkills: { name: string; level: string }[];
  equipment: PetEquipment[];
  diagnosticSources?: EquipmentCandidate[];
};
export type PetPricingSnapshot = Omit<EquipmentPricingSnapshot, "items"> & {
  items: PetPricingItem[];
  gearPricing?: import("./pet-gear-inventory").PetGearPricingSnapshot;
};
export type PetSource = {
  findCandidates: (
    items: PetPricingItem[],
    signal: AbortSignal,
  ) => Promise<{
    queries: string[];
    items: Array<{
      key: string;
      candidates: EquipmentCandidate[];
      note?: string;
      query?: string;
      similarAttempted?: boolean;
      diagnosticSources?: EquipmentCandidate[];
      searchState?: PricingSearchState;
      searchCursor?: EquipmentSearchCursor;
      skipped?: boolean;
      samplingStopped?: boolean;
      skipReason?: string;
    }>;
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
    .replace(/^躲避资质$/, "躲闪资质")
    .replace(/^已用幻色丹$/, "已使用幻色丹");
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
  "神兽星级",
];
export const petEquipmentDescription = (gear: PetEquipment) =>
  gear.accessory ? cleanDescription(gear.description) : coreEquipmentDescription(gear.description);
const gearDescription = (item: DetailItem) =>
  petEquipmentDescription({
    name: item.name,
    accessory: item.location === "RolePetShipin",
    description:
      item.description ||
      item.tooltip ||
      Object.entries(item.attributes || {})
        .map(([key, value]) => key + "：" + value)
        .join("\n"),
  });

function petPricingSkipReason(level: number | null, fields: PetPricingItem["fields"]) {
  if (level === 0) return "0级宝宝，未计入参考合计";
  const baby = fields.filter((field) => ["是否宝宝", "宝宝"].includes(field.name));
  if (baby.length && baby.every((field) => /^(?:否|0|野生)$/.test(field.value)))
    return "野生宝宝，未计入参考合计";
  return undefined;
}

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
      const skillObservations = pet.skills.flatMap((skill) =>
        skill.skillObservation ? [skill.skillObservation] : [],
      );
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
        ...(item.location === "RolePetShipin" ? { accessory: true } : {}),
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
      const skipReason = petPricingSkipReason(level, fields);
      items.push({
        key,
        name,
        level,
        category: "召唤兽（含已核对随身装备）",
        description,
        query: skipReason
          ? ""
          : "梦幻西游电脑版 藏宝阁 全服 召唤兽 " + name + " " + description.replace(/\n/g, " "),
        status: skipReason
          ? "no_match"
          : bound
            ? "untradable"
            : itemIssues.length
              ? "incomplete"
              : "no_match",
        referencePrice: null,
        priceMethod: EQUIPMENT_QUOTE_POLICY,
        candidates: [],
        issues: skipReason
          ? [...itemIssues, skipReason]
          : bound
            ? [...itemIssues, "绑定或不可交易宝宝不能套用可交易价格"]
            : itemIssues,
        fields,
        skills,
        ...(skillObservations.length ? { skillObservations } : {}),
        innerSkills,
        equipment,
        ...(skipReason ? { searchState: "skipped", skipReason } : {}),
      });
    }
  }
  const captureComplete = !!capture?.complete && !issues.length;
  const inputHash = hash(
    JSON.stringify({
      marketScope: GLOBAL_MARKET_SCOPE_VERSION,
      searchUI: MARKET_SEARCH_UI_VERSION,
      comparisonPolicy: PET_COMPARISON_POLICY_VERSION,
      queryPolicy: "pet-observed-star-trait-v1",
      similarPolicy: SIMILAR_POLICY_VERSION,
      priceMethod: EQUIPMENT_QUOTE_POLICY,
      blessingPolicy: PET_BLESSING_POLICY_VERSION,
      resumePolicy: PRICING_RESUME_POLICY,
      skipPolicy: "zero-level-or-explicit-wild-v1",
      collectedAt: capture?.collectedAt,
      captureComplete,
      issues,
      items: items.map(
        ({ key, name, fields, skills, skillObservations, innerSkills, equipment }) => ({
          key,
          name,
          fields,
          skills,
          ...(skillObservations ? { skillObservations } : {}),
          innerSkills,
          equipment,
        }),
      ),
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
        /(?:skills?|neidan|equipment|\/(?:equip|pet_shipin)\/)/i.test(attrs.src || "");
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
      const accessory =
        attrs.data_equip_location === "RolePetShipin" ||
        stack.some((entry) => entry.attrs.id === "RolePetShipin") ||
        /\/images\/pet_shipin\//.test(attrs.src || "");
      const item = itemFromAttributes(
        {
          ...attrs,
          data_equip_name: name,
          ...(accessory ? { data_equip_location: "RolePetShipin" } : {}),
        },
        icons.length,
      );
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
    if (key && (content || /赐福/.test(key)))
      fields.set(key, [...(fields.get(key) || []), content]);
  };
  for (const line of text.replace(/[ \t]+(?=[^：:\n\s]{1,30}[：:])/g, "\n").split(/[\n\t；]/)) {
    const field = line.trim().match(/^([^：:]{1,30})\s*[：:]\s*(.*)$/);
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
  if (field.name === "神兽星级") {
    const star = canonicalPetStar(field.value);
    return star !== undefined && values.every((value) => canonicalPetStar(value) === star);
  }
  const canonical = (value: string) => {
    const text = normalize(value);
    return /^\d+(?:\.\d+)?$/.test(text) ? String(Number(text)) : text;
  };
  // A complete label is required; “等级” must never match “携带等级”.
  // Repeated conflicting fields are ambiguous, even if one happens to match.
  return values.every((value) => canonical(value) === canonical(field.value));
}

export type PetMatchType = "exact" | "similar";
const mainAptitudes = new Set(["攻击资质", "防御资质", "体力资质", "法力资质"]);
const secondaryAptitudes = new Set(["速度资质", "躲闪资质"]);
const allocationFields = new Set(["体质", "魔力", "力量", "耐力", "敏捷", "潜能"]);
const performanceFields = new Set(["攻击", "防御", "速度", "法伤", "法防"]);
const aptitudeParts = (value: string) => {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(?:\s*\+\s*(\d+(?:\.\d+)?))?$/);
  if (!match) return null;
  const base = Number(match[1]),
    bonus = Number(match[2] || "0");
  return Number.isFinite(base) && Number.isFinite(bonus) ? { base, bonus } : null;
};
function similarFieldDifference(
  fields: Map<string, string[]>,
  field: { name: string; value: string },
): string | null {
  const values = fields.get(fieldName(field.name));
  if (!values?.length || new Set(values.map(normalize)).size !== 1) return null;
  const source = values[0];
  if (mainAptitudes.has(field.name) || secondaryAptitudes.has(field.name)) {
    const target = aptitudeParts(field.value),
      observed = aptitudeParts(source);
    const tolerance = PET_APTITUDE_TOLERANCE;
    if (
      !target ||
      !observed ||
      (target.bonus > 0 ? target.bonus !== observed.bonus : false) ||
      Math.abs(observed.base - target.base) > target.base * tolerance
    )
      return null;
    return `${field.name}：目标 ${field.value}，样本 ${source}（基础值差异≤${tolerance * 100}%${observed.bonus && target.bonus === 0 ? `，样本含额外加成+${observed.bonus}` : "，加成一致"}）`;
  }
  if (field.name === "等级" || field.name === "成长") {
    if (!/^\d+(?:\.\d+)?$/.test(field.value) || !/^\d+(?:\.\d+)?$/.test(source)) return null;
    const target = Number(field.value),
      observed = Number(source);
    if (field.name === "等级") {
      const [min, max] = petLevelBounds(target);
      if (!Number.isInteger(observed) || observed < min || observed > max) return null;
    } else if (Math.abs(observed - target) > PET_GROWTH_TOLERANCE + 1e-9) return null;
    return `${field.name}：目标 ${field.value}，样本 ${source}（有限相近范围，未推测折价）`;
  }
  if (
    /^(?:五行|已用元宵|已用千金露|已用炼兽珍经|已使用?幻色丹|已用清灵仙露|历史灵性值)$/.test(
      field.name,
    )
  )
    return `${field.name}：目标 ${field.value}，样本 ${source}（使用历史或普通配置不同）`;
  if (allocationFields.has(field.name) || performanceFields.has(field.name)) {
    if (
      !/^\d+(?:\.\d+)?$/.test(field.value) ||
      !/^\d+(?:\.\d+)?$/.test(source) ||
      !Number.isFinite(Number(field.value)) ||
      !Number.isFinite(Number(source))
    )
      return null;
    return `${field.name}：目标 ${field.value}，样本 ${source}（${allocationFields.has(field.name) ? "普通加点不同，未据此折价" : "衍生性能不同，含普通加点与随身装备影响"}）`;
  }
  return null;
}

/** Only independently read principal product content can establish a price. */
export function verifyPetCandidate(
  item: PetPricingItem,
  candidate: EquipmentCandidate,
  html: string,
  fetchedAt: string,
  matchType: PetMatchType = "exact",
): EquipmentCandidate {
  const source = productSource(html);
  const text = pageText(source);
  const fields = sourceFields(source, text);
  const reject = (reason: string) => ({
    ...candidate,
    matchType,
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
  if (!/召唤兽|宠物/.test(text)) return reject("不是可核对的独立宝宝商品");
  const targetBlessing = petBlessingState(item.fields);
  const sourceBlessing = petBlessingState(
    [...fields].flatMap(([name, values]) => values.map((value) => ({ name, value }))),
  );
  if (targetBlessing.fields.length && targetBlessing.state !== "absent")
    return reject("目标赐福配置存在或状态未知，完整技能与有效状态未核对");
  if (sourceBlessing.fields.length && sourceBlessing.state !== "absent")
    return reject("来源赐福配置存在或状态未知，完整技能与有效状态未核对");
  const differences: string[] = [];
  for (const field of item.fields) {
    if (/赐福/.test(field.name)) continue;
    if (fieldMatches(fields, field)) continue;
    const difference = matchType === "similar" ? similarFieldDifference(fields, field) : null;
    if (!difference) return reject("宝宝类型、等级、成长、资质或其他关键属性不匹配：" + field.name);
    differences.push(difference);
  }
  const targetSkills = currentPetSkills(item);
  const certifiedSkill = fields.get("认证技能")?.[0] || fields.get("认证")?.[0] || "";
  const certificationHandled =
    matchType === "similar" && Boolean(certifiedSkill && targetSkills.includes(certifiedSkill));
  if (certificationHandled) {
    differences.push(`认证技能：目标普通技能包含${certifiedSkill}，样本认证${certifiedSkill}`);
  }
  for (const field of extraSensitive) {
    if (/赐福/.test(field)) continue;
    if (certificationHandled && (field === "认证" || field === "认证技能")) continue;
    if (fields.has(field) && !item.fields.some((value) => value.name === field))
      return reject("报价多出宝宝价格相关属性“" + field + "”，需补采再核对");
  }
  if (/变异/.test(text) && !/变异/.test(item.description))
    return reject("变异宝宝不能套用普通宝宝价格");
  if (!certificationHandled && /认证/.test(text) && !/认证/.test(item.description))
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
  if (sourceSkills === null) return reject("来源完整技能列表未确认");
  const sourceCurrent = currentPetSkills({ skills: sourceSkills });
  if (item.skills.some((name) => ["conditional", "unknown"].includes(petSkillState(name, item))))
    return reject("目标条件或未知技能状态未核对，不能当作永久技能报价");
  const targetFuture = item.skills.filter((name) => petSkillState(name, item) === "future");
  const sourceFuture = sourceSkills.filter((name) => petSkillState(name) === "future");
  if (!equalSet(targetFuture, sourceFuture)) {
    if (matchType !== "similar") return reject("未来进化技能配置不同，不能作为完全同配置报价");
    differences.push(
      `未来进化技能预览：目标 ${targetFuture.join("、") || "无"}；样本 ${sourceFuture.join("、") || "无"}；分别保留状态，不计当前技能或额外加价`,
    );
  }
  if (matchType === "similar") {
    const skills = similarPetSkills(targetSkills, sourceCurrent);
    if (!skills.accepted) return reject(skills.reason || "宝宝当前技能相似性不足");
    differences.push(...(skills.differences || []));
  } else if (!equalSet(targetSkills, sourceCurrent))
    return reject("无法核对完整同名技能组合；技能数量相同也不能套价");
  const innerIcons = icons.filter((icon) => icon.kind === "innerSkill");
  const innerSection = section(text, "内丹");
  const sourceInner = innerIcons.length
    ? innerIcons.map((icon) => icon.name + (icon.level || "") + "层")
    : innerSection === null
      ? null
      : tokens(innerSection);
  if (sourceInner === null) return reject("来源完整内丹列表未确认");
  const targetInner = item.innerSkills.map((skill) => skill.name + skill.level + "层");
  if (!equalSet(targetInner, sourceInner)) {
    if (matchType !== "similar") return reject("内丹名称或层数不匹配，或未确认内丹是否为空");
    differences.push(
      `内丹：目标 ${targetInner.join("、") || "无"}；样本 ${sourceInner.join("、") || "无"}（包价包含样本内丹，未折价）`,
    );
  }
  const sourceGear = icons
    .filter((icon) => icon.kind === "equipment")
    .map((icon) => ({
      name: icon.name,
      description: gearDescription(icon),
      accessory: icon.location === "RolePetShipin",
    }));
  const gearSection = section(text, "(?:宝宝|召唤兽)?装备");
  if (!sourceGear.length && (gearSection === null || tokens(gearSection).length))
    return reject("网页未证明随身宝宝装备完整，不能混用含装备报价");
  const gearKey = (gear: PetEquipment) =>
    normalize((gear.accessory ? "饰品" : "装备") + "\n" + gear.name + "\n" + gear.description);
  if (!equalSet(item.equipment.map(gearKey), sourceGear.map(gearKey))) {
    if (matchType !== "similar") return reject("随身宝宝装备不匹配；包价不能另外重复加装备钱");
    if (item.equipment.length !== sourceGear.length)
      return reject("随身宝宝装备数量不匹配，不能作为含装备包价");
    const remaining = [...sourceGear];
    for (const gear of item.equipment) {
      const index = remaining.findIndex(
        (other) =>
          other.name === gear.name &&
          Boolean(other.accessory) === Boolean(gear.accessory) &&
          (gear.accessory
            ? gearKey(gear) === gearKey(other)
            : !comparePetGear(gear, other.name, other.description).reason),
      );
      if (index < 0) return reject("随身宝宝装备类型、等级、属性、镶嵌或套装不兼容，不能采用包价");
      remaining.splice(index, 1);
    }
    const describe = (gear: PetEquipment[]) =>
      gear.map((value) => value.name + "：" + value.description).join("；") || "无";
    differences.push(
      `随身装备包价差异：目标 ${describe(item.equipment)}；样本 ${describe(sourceGear)}；不额外加装备价，不推测差异折价`,
    );
  }
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
    matchType: differences.length ? "similar" : "exact",
    verified: true,
    reason: differences.length
      ? "同类型在售宝宝已核对；受保护技能、变异和认证一致，普通技能与等级/成长/资质在相近范围，内丹及装备包价差异已列明，仅作相似样本"
      : "独立宝宝商品的挂牌价、完整技能及属性已核对；含匹配随身装备且只计一次",
    fetchedAt,
    sourceHash: hash(source),
    differences,
    similarityScore: differences.length,
  };
}

/** Query complete pets only when the captured inventory scope is unambiguous. */
export function petCaptureSearchable(record: SavedRoleRecord, inventory = petInventory(record)) {
  const capture = record.detail?.petCapture;
  const tabs = record.detail?.tabs.filter((tab) => tab.name === "召唤兽/孩子") || [];
  return (
    inventory.captureComplete ||
    (capture?.version === 1 &&
      tabs.length === 1 &&
      tabs[0].petCount === tabs[0].pets?.length &&
      new Set(inventory.items.map((item) => item.key)).size === inventory.items.length &&
      inventory.items.some((item) => item.status === "incomplete") &&
      capture.issues.every((issue) => {
        const index = issue.match(/^第 (\d+) 只召唤兽/)?.[1];
        return (
          !!index &&
          inventory.items.some(
            (item) => item.key === "召唤兽/孩子:" + index && item.status === "incomplete",
          )
        );
      }))
  );
}

export async function searchPetPricing(
  record: SavedRoleRecord,
  signal: AbortSignal,
  source: PetSource,
  previous?: PetPricingSnapshot,
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
  resumePricingItems(snapshot, previous, true);
  // Recheck a previously unsupported catalogue type so the confirmed skip policy can apply.
  for (const item of snapshot.items)
    if (
      item.searchState === "unsupported" &&
      item.issues.some((issue) => issue.includes("没有独立可交易筛选定义"))
    ) {
      item.status = "no_match";
      item.searchState = "pending";
      item.issues = [...inventory.items.find((original) => original.key === item.key)!.issues];
    }
  signal.throwIfAborted();
  if (!petCaptureSearchable(record, inventory)) {
    for (const item of snapshot.items) {
      delete item.searchState;
      if (item.status === "no_match")
        item.issues.push("宝宝清单或采集范围未确认，先补采资料再查价");
    }
    return finishPricingSearch(snapshot);
  }
  const searchable = snapshot.items.filter((item) => item.searchState === "pending");
  if (!searchable.length) return finishPricingSearch(snapshot);
  const lookupItems = searchable.map((item) => ({
    ...item,
    candidates: item.candidates.filter((candidate) => candidate.verified),
    issues: [...item.issues],
  }));
  snapshot.requestText = JSON.stringify(lookupItems);
  snapshot.requestHash = hash(snapshot.requestText);
  const response = await source.findCandidates(lookupItems, signal);
  signal.throwIfAborted();
  snapshot.rawResponse = JSON.stringify(response);
  saveSearchAttempt(snapshot, response);
  const specialSkipReason = "官网无独立交易筛选的特殊宝宝，未计入参考合计";
  const markSpecialSkip = (item: PetPricingItem, result: Record<string, unknown>) => {
    if (result.searchState !== "skipped" || result.skipReason !== specialSkipReason) return false;
    item.status = "unsupported";
    item.searchState = "skipped";
    item.skipReason = specialSkipReason;
    item.query = "";
    item.referencePrice = null;
    item.candidates = [];
    delete item.similarEstimate;
    delete item.searchCursor;
    delete item.samplingStopped;
    return true;
  };
  if (!response.queries.some((query) => query.trim())) {
    const allSpecialSkipped =
      response.items.length === searchable.length &&
      searchable.every((item) =>
        response.items.some(
          (result) =>
            result.key === item.key &&
            result.searchState === "skipped" &&
            result.skipReason === specialSkipReason,
        ),
      );
    if (!allSpecialSkipped) snapshot.issues.push("本次检索没有实际查询记录，宝宝价格未采纳");
    for (const item of searchable) {
      const result = Array.isArray(response.items)
        ? response.items.find((entry) => entry?.key === item.key)
        : undefined;
      if (typeof result?.note === "string" && result.note.trim())
        item.issues.push(result.note.slice(0, 500));
      if (result && markSpecialSkip(item, result)) continue;
      if (result?.searchState === "unsupported") {
        item.searchState = "unsupported";
        item.status = "unsupported";
      }
    }
    return finishPricingSearch(snapshot);
  }
  if (!Array.isArray(response.items) || response.items.length > 100) {
    snapshot.issues.push("宝宝查价结果格式错误");
    return finishPricingSearch(snapshot);
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
      return finishPricingSearch(snapshot);
    }
    results.set(entry.key, entry);
  }
  const pages = new Map<string, Promise<string>>();
  for (const item of searchable) {
    const result = results.get(item.key);
    if (
      !result ||
      !Array.isArray(result.candidates) ||
      result.candidates.length > EQUIPMENT_QUOTE_LIMIT
    ) {
      item.issues.push("未返回该宝宝的有效候选");
      continue;
    }
    if (result.skipped === true) continue;
    if (markSpecialSkip(item, result)) {
      if (typeof result.note === "string") item.issues.push(result.note.slice(0, 500));
      continue;
    }
    item.samplingStopped = result.samplingStopped === true;
    item.query = typeof result.query === "string" ? result.query : "";
    item.searchCursor = result.searchCursor as EquipmentSearchCursor | undefined;
    item.candidates = [];
    delete item.diagnosticSources;
    item.searchState = ["pending", "read_failed", "unsupported"].includes(
      String(result.searchState),
    )
      ? (result.searchState as PricingSearchState)
      : "completed";
    if (item.searchState === "unsupported") item.status = "unsupported";
    if (typeof result.note === "string" && result.note.trim())
      item.issues.push(result.note.slice(0, 500));
    const seen = new Map<string, number | null>();
    let readFailed = false;
    const rawEntries = [
      ...result.candidates.map((raw) => ({ raw, diagnostic: false })),
      ...(Array.isArray(result.diagnosticSources) && result.diagnosticSources.length <= 3
        ? result.diagnosticSources.map((raw) => ({ raw, diagnostic: true }))
        : []),
    ];
    for (const { raw, diagnostic } of rawEntries) {
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
        matchType: raw.matchType === "similar" ? "similar" : "exact",
      };
      let readingSource = false;
      try {
        candidate.url = safeEquipmentUrl(candidate.url);
        const identity = equipmentIdentity(candidate.url);
        if (seen.has(identity)) {
          if (!diagnostic && seen.get(identity) !== candidate.price) {
            readFailed = true;
            item.candidates.push({ ...candidate, reason: "同一商品的报价冲突，需要重新读取" });
          }
          continue;
        }
        seen.set(identity, candidate.price);
        if (candidate.price === null)
          candidate.reason =
            typeof raw.reason === "string" && raw.reason.trim()
              ? raw.reason.slice(0, 500)
              : "宝宝详情未能完整读取，缺少有效挂牌价";
        else {
          readingSource = true;
          if (!pages.has(identity)) pages.set(identity, source.readSource(candidate.url, signal));
          candidate = verifyPetCandidate(
            item,
            candidate,
            await pages.get(identity)!,
            new Date().toISOString(),
            candidate.matchType,
          );
        }
      } catch (error) {
        signal.throwIfAborted();
        candidate.reason = error instanceof Error ? error.message : "无法核对宝宝报价来源";
        readFailed ||= readingSource;
      }
      if (diagnostic)
        (item.diagnosticSources ||= []).push({
          ...candidate,
          verified: false,
          reason: "仅用于真实独立详情诊断，不计价：" + candidate.reason,
        });
      else item.candidates.push(candidate);
    }
    const verified = item.candidates.filter(
      (candidate) => candidate.verified && candidate.matchType !== "similar",
    );
    if (readFailed) item.searchState = "read_failed";
    reconcilePricingCompletion(item, snapshot.searchItems);
    if (verified.length && item.searchState === "completed") {
      item.referencePrice = priceMinimum(
        verified.slice(0, EQUIPMENT_QUOTE_LIMIT).map((candidate) => candidate.price!),
      );
      item.status = "priced";
      item.searchState = "completed";
      item.issues = verified.length === 1 ? ["仅1条挂牌样本，参考范围有限"] : [];
      if (verified.length < EQUIPMENT_QUOTE_LIMIT)
        item.issues.push(
          `在各筛选条件前${EQUIPMENT_QUOTE_LIMIT}条候选或更少的实际结果中，已核实${verified.length}件同配置宝宝，均价使用实际样本数，搜索范围有限`,
        );
    }
    if (
      item.query.includes("/ similar /") ||
      result.similarAttempted === true ||
      item.candidates.some((candidate) => candidate.matchType === "similar")
    ) {
      const closest = item.candidates
        .filter((candidate) => candidate.verified && candidate.matchType === "similar")
        .slice(0, EQUIPMENT_QUOTE_LIMIT);
      // Keep the same samples in the snapshot that final valuation will independently recompute.
      // The complete response, including less comparable quotations, remains in rawResponse.
      item.candidates = [
        ...closest,
        ...item.candidates.filter(
          (candidate) => !candidate.verified || candidate.matchType !== "similar",
        ),
      ];
      item.similarEstimate = buildSimilarEstimate(item.candidates);
      if (item.similarEstimate.status !== "range") item.issues.push(...item.similarEstimate.issues);
    }
    if (!verified.length) {
      if (readFailed && item.similarEstimate?.status !== "range") item.searchState = "read_failed";
      item.issues.push(
        item.similarEstimate?.status === "range"
          ? "暂无完全同配置报价，采用已核验相近宝宝样本最低挂牌价作为参考价，并保留报价范围和配置差异"
          : item.searchState === "read_failed"
            ? "宝宝独立详情读取失败，尚未完成查价；继续时重试"
            : item.searchState === "pending"
              ? "宝宝查价尚未完成；继续时重试"
              : "没有已核对的同配置宝宝挂牌报价，暂不自动定价",
      );
    }
  }
  snapshot.knownTotal = round(
    snapshot.items.reduce((sum, item) => sum + (item.referencePrice ?? 0), 0),
  );
  snapshot.total = snapshot.items.every((item) => item.status === "priced")
    ? snapshot.knownTotal
    : null;
  return finishPricingSearch(snapshot);
}

/** Compose after equipment pricing; this preserves its value, sources and partial subtotal. */
export function combinePetPricing(
  result: ValuationResult,
  record: SavedRoleRecord,
  pricing?: PetPricingSnapshot,
): ValuationResult {
  const inventory = petInventory(record);
  const snapshot =
    pricing?.inputHash === inventory.inputHash && inventoryMatchesSnapshot(pricing, inventory.items)
      ? pricing
      : undefined;
  const age = snapshot ? Date.now() - Date.parse(snapshot.searchedAt) : Infinity;
  const fresh = age >= -60_000 && age < 24 * 60 * 60 * 1000;
  const verified = validateExactPricing(snapshot, inventory.items);
  const complete =
    inventory.captureComplete &&
    !!snapshot?.captureComplete &&
    snapshot.total !== null &&
    fresh &&
    verified;
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
        .filter((item) => item.status !== "priced" && !skippedPricingItem(item))
        .map((item) => item.name + "：" + item.issues.join("；")),
    );
  if (snapshot && !fresh) missing.push("宝宝行情已过期，需要开始新批次重新联网查价");
  if (snapshot && fresh && !verified) missing.push("宝宝报价快照与样本金额不一致，需要重新查价");
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
    known_subtotal: round(
      result.known_subtotal + (fresh && verified ? snapshot?.knownTotal || 0 : 0),
    ),
    items: [
      ...result.items,
      ...(snapshot?.items || []).map((item, index) => ({
        ...(fresh && verified && skippedPricingItem(item)
          ? { referenceBasis: "excluded" as const }
          : {}),
        name: "宝宝：" + item.name + "（" + item.key + "）",
        input: item.description,
        formula: skippedPricingItem(item)
          ? (item.skipReason || "无样本，未计入参考合计") + "；市场售价未知，不记作0元。"
          : "同配置宝宝（含匹配随身装备）最低挂牌价（" +
            item.candidates.filter(
              (candidate) => candidate.verified && candidate.matchType !== "similar",
            ).length +
            "条样本）；不另加装备价",
        amount: fresh && verified ? item.referencePrice : null,
        confirmed: fresh && verified && item.status === "priced",
        evidence: item.candidates
          .filter((candidate) => candidate.verified && candidate.matchType !== "similar")
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
