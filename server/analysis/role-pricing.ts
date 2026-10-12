import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SavedRoleRecord } from "../crawler/types";
import type { ValuationResult } from "./valuation-types";
import type { createRoleSource, RoleQueryObservation } from "./browser-role-source";
import { roleScopeEvidence } from "./browser-role-source";
import {
  ROLE_MARKET_POLICY,
  buildRoleMarketReference,
  compareRoleConfiguration,
  roleCore,
  roleSourceHash,
  type RoleMarketCandidate,
} from "./role-market";
import { ROLE_SEARCH_QUERY_POLICY } from "./role-search-query";
import {
  GLOBAL_MARKET_SCOPE_VERSION,
  MARKET_SEARCH_UI_VERSION,
  assertGlobalMarketRequest,
} from "./market-scope";
import { officialSourceIdentity, pricingTimestampFresh } from "./pricing-integrity";
import { buildProductDocument } from "./product-document";
import { equipmentInventory } from "./equipment-pricing";
import { petInventory } from "./pet-pricing";
import { parseEquipmentAttributes } from "./equip-attributes";

const orderedConfiguration = (value: unknown): unknown => {
  if (Array.isArray(value))
    return value
      .map(orderedConfiguration)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, orderedConfiguration(child)]),
    );
  return value;
};

/** Target rereads must keep the same price configuration; candidate tolerances do not apply. */
function targetConfiguration(record: SavedRoleRecord) {
  const equipment = equipmentInventory(record),
    pets = petInventory(record);
  return orderedConfiguration({
    core: roleCore(record),
    valuation: record.detail?.valuation?.fields,
    equipmentCaptureComplete: equipment.captureComplete,
    petCaptureComplete: pets.captureComplete,
    equipment: equipment.items.map((item) => ({
      name: item.name,
      category: item.category,
      level: item.level,
      modelId: item.modelId,
      kindId: item.kindId,
      attributes: parseEquipmentAttributes(item.description),
    })),
    pets: pets.items.map((item) => ({
      name: item.name,
      level: item.level,
      fields: item.fields,
      skills: item.skills,
      observations: item.skillObservations || [],
      innerSkills: item.innerSkills,
      equipment: item.equipment.map((gear) => ({
        name: gear.name,
        accessory: Boolean(gear.accessory),
        attributes: parseEquipmentAttributes(gear.description),
      })),
    })),
  });
}

export type RoleSearchResult = Awaited<
  ReturnType<Awaited<ReturnType<typeof createRoleSource>>["search"]>
>;
export type RoleMarketReference = {
  policyVersion: string;
  status: "range" | "insufficient";
  range: { min: number; max: number } | null;
  median: number | null;
  sampleCount: number;
  scope: string;
  issues: string[];
};
export type RolePricingSnapshot = {
  version: 1;
  inputHash: string;
  searchedAt: string;
  searchComplete: boolean;
  queried: boolean;
  target: { key: string; url: string; price: number | null; sourceHash: string };
  observedTarget?: SavedRoleRecord;
  marketReference: RoleMarketReference;
  candidates: RoleMarketCandidate[];
  form?: Pick<RoleSearchResult["form"], "action" | "act">;
  selections?: RoleSearchResult["selections"];
  queryGeneration?: RoleSearchResult["queryGeneration"];
  queryArgs: Record<string, unknown>;
  actualRequests: RoleQueryObservation[];
  pageAudits: RoleSearchResult["pageAudits"];
  pages: number;
  rows: number;
  details: number;
  exhausted: boolean;
  skipped: RoleSearchResult["skipped"];
  issues: string[];
};

/** Frozen target identity and both official search policies isolate old saved references. */
export function rolePricingInputHash(record: SavedRoleRecord) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        key: record.listing.key,
        sourceHash: buildProductDocument(record).contentHash,
        scope: GLOBAL_MARKET_SCOPE_VERSION,
        searchUI: MARKET_SEARCH_UI_VERSION,
        query: ROLE_SEARCH_QUERY_POLICY,
        comparison: ROLE_MARKET_POLICY,
      }),
    )
    .digest("hex");
}

const reference = (
  candidates: RoleMarketCandidate[],
  targetKey: string,
  now: number,
): RoleMarketReference => {
  const result = buildRoleMarketReference(candidates, targetKey, now);
  return {
    policyVersion: result.policyVersion,
    status: result.status === "range" ? "range" : "insufficient",
    range: result.status === "range" ? result.range : null,
    median:
      result.status === "range" && "median" in result && typeof result.median === "number"
        ? result.median
        : null,
    sampleCount: result.sampleCount,
    scope: result.scope,
    issues: result.issues,
  };
};

function validRecordIdentity(record: SavedRoleRecord, quoted = false) {
  const listing = record.listing;
  const source = record.detail?.valuation?.source;
  return (
    (!quoted ||
      (!!source &&
        String(source.serverId) === listing.serverId &&
        String(source.eid) === listing.eid &&
        Number(source.askingPrice) === Number(listing.price))) &&
    record.status === "complete" &&
    !!record.detail &&
    officialSourceIdentity(listing.url) === listing.key &&
    listing.key === listing.serverId + ":" + listing.eid &&
    officialSourceIdentity(record.detail.url) === listing.key
  );
}

/** Missing captured configuration is terminal for this frozen task, never an endless query retry. */
export function blockedRolePricing(record: SavedRoleRecord, now = Date.now()): RolePricingSnapshot {
  const match = compareRoleConfiguration(record, record);
  const price = Number(record.listing.price);
  const issues = [...match.reasons];
  if (!validRecordIdentity(record)) issues.push("目标角色身份或详情链接未核实");
  if (!Number.isFinite(price) || price <= 0 || price > 1e9) issues.push("目标角色挂牌价格无效");
  if (issues.length) issues.push("请先补采完整角色、装备与宝宝配置，再开始新批次核对整号市场参考");
  return {
    version: 1,
    inputHash: rolePricingInputHash(record),
    searchedAt: new Date(now).toISOString(),
    searchComplete: true,
    queried: false,
    target: {
      key: record.listing.key,
      url: record.listing.url,
      price: Number.isFinite(price) && price > 0 ? price : null,
      sourceHash: buildProductDocument(record).contentHash,
    },
    marketReference: { ...reference([], record.listing.key, now), issues },
    candidates: [],
    queryArgs: {},
    actualRequests: [],
    pageAudits: [],
    pages: 0,
    rows: 0,
    details: 0,
    exhausted: false,
    skipped: [],
    issues,
  };
}

function assertScope(snapshot: RolePricingSnapshot) {
  if (
    !snapshot.form ||
    !snapshot.form.act ||
    !snapshot.pages ||
    snapshot.pageAudits.length !== snapshot.pages
  )
    throw new Error("整号查价缺少逐页实际全服查询证据");
  const action = new URL(snapshot.form.action);
  if (action.origin !== "https://xyq.cbg.163.com" || action.username || action.password)
    throw new Error("整号查询表单不是已核实的官网来源");
  for (const [index, audit] of snapshot.pageAudits.entries()) {
    if (
      audit.page !== index + 1 ||
      !audit.marketRequests.length ||
      (index === 0 && !audit.requests.length)
    )
      throw new Error("整号查价页码或实际请求证据不完整");
    for (const [requests, act, initial] of [
      [audit.requests, snapshot.form.act, index === 0],
      [audit.marketRequests, "overall_search_role", false],
    ] as const)
      for (const request of requests) {
        const endpoint = new URL(request.endpoint);
        if (endpoint.origin !== "https://xyq.cbg.163.com" || endpoint.username || endpoint.password)
          throw new Error("整号实际查询来源不属于官网");
        if (initial && endpoint.origin + endpoint.pathname !== action.origin + action.pathname)
          throw new Error("整号实际表单提交与查询入口不一致");
        assertGlobalMarketRequest(roleScopeEvidence(request, initial), act, audit.page);
      }
  }
  if (
    !isDeepStrictEqual(
      snapshot.actualRequests,
      snapshot.pageAudits.flatMap((page) => [...page.requests, ...page.marketRequests]),
    )
  )
    throw new Error("整号查价实际请求与逐页证据不一致");
  assertGlobalMarketRequest(
    roleScopeEvidence({
      endpoint: action.href,
      act: "overall_search_role",
      args: { ...snapshot.queryArgs, page: 1 },
    }),
    "overall_search_role",
    1,
  );
}

/** Recheck saved references against the frozen task, including target and candidate freshness. */
export function validateRolePricing(
  snapshot: RolePricingSnapshot | undefined,
  record: SavedRoleRecord,
  now = Date.now(),
): boolean {
  try {
    if (
      !snapshot ||
      snapshot.version !== 1 ||
      snapshot.inputHash !== rolePricingInputHash(record) ||
      !snapshot.searchComplete ||
      !pricingTimestampFresh(snapshot.searchedAt, now) ||
      snapshot.target.key !== record.listing.key ||
      snapshot.target.url !== record.listing.url ||
      snapshot.target.sourceHash !== buildProductDocument(record).contentHash ||
      snapshot.target.price !==
        (Number(record.listing.price) > 0 ? Number(record.listing.price) : null)
    )
      return false;
    if (!snapshot.queried) {
      const blocked = blockedRolePricing(record, now);
      return (
        blocked.issues.length > 0 &&
        snapshot.candidates.length === 0 &&
        snapshot.pages === 0 &&
        snapshot.actualRequests.length === 0 &&
        snapshot.pageAudits.length === 0 &&
        isDeepStrictEqual(snapshot.marketReference, blocked.marketReference)
      );
    }
    const target = snapshot.observedTarget;
    if (
      !target ||
      !validRecordIdentity(target, true) ||
      target.listing.key !== record.listing.key ||
      Number(target.listing.price) !== Number(record.listing.price) ||
      !pricingTimestampFresh(target.detail!.collectedAt, now) ||
      !compareRoleConfiguration(record, target).verified ||
      !isDeepStrictEqual(targetConfiguration(record), targetConfiguration(target))
    )
      return false;
    assertScope(snapshot);
    for (const candidate of snapshot.candidates) {
      const matching = compareRoleConfiguration(record, candidate.record);
      const valid =
        candidate.key !== record.listing.key &&
        candidate.active &&
        candidate.serverAge === "older" &&
        validRecordIdentity(candidate.record, true) &&
        candidate.key === candidate.record.listing.key &&
        officialSourceIdentity(candidate.url) === candidate.key &&
        candidate.sourceHash === roleSourceHash(candidate.record) &&
        candidate.price === Number(candidate.record.listing.price) &&
        Number.isFinite(candidate.price) &&
        Number(candidate.price) > 0 &&
        Number(candidate.price) <= 1e9 &&
        pricingTimestampFresh(candidate.fetchedAt, now) &&
        pricingTimestampFresh(candidate.record.detail!.collectedAt, now) &&
        matching.verified;
      if (candidate.verified && !valid) return false;
    }
    return isDeepStrictEqual(
      snapshot.marketReference,
      reference(snapshot.candidates, record.listing.key, now),
    );
  } catch {
    return false;
  }
}

export function buildRolePricingSnapshot(
  record: SavedRoleRecord,
  result: RoleSearchResult,
  now = Date.now(),
): RolePricingSnapshot {
  const blocked = blockedRolePricing(record, now);
  const candidates = result.candidates.map((candidate) => {
    const match = compareRoleConfiguration(record, candidate.record);
    const invalid =
      candidate.key === record.listing.key ||
      !candidate.active ||
      candidate.serverAge !== "older" ||
      !validRecordIdentity(candidate.record, true) ||
      candidate.key !== candidate.record.listing.key ||
      officialSourceIdentity(candidate.url) !== candidate.key ||
      candidate.sourceHash !== roleSourceHash(candidate.record) ||
      candidate.price !== Number(candidate.record.listing.price) ||
      !Number.isFinite(candidate.price) ||
      Number(candidate.price) <= 0 ||
      Number(candidate.price) > 1e9 ||
      !pricingTimestampFresh(candidate.fetchedAt, now) ||
      !pricingTimestampFresh(candidate.record.detail?.collectedAt, now);
    return {
      ...candidate,
      ...match,
      verified: candidate.verified && match.verified && !invalid,
      reasons: [...match.reasons, ...(invalid ? ["来源身份、挂牌价或鲜活证据不一致，未采用"] : [])],
    };
  });
  const marketReference = reference(candidates, record.listing.key, now);
  const snapshot: RolePricingSnapshot = {
    ...blocked,
    queried: true,
    observedTarget: result.target,
    form: { action: result.form.action, act: result.form.act },
    selections: result.selections,
    queryGeneration: result.queryGeneration,
    queryArgs: result.queryArgs,
    actualRequests: result.actualRequests,
    pageAudits: result.pageAudits,
    pages: result.pages,
    rows: result.rows,
    details: result.details,
    exhausted: result.exhausted,
    skipped: result.skipped,
    candidates,
    marketReference,
    issues: marketReference.issues,
  };
  if (!validateRolePricing(snapshot, record, now))
    throw new Error("整号查价目标、相关性、挂牌价或全服来源证据未通过核验");
  return snapshot;
}

/** Whole-role listings already include assets. Attaching them must never alter any computed amount. */
export function attachRolePricing(
  result: ValuationResult,
  record: SavedRoleRecord,
  snapshot?: RolePricingSnapshot,
): ValuationResult {
  const valid = validateRolePricing(snapshot, record);
  const assets = [...equipmentInventory(record).items, ...petInventory(record).items]
    .filter((item) => item.status === "untradable")
    .map(({ key, name, category }) => ({
      key,
      name,
      roleUse: category + "；角色携带用途与价值影响需结合整号配置核验",
      individualPrice: null as null,
    }));
  const reference =
    valid && snapshot?.searchComplete && snapshot.marketReference.status === "range"
      ? snapshot.marketReference
      : undefined;
  const value = reference?.median ?? null;
  return {
    ...result,
    role_pricing: valid ? snapshot : undefined,
    ...(assets.length
      ? {
          special_asset_reference: {
            method: "whole-role-market" as const,
            assets,
            value,
            range: reference?.range ?? null,
            listingDifference:
              value !== null && result.asking_price !== null
                ? Math.round((value - result.asking_price) * 100) / 100
                : null,
            note: reference
              ? "专用/绑定资产分项价格未知；以配置核验通过的整号挂牌样本评估整体影响。整号参考独立展示，未与裸号或资产小计相加。"
              : "专用/绑定资产不能套用可交易同类价格，分项价格未知；尚缺配置核验通过的整号市场样本，整体价值影响待确认。",
          },
        }
      : {}),
  };
}

/** Send public evidence, not complete candidate/observed-target source records, to the AI. */
export function rolePricingPromptEvidence(snapshot?: RolePricingSnapshot) {
  if (!snapshot) return undefined;
  const { observedTarget: _target, candidates, ...publicEvidence } = snapshot;
  return {
    ...publicEvidence,
    candidates: candidates.map(({ record: _record, ...candidate }) => candidate),
  };
}
