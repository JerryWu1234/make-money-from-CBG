import { petBlessingState } from "../analysis/pet-match";
import {
  rememberPricingPage,
  resetPricingCursor,
  validPricingPageHistory,
} from "../analysis/pricing-progress";
import { createHash } from "node:crypto";
import { nativeAccess, nativeAccessOwner } from "../native-access";
import { officialGovernor } from "../official-access";
import type { AccessContext } from "../access";
import {
  beginObservedQuery,
  bindQuerySubject,
  finishObservedQuery,
  failPendingPageQuery,
  pageQueryProofs,
  querySubjectContext,
} from "../query-health/runtime";
import {
  type MarketCategory,
  type PageSnapshot,
  type SemanticTarget,
  UnsupportedAdapterOperation,
} from "./contracts";
import { withNativeWorkflow } from "./native-workflow";
import {
  nativeEquipmentActions,
  nativePetActions,
  nativePetGearPlan,
  nativePetGearActions,
} from "./native-market-actions";
import {
  assertEquipmentUIArguments,
  equipmentObservationSource,
  equipmentQuery,
  equipmentQueryPlan,
  isYuanshen,
  yuanshenQuery,
  type EquipmentSearchConfig,
} from "../analysis/browser-equipment-source";
import {
  assertPetUIArguments,
  petEvolutionPreview,
  petObservationSource,
  petQueries,
  type PetSearchConfig,
} from "../analysis/browser-pet-source";
import { jadeQuery, type JadeSearchConfig } from "../analysis/jade-query";
import {
  equipmentIdentity,
  isJewelryEquipment,
  pageText,
  safeEquipmentUrl,
  verifyEquipmentCandidate,
  type EquipmentCandidate,
  type EquipmentPricingItem,
  type EquipmentSearchCursor,
  type EquipmentSource,
  type PricingSearchProgress,
} from "../analysis/equipment-pricing";
import { verifyPetCandidate, type PetPricingItem, type PetSource } from "../analysis/pet-pricing";
import { comparePetGear, type PetGearPricingItem } from "../analysis/pet-gear-inventory";
import type { PetGearSearchResult } from "../analysis/browser-pet-gear-source";
import { EQUIPMENT_QUOTE_LIMIT } from "../analysis/pricing-integrity";

type Args = Record<string, string | number>;
type Market = NonNullable<PageSnapshot["market"]>;
type Kind = "equipment" | "pet" | "pet-gear";
type Item = EquipmentPricingItem | PetPricingItem | PetGearPricingItem;
type Plan = {
  item?: Item;
  category: MarketCategory;
  mode: "exact" | "similar" | "base-attributes";
  args: Args;
  actions: SemanticTarget[];
  sort?: string;
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const canonicalMarketUrl = (value: string) => {
  const source = new URL(safeEquipmentUrl(value));
  const result = new URL(source.origin + source.pathname);
  for (const key of ["s", "serverid", "server_id", "eid", "equip_id", "ordersn"]) {
    const value = source.searchParams.get(key);
    if (value !== null) result.searchParams.set(key, value);
  }
  return result.href;
};
const rowsDigest = (rows: Market["rows"]) =>
  digest(rows.map((row) => ({ ...row, url: canonicalMarketUrl(row.url) })));

const categoryFor = (kind: Kind, item: Item): MarketCategory =>
  kind !== "equipment"
    ? kind
    : isYuanshen(item as EquipmentPricingItem)
      ? "yuanshen"
      : item.category === "上古玉魄"
        ? "jade"
        : isJewelryEquipment(item)
          ? "jewelry"
          : "equipment";

/** Pure observation validators are shared with the Playwright source, including principal-product identity. */
export function nativeProductSource(snapshot: PageSnapshot, kind: Kind) {
  if (
    snapshot.access !== "normal" ||
    snapshot.loading ||
    !snapshot.visible ||
    !snapshot.marketProduct
  )
    throw new UnsupportedAdapterOperation("缺少完整主商品证据的原生查价详情");
  if (kind === "pet") {
    if (snapshot.marketProduct.kind !== "pet") throw new Error("原生详情不是目标宝宝商品");
    const observed = snapshot.marketProduct.observation as Parameters<
      typeof petObservationSource
    >[0];
    const evolution = observed.evolution ? petEvolutionPreview(observed.evolution) : undefined;
    if (
      evolution &&
      (!evolution.supported ||
        ((observed.futureSkills?.length || 0) > 0 && !evolution.names.length))
    )
      throw new Error(evolution.reason || "进化技能未完整核验");
    const blessing = petBlessingState(observed.fields);
    if (blessing.fields.length && blessing.state !== "absent")
      throw new Error("主宝宝赐福字段未完成独立可见核验，报价未采用");
    return petObservationSource(
      { ...observed, ...(evolution ? { expectedFutureSkills: evolution.names } : {}) },
      snapshot.url,
    );
  }
  if (
    snapshot.marketProduct.kind !== kind &&
    !(kind === "pet-gear" && snapshot.marketProduct.kind === "equipment")
  )
    throw new Error("原生详情主商品类别与目标不一致");
  return equipmentObservationSource(
    snapshot.marketProduct.observation as Parameters<typeof equipmentObservationSource>[0],
    snapshot.url,
    kind,
    snapshot.marketProduct.directPanel !== false,
  );
}

export async function nativePlans(
  kind: Kind,
  item: Item,
  serverId: string,
  market: Market,
): Promise<Plan[]> {
  const category = categoryFor(kind, item);
  const config = market.config || {};
  if (kind === "pet") {
    const pet = item as PetPricingItem;
    const directory = config as unknown as PetSearchConfig;
    if (!directory.names || !Array.isArray(directory.skills))
      throw new UnsupportedAdapterOperation("缺少官网宝宝配置目录的查询");
    return petQueries(pet, directory)
      .filter((step) => step.matchType !== "diagnostic")
      .map((step) => {
        const args = { ...step.args, serverid: serverId };
        return {
          item,
          category,
          mode: step.matchType as "exact" | "similar",
          args,
          actions: nativePetActions(pet, args),
        };
      });
  }
  if (kind === "pet-gear")
    return [false, true].map((similar) => {
      const plan = nativePetGearPlan(item as PetGearPricingItem, serverId, similar);
      if (plan.query.stone) {
        const choices =
          market.menus
            ?.find((menu) => menu.id === "xiangqian_stone_attr_panel")
            ?.choices.filter((choice) => choice.label === plan.query.stone) || [];
        if (choices.length !== 1)
          throw new UnsupportedAdapterOperation("精魄灵石目录不唯一的宝宝装备查询");
        plan.args.xiangqian_stone_attr = choices[0].value;
        plan.actions.push({
          kind: "market-choice",
          panel: "xiangqian_stone_attr_panel",
          values: [choices[0].value],
        });
      }
      const gear = item as PetGearPricingItem;
      const slot = gear.rawItem?.attributes?.装备类型 || gear.rawItem?.attributes?.部位;
      if (slot) {
        const choices =
          market.menus
            ?.find((menu) => menu.id === "EquipPosBox")
            ?.choices.filter((choice) => choice.label === slot) || [];
        if (choices.length === 1) {
          plan.args.equip_pos = choices[0].value;
          plan.actions.push({
            kind: "market-choice",
            panel: "EquipPosBox",
            values: [choices[0].value],
          });
        }
      }
      return {
        item,
        category,
        mode: similar ? "similar" : "exact",
        args: plan.args,
        actions: plan.actions,
      };
    });
  const equipment = item as EquipmentPricingItem;
  const namedIds = new Set<string>();
  for (const [key, models] of Object.entries(
    (config.autoSearch || {}) as Record<string, { label: string }[]>,
  )) {
    const match = key.match(/^(\d+)_(\d+)$/);
    if (
      match &&
      Number(match[1]) === equipment.level &&
      Array.isArray(models) &&
      models.some((model) => model.label === equipment.name)
    )
      namedIds.add(match[2]);
  }
  const observedKinds = (config.kinds || []) as EquipmentSearchConfig["kinds"];
  const directory = {
    ...config,
    ...(category !== "yuanshen"
      ? {
          namedKinds:
            namedIds.size === 1 ? observedKinds.filter(([id]) => namedIds.has(String(id))) : [],
        }
      : {}),
  } as unknown as EquipmentSearchConfig;
  if (!Array.isArray(directory.kinds))
    throw new UnsupportedAdapterOperation("缺少官网装备配置目录的查询");
  const steps =
    category === "yuanshen"
      ? [{ mode: "base-attributes" as const, args: yuanshenQuery(equipment, directory, serverId) }]
      : category === "jade"
        ? [
            {
              mode: "base-attributes" as const,
              args: {
                ...jadeQuery(equipment, config.jade as JadeSearchConfig).args,
                serverid: serverId,
              },
            },
          ]
        : equipmentQueryPlan(equipment, directory, serverId);
  if (category === "equipment") {
    const reason = equipmentQuery(equipment, directory, serverId).coreSkipReason;
    if (reason) throw new UnsupportedAdapterOperation(reason);
  }
  return Promise.all(
    steps.map(async (step) => {
      const initial = Object.keys(step.args).find((key) =>
        ["init_defense", "init_damage_raw", "init_wakan", "init_hp", "init_dex"].includes(key),
      );
      const label =
        initial &&
        (
          {
            init_defense: "初防",
            init_damage_raw: "初伤",
            init_wakan: "初灵",
            init_hp: "初血",
            init_dex: "初敏",
          } as Record<string, string>
        )[initial];
      return {
        item,
        category,
        ...step,
        actions: await nativeEquipmentActions(
          step.args,
          directory,
          category as Exclude<MarketCategory, "pet" | "pet-gear">,
        ),
        ...(label ? { sort: label + " ASC" } : {}),
      };
    }),
  );
}

async function createNativeMarket(
  kind: Kind,
  signal: AbortSignal,
  serverId: string,
  onProgress?: (value: PricingSearchProgress) => void,
) {
  if (!/^[1-9]\d*$/.test(serverId)) throw new Error("目标服务器ID无效");
  const adapter = await nativeAccess();
  const governor = officialGovernor();
  const owner = nativeAccessOwner();
  const subjects = new Map<string, object>();
  const cache = new Map<string, string>();
  let currentSubject: object | undefined;
  const scope = {
    context: () => (currentSubject ? querySubjectContext(currentSubject) : undefined),
  };
  let closed = false;
  const contextFor = (snapshot: PageSnapshot) => {
    let subject = subjects.get(snapshot.context.pageId);
    if (!subject) {
      subject = {};
      subjects.set(snapshot.context.pageId, subject);
    }
    const current = querySubjectContext(subject);
    if (!current || current.pageGeneration !== snapshot.context.pageGeneration) {
      const context: AccessContext = {
        ...owner,
        ...snapshot.context,
        actionId: snapshot.context.actionId || undefined,
        sourceKind: "extension-native-market-" + kind,
      };
      governor.registerPage(context);
      bindQuerySubject(subject, governor, context);
    }
    currentSubject = subject;
    return subject;
  };
  const act = async (target: SemanticTarget, local: AbortSignal) => {
    local.throwIfAborted();
    const before = await adapter.snapshot();
    contextFor(before);
    if (target.kind === "market-field" && before.formValues?.[target.field] === target.value)
      return before;
    if (
      target.kind === "market-choice" &&
      before.market?.menus
        ?.find((menu) => menu.id === target.panel)
        ?.choices.some((choice) => choice.value === target.values[0] && choice.selected)
    )
      return before;
    return adapter.query(target, { kind: "changed" }, local);
  };
  const enter = async (category: MarketCategory, local: AbortSignal) => {
    let snapshot = await adapter.snapshot();
    if (!snapshot.market && snapshot.productIdentity) snapshot = await adapter.returnToList(local);
    contextFor(snapshot);
    if (snapshot.market?.category === category) return snapshot;
    return act({ kind: "market-entry", category }, local);
  };
  const queryPage = async (
    plan: Plan,
    page: number,
    local: AbortSignal,
    diagnostic = false,
    override?: Args,
  ): Promise<PageSnapshot> => {
    const entry = await enter(plan.category, local);
    const args = override || plan.args;
    const subject = contextFor(entry);
    const health = diagnostic
      ? undefined
      : beginObservedQuery(subject, {
          category: plan.category,
          server: serverId,
          serverAge: String(args.server_type || ""),
          conditions: args,
          page,
          sort: plan.sort || "default",
        });
    const context = querySubjectContext(subject)!;
    adapter.beginQuery(context.runId, context.queryId);
    if (!diagnostic || override) {
      const targets = override
        ? kind === "equipment"
          ? await nativeEquipmentActions(
              args,
              entry.market?.config as unknown as EquipmentSearchConfig,
              plan.category as Exclude<MarketCategory, "pet" | "pet-gear">,
            )
          : kind === "pet" && plan.item
            ? nativePetActions(plan.item as PetPricingItem, args)
            : nativePetGearActions(args)
        : plan.actions;
      if (!targets) throw new UnsupportedAdapterOperation("未保存官方控件计划的宽条件对照");
      for (const target of targets) {
        if (target.kind === "market-field" && target.field === "ovarall_sel_server") {
          const areas = entry.market?.config?.serverAreas as Record<string, string> | undefined;
          const area = areas?.[serverId];
          if (!area) throw new UnsupportedAdapterOperation("没有目标服务器实际区服目录的原生选择");
          await act({ kind: "market-field", field: "overall_sel_area", value: area }, local);
        }
        await act(target, local);
      }
    }
    let result = await act({ kind: "market-submit", category: plan.category }, local);
    if (plan.sort && result.market?.rows.length) {
      let key: string | undefined;
      let confirmed = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        result = await act({ kind: "sort", value: plan.sort }, local);
        const order = result.market?.order.toUpperCase().match(/^(.+) (ASC|DESC)$/);
        const requestOrder = (
          result.market as (Market & { requestOrder?: string }) | undefined
        )?.requestOrder?.toUpperCase();
        if (
          !order ||
          (key && key !== order[1]) ||
          requestOrder !== result.market?.order.toUpperCase()
        )
          throw new Error("原生装备排序控件与实际查询排序未关联，报价未采用");
        key = order[1];
        if (order[2] === "ASC") {
          confirmed = true;
          break;
        }
      }
      if (!confirmed) throw new Error("原生装备初始属性未确认升序，报价未采用");
    }
    if (page !== 1) result = await act({ kind: "market-page", page }, local);
    if (!result.market) throw new UnsupportedAdapterOperation("原生市场查询结果读取");
    if (kind === "pet") assertPetUIArguments(args, result.market.conditions);
    else assertEquipmentUIArguments(args, result.market.conditions);
    if (
      result.market.rows.some(
        (row) => equipmentIdentity(safeEquipmentUrl(row.url)).split(":")[0] !== serverId,
      )
    )
      throw new Error("原生市场列表包含目标单服以外的商品，报价未采用");
    const evidence = {
      count: result.market.rows.length,
      loaded: !result.loading,
      committed: result.market.committed,
      emptyMarker: result.market.empty,
      identityMatched: result.market.page === page && result.market.category === plan.category,
      blocked: !["normal", "unknown"].includes(result.access),
    };
    if (!diagnostic)
      await finishObservedQuery(
        subject,
        health,
        evidence,
        async (identity) => {
          const same = JSON.stringify(identity.conditions) === JSON.stringify(plan.args);
          const checked = await queryPage(
            plan,
            identity.page,
            local,
            true,
            same ? undefined : identity.conditions,
          );
          return {
            ...evidence,
            count: checked.market?.rows.length ?? -1,
            loaded: !checked.loading,
            committed: checked.market?.committed === true,
            emptyMarker: checked.market?.empty === true,
            identityMatched: checked.market?.page === identity.page,
            blocked: !["normal", "unknown"].includes(checked.access),
          };
        },
        { pageNumber: page, mode: plan.mode },
      );
    return result;
  };
  const readCandidate = async (url: string, local: AbortSignal) => {
    const safe = canonicalMarketUrl(url);
    const identity = equipmentIdentity(safe);
    if (identity.split(":")[0] !== serverId) throw new Error("原生详情候选不属于目标服");
    if (cache.has(safe)) return cache.get(safe)!;
    const [server, eid] = identity.split(":");
    const observed = await adapter.query(
      { kind: "listing-detail", serverId: server, eid },
      { kind: "detail", serverId: server, eid },
      local,
    );
    const source = nativeProductSource(observed, kind);
    cache.set(safe, source.html);
    return source.html;
  };
  const find = async (items: Item[], requestSignal: AbortSignal) =>
    withNativeWorkflow(
      AbortSignal.any([signal, requestSignal]),
      async () => {
        const local = AbortSignal.any([signal, requestSignal]);
        local.throwIfAborted();
        if (adapter.status().idle) await adapter.resumeForRun();
        if (closed) throw new Error("原生市场查询源已关闭");
        const queries: string[] = [];
        const searchItems: unknown[] = [];
        const results: any[] = [];
        const proofs: AccessContext[] = [];
        for (const item of items) {
          const entry = await enter(categoryFor(kind, item), local);
          if (!entry.market) throw new UnsupportedAdapterOperation("尚未进入官网市场表单");
          const plans = await nativePlans(kind, item, serverId, entry.market);
          const planHash = digest({
            version: "native-market-v1",
            kind,
            plans: plans.map(({ category, mode, args, sort }) => ({ category, mode, args, sort })),
          });
          const saved = item.searchCursor;
          const cursor: EquipmentSearchCursor =
            saved?.version === 1 && saved.planHash === planHash && validPricingPageHistory(saved)
              ? structuredClone(saved)
              : {
                  version: 1,
                  planHash,
                  modeIndex: 0,
                  pageNumber: 1,
                  rowIndex: 0,
                  pageRowsHash: "",
                  seen: [],
                  failed: [],
                  pageHistory: [],
                };
          const candidates: EquipmentCandidate[] = [];
          // A cursor is trusted only after every previously accepted page has been re-observed.
          for (const history of (cursor.pageHistory || []).slice()) {
            const replay = await queryPage(plans[history.modeIndex], history.pageNumber, local);
            if (rowsDigest(replay.market!.rows) !== history.rowsHash) {
              resetPricingCursor(cursor);
              break;
            }
          }
          // Quotes restored from a previous invocation are independently re-read from their original current list.
          const oldCandidates = new Map(
            (item.candidates || [])
              .filter((candidate) => candidate.verified)
              .map((candidate) => [equipmentIdentity(candidate.url), candidate]),
          );
          for (const history of (cursor.pageHistory || []).slice()) {
            const replay = await queryPage(plans[history.modeIndex], history.pageNumber, local);
            for (const row of replay.market!.rows) {
              const old = oldCandidates.get(equipmentIdentity(row.url));
              if (!old) continue;
              const html = await readCandidate(row.url, local);
              const quote = pageText(html).trim();
              const price = Number(quote.match(/挂牌价：¥(\d+(?:\.\d+)?)/)?.[1]) || null;
              const observed = { ...old, price, quote };
              const checked =
                kind === "equipment"
                  ? verifyEquipmentCandidate(
                      item as EquipmentPricingItem,
                      observed,
                      html,
                      new Date().toISOString(),
                    )
                  : kind === "pet"
                    ? verifyPetCandidate(
                        item as PetPricingItem,
                        observed,
                        html,
                        new Date().toISOString(),
                        plans[history.modeIndex].mode === "exact" ? "exact" : "similar",
                      )
                    : undefined;
              if (checked?.verified) candidates.push(checked);
              if (kind === "pet-gear") {
                const match = comparePetGear(
                  item as PetGearPricingItem,
                  quote.split("\n")[0].trim(),
                  pageText(
                    html.match(/<pre data-cbg-equipment-description>([\s\S]*?)<\/pre>/)?.[1] || "",
                  ),
                );
                if (match.matchType && /(?:^|\n)\s*在售(?:\s*\n|$)/.test(quote))
                  candidates.push({
                    ...observed,
                    verified: true,
                    matchType: match.matchType,
                    differences: match.differences,
                    similarityScore: match.similarityScore,
                    fetchedAt: new Date().toISOString(),
                    sourceHash: digest(html),
                  });
              }
              oldCandidates.delete(equipmentIdentity(row.url));
              await queryPage(plans[history.modeIndex], history.pageNumber, local);
            }
          }
          if (oldCandidates.size) resetPricingCursor(cursor);
          let completed = false;
          let pages = 0;
          for (; cursor.modeIndex < plans.length; cursor.modeIndex++) {
            const plan = plans[cursor.modeIndex];
            const text =
              "目标单服 " +
              serverId +
              " / 原生官网控件 / " +
              item.name +
              " / " +
              JSON.stringify(plan.args);
            queries.push(text);
            let snapshot = await queryPage(plan, cursor.pageNumber, local);
            let market = snapshot.market!;
            const rowsHash = rowsDigest(market.rows);
            if (cursor.pageRowsHash && cursor.pageRowsHash !== rowsHash) {
              cursor.rowIndex = 0;
              cursor.seen = [];
              cursor.failed = [];
            }
            cursor.pageRowsHash = rowsHash;
            if (!rememberPricingPage(cursor, cursor.modeIndex, cursor.pageNumber, rowsHash))
              throw new Error("原生市场历史页发生变化，已保留旧进度");
            let inspected = cursor.seen.filter((value) =>
              value.startsWith(cursor.modeIndex + "|"),
            ).length;
            for (
              let index = cursor.rowIndex;
              index < market.rows.length && inspected < EQUIPMENT_QUOTE_LIMIT;
              index++
            ) {
              const row = market.rows[index];
              let html: string;
              try {
                html = await readCandidate(row.url, local);
              } catch (error) {
                cursor.failed = [{ url: row.url, modeIndex: cursor.modeIndex }];
                throw error;
              }
              const quote = pageText(html).trim();
              const price = Number(quote.match(/挂牌价：¥(\d+(?:\.\d+)?)/)?.[1]) || null;
              let candidate: EquipmentCandidate = {
                url: canonicalMarketUrl(row.url),
                title: row.name,
                price,
                priceType: "listing",
                quote,
                verified: false,
                reason: "",
                fetchedAt: null,
                sourceHash: null,
              };
              if (kind === "equipment")
                candidate = verifyEquipmentCandidate(
                  item as EquipmentPricingItem,
                  candidate,
                  html,
                  new Date().toISOString(),
                );
              else if (kind === "pet")
                candidate = verifyPetCandidate(
                  item as PetPricingItem,
                  candidate,
                  html,
                  new Date().toISOString(),
                  plan.mode === "exact" ? "exact" : "similar",
                );
              else {
                const match = comparePetGear(
                  item as PetGearPricingItem,
                  quote.split("\n")[0].trim(),
                  pageText(
                    html.match(/<pre data-cbg-equipment-description>([\s\S]*?)<\/pre>/)?.[1] || "",
                  ),
                );
                candidate = {
                  ...candidate,
                  verified: !!match.matchType && /(?:^|\n)\s*在售(?:\s*\n|$)/.test(quote),
                  reason: match.reason || "独立主商品已核对",
                  ...(match.matchType
                    ? {
                        matchType: match.matchType,
                        similarityScore: match.similarityScore,
                        differences: match.differences,
                      }
                    : {}),
                  fetchedAt: new Date().toISOString(),
                  sourceHash: digest(html),
                };
              }
              if (candidate.verified) candidates.push(candidate);
              // Re-enter by visible website navigation, then verify the same list before another row or commit.
              snapshot = await queryPage(plan, cursor.pageNumber, local);
              market = snapshot.market!;
              if (rowsDigest(market.rows) !== rowsHash)
                throw new Error("详情返回后原生列表发生变化，已保留原游标等待核实");
              cursor.rowIndex = index + 1;
              cursor.seen.push(cursor.modeIndex + "|" + row.url);
              inspected++;
              onProgress?.({
                assetName: item.name,
                page: cursor.pageNumber,
                validSamples: candidates.length,
                retryCount: 0,
              });
            }
            if (currentSubject) proofs.push(...pageQueryProofs(currentSubject));
            pages++;
            searchItems.push({
              key: item.key,
              act: {
                equipment: "overall_search_equip",
                jewelry: "overall_search_lingshi",
                yuanshen: "overall_search_yuanshen",
                jade: "yupo_search",
                pet: "overall_search_pet",
                "pet-gear": "overall_search_pet_equip",
              }[plan.category],
              args: plan.args,
              mode: plan.mode,
              page: cursor.pageNumber,
              rows: market.rows.length,
              exhausted: cursor.pageNumber >= market.totalPages,
              sampleLimit: EQUIPMENT_QUOTE_LIMIT,
              sampled: inspected,
              samplingComplete: inspected >= EQUIPMENT_QUOTE_LIMIT,
              detailFailures: [],
              unsupportedDetails: [],
              native: true,
            });
            // The five-row policy is a per-condition cap, matching the ordinary pricing source.
            if (inspected >= EQUIPMENT_QUOTE_LIMIT || cursor.pageNumber >= market.totalPages) {
              cursor.pageNumber = 1;
              cursor.rowIndex = 0;
              cursor.pageRowsHash = "";
              if (candidates.length) {
                completed = true;
                break;
              }
              continue;
            }
            cursor.pageNumber++;
            cursor.rowIndex = 0;
            cursor.pageRowsHash = "";
            if (pages >= 3) break;
            cursor.modeIndex--;
          }
          completed ||= cursor.modeIndex >= plans.length;
          results.push({
            key: item.key,
            candidates,
            query: queries.at(-1),
            searchState: completed ? "completed" : "pending",
            searchStatus: completed ? "completed" : "pending",
            ...(!completed ? { searchCursor: cursor } : {}),
            scopeEvidence: [],
            note: completed ? "原生官网查询与独立详情已核验" : "已保留原生官网分页进度",
          });
        }
        return { queries, items: results, searchItems, accessProofs: proofs.slice(-1) };
      },
      scope,
    ).catch((error) => {
      if (currentSubject) failPendingPageQuery(currentSubject);
      throw error;
    });
  return {
    close: async () => {
      closed = true;
    },
    findCandidates: find,
    readSource: async (url: string, requestSignal: AbortSignal) => {
      AbortSignal.any([signal, requestSignal]).throwIfAborted();
      const value = cache.get(canonicalMarketUrl(url));
      if (!value) throw new UnsupportedAdapterOperation("没有当前列表与独立详情证据的任意候选读取");
      return value;
    },
    discover: async (item?: Item, requestSignal?: AbortSignal) =>
      withNativeWorkflow(
        AbortSignal.any([signal, ...(requestSignal ? [requestSignal] : [])]),
        async () => {
          if (adapter.status().idle) await adapter.resumeForRun();
          const category = item ? categoryFor(kind, item) : kind;
          const snapshot = await enter(category, requestSignal || signal);
          if (!snapshot.market?.form)
            throw new UnsupportedAdapterOperation("没有实际公共DOM表单证据的发现接口");
          return snapshot.market.form;
        },
        scope,
      ),
  };
}
export const createNativeEquipmentSource = (
  signal: AbortSignal,
  serverId: string,
  progress?: (value: PricingSearchProgress) => void,
) =>
  createNativeMarket("equipment", signal, serverId, progress) as Promise<
    EquipmentSource & {
      close(): Promise<void>;
      discover: (...args: any[]) => Promise<import("./contracts").NativeMarketForm>;
    }
  >;
export const createNativePetSource = (signal: AbortSignal, serverId: string) =>
  createNativeMarket("pet", signal, serverId) as Promise<
    PetSource & {
      close(): Promise<void>;
      discover: (...args: any[]) => Promise<import("./contracts").NativeMarketForm>;
    }
  >;
export const createNativePetGearSource = (signal: AbortSignal, serverId: string) =>
  createNativeMarket("pet-gear", signal, serverId) as Promise<{
    findCandidates(items: PetGearPricingItem[], signal: AbortSignal): Promise<PetGearSearchResult>;
    close(): Promise<void>;
    discover(): Promise<import("./contracts").NativeMarketForm>;
  }>;
