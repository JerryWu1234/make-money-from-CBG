import { createHash } from "node:crypto";
import type { DetailItem, SavedRoleRecord } from "../crawler/types";
import { parsePetGearAttributes } from "./pet-gear-match";
export { comparePetGear, parsePetGearAttributes } from "./pet-gear-match";
export type { PetGearAttributes } from "./pet-gear-match";
import { petInventory } from "./pet-pricing";
import { buildEquipmentEstimate } from "./pricing-estimate";
import type {
  EquipmentCandidate,
  EquipmentPricingItem,
  EquipmentPricingSnapshot,
} from "./equipment-pricing";
import {
  GLOBAL_MARKET_SCOPE_VERSION,
  MARKET_SEARCH_UI_VERSION,
  type GlobalMarketRequest,
} from "./market-scope";
import {
  candidateQuoteMatchesPrice,
  officialSourceIdentity,
  priceAverage,
  EQUIPMENT_QUOTE_LIMIT,
  EQUIPMENT_QUOTE_POLICY,
  pricingTimestampFresh,
} from "./pricing-integrity";

export const PET_GEAR_ACCOUNTING = "宝宝挂牌已包含穿戴装备；装备单独查价只作交叉核对，不重复相加";

export type PetGearPricingItem = EquipmentPricingItem & {
  petKey: string;
  petName: string;
  accessory: boolean;
  rawItem?: Pick<DetailItem, "index" | "modelId" | "kindId" | "location" | "attributes">;
  reason?: string;
  queriedAt?: string;
  searchStatus?:
    | "pending"
    | "completed"
    | "read_failed"
    | "unsupported"
    | "incomplete"
    | "untradable";
  scopeEvidence?: GlobalMarketRequest[];
};

export type PetGearPricingSnapshot = Omit<EquipmentPricingSnapshot, "items"> & {
  items: PetGearPricingItem[];
  accounting: string;
};

/** Gear references do not add to the parent pet's already inclusive listing price. */
export function petGearInventory(record: SavedRoleRecord) {
  const inventory = petInventory(record);
  const items: PetGearPricingItem[] = inventory.items.flatMap((pet) =>
    pet.equipment.map((gear, index) => {
      const rawPet = record.detail?.tabs
        .find((tab) => pet.key.startsWith(tab.name + ":"))
        ?.pets?.find((value) => pet.key === "召唤兽/孩子:" + value.index);
      const raw = rawPet?.equipment[index];
      const attributes = parsePetGearAttributes(gear.description);
      const issues = gear.accessory
        ? ["宝宝饰品不属于召唤兽装备搜索，保留未定价"]
        : attributes.issues;
      return {
        key: pet.key + ":gear:" + index,
        petKey: pet.key,
        petName: pet.name,
        name: gear.name,
        description: gear.description,
        level: attributes.level,
        category: "召唤兽装备",
        priceMethod: EQUIPMENT_QUOTE_POLICY,
        accessory: !!gear.accessory,
        ...(raw
          ? {
              rawItem: {
                index: raw.index,
                modelId: raw.modelId,
                kindId: raw.kindId,
                location: raw.location,
                attributes: raw.attributes,
              },
            }
          : {}),
        status: attributes.restricted ? "untradable" : issues.length ? "unsupported" : "no_match",
        issues: attributes.restricted ? [...issues, "绑定或专用宝宝装备不能套用交易价格"] : issues,
        query: "",
        referencePrice: null,
        candidates: [],
      };
    }),
  );
  const inputHash = createHash("sha256")
    .update(
      JSON.stringify({
        marketScope: GLOBAL_MARKET_SCOPE_VERSION,
        searchUI: MARKET_SEARCH_UI_VERSION,
        comparisonVersion: "pet-gear-identity-checked-average-v7",
        priceMethod: EQUIPMENT_QUOTE_POLICY,
        inputHash: inventory.inputHash,
        items,
      }),
    )
    .digest("hex");
  return { inputHash, captureComplete: inventory.captureComplete, issues: inventory.issues, items };
}

/** Keep fresh independent evidence; closest configuration scores never imply a price adjustment. */
export function selectPetGearCandidates(candidates: EquipmentCandidate[]): EquipmentCandidate[] {
  const now = Date.now();
  const fresh = candidates.filter((candidate) => {
    return (
      candidate.verified === true &&
      ["exact", "similar"].includes(candidate.matchType || "") &&
      candidate.priceType === "listing" &&
      candidate.price !== null &&
      Number.isFinite(candidate.price) &&
      candidate.price > 0 &&
      candidate.price <= 1e9 &&
      !!candidate.sourceHash &&
      candidateQuoteMatchesPrice(candidate) &&
      !!officialSourceIdentity(candidate.url) &&
      pricingTimestampFresh(candidate.fetchedAt, now)
    );
  });
  const distinct = new Map<string, EquipmentCandidate>();
  let conflict: EquipmentCandidate[] = [];
  for (const candidate of fresh) {
    const identity = officialSourceIdentity(candidate.url)!;
    const previous = distinct.get(identity);
    if (previous && previous.price !== candidate.price && !conflict.length)
      conflict = [previous, candidate];
    if (!previous) distinct.set(identity, candidate);
  }
  // Keep the order returned by the official search; prices and distance do not reorder it.
  const selected = [
    ...[...distinct.values()]
      .filter((candidate) => candidate.matchType === "exact")
      .slice(0, EQUIPMENT_QUOTE_LIMIT),
    ...[...distinct.values()]
      .filter((candidate) => candidate.matchType === "similar")
      .slice(0, EQUIPMENT_QUOTE_LIMIT),
  ];
  // Retain normal evidence alongside the conflict; a resumed cursor may skip these seen products.
  return [...selected, ...conflict.filter((candidate) => !selected.includes(candidate))];
}

export function petGearReference(candidates: EquipmentCandidate[]) {
  const selected = selectPetGearCandidates(candidates);
  const estimate = buildEquipmentEstimate(selected);
  const distinct = new Map<string, number>();
  for (const candidate of selected) {
    const identity = officialSourceIdentity(candidate.url)!;
    if (distinct.has(identity) && distinct.get(identity) !== candidate.price)
      return {
        referencePrice: null,
        similarEstimate: {
          ...estimate,
          status: "insufficient" as const,
          range: null,
          issues: ["同一宝宝装备的报价冲突，需重新读取"],
        },
      };
    distinct.set(identity, candidate.price!);
  }
  const average = priceAverage(
    selected
      .filter((candidate) => candidate.matchType === "exact")
      .map((candidate) => candidate.price!),
  );
  return {
    referencePrice:
      average !== null ? average : estimate.status === "range" ? estimate.average! : null,
    similarEstimate: estimate,
  };
}
