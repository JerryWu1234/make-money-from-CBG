import type { DetailItem, SavedRoleRecord } from "../crawler/types";
import { observedEquipmentCategory } from "../crawler/compact";
import { parseEquipmentAttributes } from "./equip-attributes";
import { equipmentInventory, isJewelryEquipment } from "./equipment-pricing";
import { petInventory } from "./pet-pricing";

type SourceEvidence = { path: string; quote: string };
export type ConditionInventoryItem = {
  name: string;
  path: string;
  category: string;
  classificationEvidence: SourceEvidence[];
};
export type ConditionCharacterEquipment = ConditionInventoryItem & {
  gemLevel: number | null;
  gemEvidence: SourceEvidence[];
};
const escapeSegment = (value: string) => value.replaceAll("~", "~0").replaceAll("/", "~1");
const jewelryType = /【类型】\s*(戒指|耳饰|佩饰|手镯)(?=#|\s|$)/;
const ordinaryCategory =
  /人物装备\s*[·/]\s*(?:武器|头盔|发钗|项链|饰品|腰带|衣服|铠甲|女衣|鞋子|鞋)$/;

/** Present physical inventory, not the smaller set of assets eligible for market pricing. */
export function conditionSourceInventory(record: SavedRoleRecord) {
  const equipment: ConditionCharacterEquipment[] = [],
    jewelry: ConditionInventoryItem[] = [],
    petEquipment: ConditionInventoryItem[] = [],
    pets: ConditionInventoryItem[] = [],
    unclassified: ConditionCharacterEquipment[] = [];
  const normalized = equipmentInventory(record);
  const normalizedItems = new Map(normalized.items.map((item) => [item.key, item]));
  const petCapture = petInventory(record);
  const identities = new Map<string, { item: ConditionInventoryItem; signature: string }>();
  const issues: string[] = [];

  function sourceFields(item: DetailItem, path: string) {
    const values: SourceEvidence[] = [];
    for (const key of ["category", "location", "kindId"] as const)
      if (item[key]) values.push({ path: `${path}/${key}`, quote: item[key]! });
    for (const name of ["装备角色", "装备对象", "装备条件"])
      if (item.attributes?.[name])
        values.push({
          path: `${path}/attributes/${escapeSegment(name)}`,
          quote: item.attributes[name],
        });
    for (const match of (item.officialModel?.description || "").matchAll(
      /【(?:类型|装备角色|装备对象|装备条件)】[^#\n]+/g,
    ))
      values.push({ path: `${path}/officialModel/description`, quote: match[0] });
    return values;
  }
  function gemFacts(item: DetailItem, path: string) {
    const observations: Array<SourceEvidence & { value: number | null }> = [];
    for (const key of ["description", "tooltip"] as const) {
      const raw = item[key];
      if (!raw) continue;
      const parsed = parseEquipmentAttributes(raw).fields.锻炼等级;
      for (const value of parsed || []) {
        const numeric = /^\d+$/.test(value) ? Number(value) : null;
        const quote =
          [...raw.matchAll(/(?:锻炼等级|宝石等级)\s*[:：]?\s*\d+/g)].find(
            (match) => Number(match[0].match(/\d+$/)?.[0]) === numeric,
          )?.[0] || raw;
        observations.push({ path: `${path}/${key}`, quote, value: numeric });
      }
      if (!parsed?.length && /(?:未镶嵌宝石|没有镶嵌宝石)/.test(raw))
        observations.push({
          path: `${path}/${key}`,
          quote: raw.match(/未镶嵌宝石|没有镶嵌宝石/)![0],
          value: 0,
        });
    }
    for (const key of ["锻炼等级", "宝石等级"]) {
      const raw = item.attributes?.[key];
      if (raw !== undefined && raw.trim())
        observations.push({
          path: `${path}/attributes/${escapeSegment(key)}`,
          quote: raw,
          value: /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null,
        });
    }
    const complete =
      record.detail?.captureMode !== "body" &&
      record.detail?.equipmentCapture?.complete === true &&
      !record.detail.equipmentCapture.issues?.length;
    const instanceText = [item.description, item.tooltip].filter(Boolean).join("\n");
    if (!observations.length && complete && !/锻炼等级|宝石等级|镶嵌宝石/.test(instanceText)) {
      // Per the user's convention, a fully read equipment tooltip without gems is 0.
      // A name/type alone is insufficient: retain unknown when detail was not read.
      for (const key of ["description", "tooltip"] as const) {
        const raw = item[key];
        if (
          raw &&
          (/等级\s*[:：]?\s*\d+/.test(raw) || /^\d+$/.test(item.attributes?.等级?.trim() || "")) &&
          /耐久|伤害|防御|命中|灵力|敏捷|气血|魔法/.test(raw)
        ) {
          observations.push({ path: `${path}/${key}`, quote: raw.trim().slice(0, 1000), value: 0 });
          break;
        }
      }
    }
    const values = [...new Set(observations.map((entry) => entry.value))];
    const gemLevel = values.length === 1 && values[0] !== null ? values[0] : null;
    if (values.length > 1) issues.push(`${item.name}的宝石段数原文冲突`);
    return {
      gemLevel,
      gemEvidence: (gemLevel === null ? observations : observations.slice(0, 1)).map(
        ({ path, quote }) => ({ path, quote }),
      ),
    };
  }
  function add<T extends ConditionInventoryItem>(target: T[], result: T, raw: DetailItem) {
    // Display positions, model IDs and names do not identify one physical item.
    // Only an actual item ID can merge observations from different containers.
    const identity = /^\d{14,}-\d+-[a-zA-Z0-9]+$/.test(raw.location || "")
      ? raw.location!
      : result.path;
    const signature = JSON.stringify({
      category: result.category,
      name: result.name,
      description: raw.description,
      tooltip: raw.tooltip,
      attributes: raw.attributes,
    });
    const previous = identities.get(identity);
    if (previous) {
      if (previous.signature !== signature) {
        issues.push(`${result.name}的同一物品标识有冲突资料`);
        if ("gemLevel" in previous.item) previous.item.gemLevel = null;
      }
      return;
    }
    identities.set(identity, { item: result, signature });
    target.push(result);
  }

  for (const [ti, tab] of (record.detail?.tabs || []).entries()) {
    if (/^道具\/法宝(?:\s*\/|$)/.test(tab.name))
      for (const [ii, raw] of (tab.items || []).entries()) {
        if (raw.kind === "skill" || raw.kind === "innerSkill") continue;
        const path = `/detail/tabs/${ti}/items/${ii}`;
        const known = normalizedItems.get(`${tab.name}:${raw.index}`);
        const official = raw.officialModel?.description || "";
        const observed = observedEquipmentCategory(raw.category, raw.location, raw.modelId);
        const description = [raw.description, raw.tooltip].filter(Boolean).join("\n");
        const evidence = sourceFields(raw, path);
        const result = {
          name: raw.name,
          path,
          category: observed,
          classificationEvidence: evidence,
        };
        if (/法宝|灵宝|神器|道具|材料|消耗品|上古玉魄|元身/.test(observed)) continue;
        if (raw.location === "RolePetShipin" || /(?:宝宝|召唤兽).*饰品/.test(observed)) continue;
        if (
          /(?:宝宝|召唤兽)装备/.test(observed) ||
          raw.location === "RolePetEquips" ||
          raw.attributes?.装备对象 === "召唤兽" ||
          /【装备对象】\s*召唤兽/.test(official)
        ) {
          add(petEquipment, { ...result, category: "召唤兽装备" }, raw);
          continue;
        }
        const officialJewelry = official.match(jewelryType)?.[1];
        if (
          officialJewelry ||
          isJewelryEquipment({
            category: observed,
            description,
            kindId: raw.kindId,
          })
        ) {
          add(
            jewelry,
            { ...result, category: `灵饰${officialJewelry ? ` · ${officialJewelry}` : ""}` },
            raw,
          );
          continue;
        }
        const wearer = !!raw.attributes?.装备角色?.trim() || /【装备角色】\s*[^#\s]/.test(official);
        const explicitCharacter =
          /^role_using_equip_[1-6]$/.test(raw.location || "") ||
          ordinaryCategory.test(observed) ||
          wearer;
        const normalizedCharacter =
          !!known &&
          !isJewelryEquipment(known) &&
          (ordinaryCategory.test(known.category) ||
            ((!!raw.attributes?.装备条件 || /【装备条件】/.test(official)) &&
              /锻炼等级\s*[:：]?\s*\d+\s+镶嵌宝石/.test(description)));
        if (explicitCharacter || normalizedCharacter) {
          add(
            equipment,
            {
              ...result,
              category: observed || known?.category || "人物装备",
              ...gemFacts(raw, path),
            },
            raw,
          );
        } else if (known || raw.kind === "equipment" || /锻炼等级|镶嵌宝石/.test(description))
          add(unclassified, { ...result, category: "装备类别待核实", ...gemFacts(raw, path) }, raw);
      }
    if (tab.name === "召唤兽/孩子")
      for (const [pi, pet] of (tab.pets || []).entries()) {
        const path = `/detail/tabs/${ti}/pets/${pi}`;
        pets.push({ name: pet.name, path, category: "召唤兽", classificationEvidence: [] });
        for (const [gi, raw] of pet.equipment.entries()) {
          if (raw.location === "RolePetShipin" || /饰品/.test(raw.category || "")) continue;
          const itemPath = `${path}/equipment/${gi}`;
          add(
            petEquipment,
            {
              name: raw.name,
              path: itemPath,
              category: "召唤兽装备",
              classificationEvidence: sourceFields(raw, itemPath),
            },
            raw,
          );
        }
      }
  }
  const fullCapture = !!record.detail && record.detail.captureMode !== "body";
  const genericEquipment = unclassified.filter(
    (item) =>
      item.gemEvidence.length > 0 &&
      item.classificationEvidence.some(
        (evidence) =>
          (evidence.path.endsWith("/attributes/装备条件") ||
            evidence.path.endsWith("/officialModel/description")) &&
          /(?:【装备条件】\s*)?等级\s*[:：]?\s*\d+/.test(evidence.quote),
      ),
  );
  const equipmentCaptureComplete = fullCapture && normalized.captureComplete;
  const petCaptureComplete = fullCapture && petCapture.captureComplete;
  const knownCount =
    equipment.length + jewelry.length + petEquipment.length + pets.length + genericEquipment.length;
  const missingItems = [
    ...equipment
      .filter((item) => item.gemLevel === null)
      .map(({ name, path }) => ({ name, path, reason: "宝石段数未读取或有冲突" })),
    ...unclassified
      .filter((item) => item.gemLevel !== 0)
      .map(({ name, path }) => ({ name, path, reason: "装备类别待核实" })),
  ];
  const knownSum = equipment.reduce((sum, item) => sum + (item.gemLevel ?? 0), 0);
  return {
    equipmentCaptureComplete,
    petCaptureComplete,
    equipment,
    jewelry,
    petEquipment,
    pets,
    unclassified,
    countSummary: {
      equipment: equipment.length,
      jewelry: jewelry.length,
      petEquipment: petEquipment.length,
      pets: pets.length,
      genericEquipment: genericEquipment.length,
      genericEquipmentPaths: genericEquipment.map((item) => item.path),
      knownTotal: knownCount,
      total:
        equipmentCaptureComplete &&
        petCaptureComplete &&
        unclassified.length === genericEquipment.length &&
        !issues.length
          ? knownCount
          : null,
    },
    gemSummary: {
      knownSum,
      total: equipmentCaptureComplete && !missingItems.length && !issues.length ? knownSum : null,
      missingItems,
      classificationComplete: !unclassified.length && !issues.length,
    },
    issues,
  };
}
