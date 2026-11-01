import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setImmediate as yieldThread } from "node:timers/promises";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { AiProvider } from "../ai/types";
import { aiRequestMessage } from "../ai/request-error";
import type { AnalysisBackoff } from "./rate-limit";
import type { Listing, SavedRoleRecord } from "../crawler/types";
import { analysisPrompt, RULE_VERSION, textHash } from "./contract";
import { analysisDataHash, buildProductDocument } from "./product-document";
import {
  bodyReviewVersionCompatible,
  recalculateReviewedBody,
  valuationPrompt,
  validateValuation,
} from "./valuation-contract";
import { BARE_ROLE_TEMPLATE } from "./bare-role-prompt";
import { inventoryMatchesSnapshot, validateExactPricing } from "./pricing-integrity";
import type { AnalysisProfile } from "./valuation-types";
import type { ProductDocument } from "./product-document";
import { equipmentInventory, type EquipmentPricingSnapshot } from "./equipment-pricing";
import { petInventory, type PetPricingSnapshot } from "./pet-pricing";
import { petGearInventory } from "./pet-gear-inventory";
import { validateSampleSelection } from "./sample-selection";
import { captureIssues } from "../crawler/capture-readiness";
import { isCurrentRoleCapture } from "../crawler/role-identity";
import { capturedAssetCounts, capturedAssetSummary } from "./asset-counts";
import { recommendationFor } from "./recommendation";
import { analysisConcurrency, analysisLaneLimits, DEFAULT_ANALYSIS_CONCURRENCY } from "./types";
import { automaticMarketExpired } from "./market";
import { trackRecordVersions } from "../record-versions";
import { installSourceMatches } from "./source-matches";
import type {
  AnalysisLane,
  AnalysisDetail,
  AnalysisItem,
  AnalysisOverview,
  AnalysisProgress,
  AnalysisRun,
  ProductAnalysis,
} from "./types";

type Row = Record<string, SQLOutputValue>;
export type AnalysisTask = {
  id: string;
  runId: string;
  lane: AnalysisLane;
  document: ProductDocument;
  record: SavedRoleRecord;
  prompt: string;
  attempts: number;
  profile: AnalysisProfile | null;
  lastError: string | null;
  lastAttemptHadResponse?: boolean;
  equipmentPricing?: EquipmentPricingSnapshot;
  petPricing?: PetPricingSnapshot;
  previousResult?: ProductAnalysis;
};
const now = () => new Date().toISOString();
const nullable = (value: SQLOutputValue | undefined) => (value == null ? null : String(value));
// Invalidate checkpoints when review semantics change; pricing versions live in the frozen profile.
const checkpointKey = (provider: string, model: string, profile: string | null) =>
  textHash(JSON.stringify(["analysis-checkpoint-v1", RULE_VERSION, provider, model, profile]));
const currentCheckpointSql = `c.listing_key=l.key AND c.validation_key=?
  AND c.listing_revision=(SELECT revision FROM record_versions WHERE entity='listings' AND record_key=l.key)
  AND c.valid_until>? AND c.result_task_id IS NOT NULL AND c.proof_id IS NOT NULL
  AND EXISTS(SELECT 1 FROM analysis_tasks checked WHERE checked.id=c.result_task_id AND checked.status='completed' AND checked.analysis_data_hash IS NOT NULL)
  AND c.result_revision=(SELECT revision FROM record_versions WHERE entity='analysis_tasks' AND record_key=c.result_task_id)
  AND c.proof_revision=(SELECT revision FROM record_versions WHERE entity='analysis_attempts' AND record_key=c.proof_id)`;
const expiredPricingTimeSql = (column: string, path: string) => {
  const time = `julianday(json_extract(${column},'${path}.searchedAt'))`;
  return `(${time} IS NULL OR ${time}<=julianday('now','-24 hours') OR ${time}>julianday('now','+1 minute'))`;
};
const expiredPricingSql = ["equipment_pricing", "pet_pricing", "pet_pricing.gearPricing"]
  .map((key) => {
    return `(json_type(t.result_json,'$.valuation.${key}')='object' AND ${expiredPricingTimeSql("t.result_json", "$.valuation." + key)})`;
  })
  .join(" OR ");
const matchingSourceSql =
  "coalesce((SELECT m.matches FROM analysis_source_matches m WHERE m.task_id=t.id AND m.listing_key=l.key),0)=1";
const stateSql = `CASE WHEN l.status!='complete' OR l.detail_json IS NULL THEN 'waiting_detail'
  WHEN t.id IS NULL THEN 'ready'
  WHEN NOT (${matchingSourceSql}) THEN 'stale'
  WHEN t.status='completed' AND (${expiredPricingSql}) THEN 'stale'
  ELSE t.status END`;

function overviewResult(result: ProductAnalysis | null, summary: boolean): ProductAnalysis | null {
  if (!summary || !result) return result;
  const value = result.valuation;
  return {
    ...result,
    dimensions: result.dimensions
      ? {
          foundation: { ...result.dimensions.foundation, evidence: [] },
          equipment: { ...result.dimensions.equipment, evidence: [] },
          pets: { ...result.dimensions.pets, evidence: [] },
        }
      : result.dimensions,
    ...(value
      ? {
          valuation: {
            ...value,
            items: (value.items ?? []).map((item) => ({
              ...item,
              input: "",
              formula: "",
              evidence: [],
            })),
            extracted_facts: undefined,
            ai_explanation: undefined,
            equipment_pricing: value.equipment_pricing
              ? {
                  ...value.equipment_pricing,
                  items: [],
                  queries: [],
                  rawResponse: "",
                  searchItems: [],
                  searchAttempts: [],
                  requestText: undefined,
                }
              : undefined,
            pet_pricing: value.pet_pricing
              ? {
                  ...value.pet_pricing,
                  items: [],
                  queries: [],
                  rawResponse: "",
                  searchItems: [],
                  searchAttempts: [],
                  requestText: undefined,
                  gearPricing: undefined,
                }
              : undefined,
          },
        }
      : {}),
  };
}

function profileScope(
  value: AnalysisProfile | null | undefined,
  serverId: string,
  listingKey: string,
) {
  const configured = value?.settings.servers.find((server) => server.serverId === serverId);
  const source = value?.marketSources?.find((server) => server.serverId === serverId);
  const { serverName: _name, fetchedAt: _at, sources: _sources, ...automatic } = source || {};
  const servers = configured ? [configured] : source ? [automatic] : [];
  // Only this role's server affects its calculation; other servers and source bookkeeping do not.
  return value
    ? {
        version: value.version,
        template: value.template,
        calculationVersion: value.calculationVersion,
        calculationCompatible: value.calculationCompatible,
        ascendedSchoolFormulaConfirmation:
          value.ascendedSchoolFormulaConfirmations?.[listingKey] || null,
        equipmentSearch: !!value.equipmentSearch,
        petSearch: !!value.petSearch,
        petGearSearch: !!value.petGearSearch,
        settings: {
          ...value.settings,
          servers,
        },
      }
    : null;
}

function bodyReviewScope(value: AnalysisProfile, serverId: string, listingKey: string) {
  const {
    settings: _settings,
    calculationVersion: _version,
    ...review
  } = profileScope(value, serverId, listingKey)!;
  return {
    ...review,
    // This pricing-only migration does not change the bare-role fact review.
    template: review.template.replace(
      "确认具有“靓号特效：土豪金”时加 1400 元。",
      "确认具有“靓号特效：土豪金”时加 800 元。",
    ),
  };
}

export class AnalysisStore {
  private recommendationCache = new Map<
    string,
    {
      signature: string;
      recommendation?: AnalysisItem["recommendation"];
      assetSummary?: AnalysisItem["assetSummary"];
    }
  >();
  private overviewRequests = new Map<
    string,
    {
      promise: Promise<AnalysisOverview>;
      controller: AbortController;
      readers: number;
    }
  >();
  constructor(
    readonly db: DatabaseSync,
    options: { readOnly?: boolean } = {},
  ) {
    if (options.readOnly) return;
    db.exec(`CREATE TABLE IF NOT EXISTS analysis_runs (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, rule_version TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT
    );
    CREATE TABLE IF NOT EXISTS analysis_tasks (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, ordinal INTEGER NOT NULL, listing_key TEXT NOT NULL,
      queue_lane TEXT NOT NULL DEFAULT 'old',
      input_hash TEXT NOT NULL, input_text TEXT NOT NULL, prompt_hash TEXT NOT NULL, prompt_text TEXT NOT NULL,
      source_listing_json TEXT NOT NULL, source_detail_json TEXT NOT NULL, collected_at TEXT NOT NULL,
      status TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, reused INTEGER NOT NULL DEFAULT 0,
      result_json TEXT, completed_at TEXT, error TEXT, source_task_id TEXT, UNIQUE(run_id,listing_key)
    );
    CREATE INDEX IF NOT EXISTS analysis_tasks_run ON analysis_tasks(run_id,ordinal);
    CREATE INDEX IF NOT EXISTS analysis_tasks_input ON analysis_tasks(input_hash,status);
    CREATE INDEX IF NOT EXISTS analysis_tasks_listing ON analysis_tasks(listing_key,status,completed_at DESC);
    CREATE INDEX IF NOT EXISTS analysis_completed_listings ON analysis_tasks(listing_key,completed_at DESC,id DESC,run_id)
      WHERE status='completed' AND result_json IS NOT NULL;
    CREATE TABLE IF NOT EXISTS recommendation_views (listing_key TEXT PRIMARY KEY, viewed_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS analysis_attempts (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL,
      finished_at TEXT, raw_response TEXT, usage_json TEXT, error TEXT
    );
    CREATE INDEX IF NOT EXISTS analysis_attempts_task ON analysis_attempts(task_id,created_at DESC,id DESC);
    CREATE TABLE IF NOT EXISTS analysis_lock (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS analysis_provider_backoff (provider TEXT PRIMARY KEY, state_json TEXT NOT NULL);`);
    if (
      !db
        .prepare("PRAGMA table_info(analysis_tasks)")
        .all()
        .some((column) => column.name === "source_task_id")
    )
      db.exec("ALTER TABLE analysis_tasks ADD COLUMN source_task_id TEXT");
    if (
      !db
        .prepare("PRAGMA table_info(analysis_tasks)")
        .all()
        .some((column) => column.name === "queue_lane")
    )
      db.exec("ALTER TABLE analysis_tasks ADD COLUMN queue_lane TEXT NOT NULL DEFAULT 'old'");
    for (const [table, column] of [
      ["analysis_runs", "profile_json"],
      ["analysis_runs", "follow_capture"],
      ["analysis_runs", "concurrency"],
      ["analysis_tasks", "pricing_progress_json"],
      ["analysis_tasks", "asset_counts_json"],
      ["analysis_attempts", "request_text"],
      ["analysis_attempts", "request_hash"],
      ["analysis_tasks", "equipment_pricing_json"],
      ["analysis_tasks", "pet_pricing_json"],
      ["analysis_tasks", "analysis_data_hash"],
    ]) {
      if (
        !db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((row) => row.name === column)
      )
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    }
    db.exec(
      "CREATE INDEX IF NOT EXISTS analysis_tasks_run_status ON analysis_tasks(run_id,status,queue_lane,reused,id)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS analysis_tasks_data ON analysis_tasks(listing_key,analysis_data_hash,status)",
    );
    trackRecordVersions(db, "analysis_tasks");
    trackRecordVersions(db, "analysis_attempts");
    installSourceMatches(db);
    db.exec(`CREATE TABLE IF NOT EXISTS analysis_capture_checks (
      run_id TEXT NOT NULL, listing_key TEXT NOT NULL, listing_revision INTEGER NOT NULL,
      result_task_id TEXT, result_revision INTEGER, proof_id TEXT, proof_revision INTEGER,
      valid_until INTEGER NOT NULL, validation_key TEXT, PRIMARY KEY(run_id,listing_key)
    );
    CREATE TRIGGER IF NOT EXISTS analysis_capture_checks_delete AFTER DELETE ON analysis_runs BEGIN
      DELETE FROM analysis_capture_checks WHERE run_id=OLD.id;
    END;`);
    if (
      !db
        .prepare("PRAGMA table_info(analysis_capture_checks)")
        .all()
        .some((row) => row.name === "validation_key")
    )
      db.exec("ALTER TABLE analysis_capture_checks ADD COLUMN validation_key TEXT");
    db.exec(
      "CREATE INDEX IF NOT EXISTS analysis_capture_checks_current ON analysis_capture_checks(listing_key,validation_key)",
    );
    db.exec(`CREATE TRIGGER IF NOT EXISTS analysis_checkpoint_profile_update
      AFTER UPDATE OF provider,model,profile_json ON analysis_runs
      WHEN OLD.provider IS NOT NEW.provider OR OLD.model IS NOT NEW.model OR OLD.profile_json IS NOT NEW.profile_json BEGIN
        UPDATE analysis_capture_checks SET validation_key=NULL WHERE run_id=NEW.id OR result_task_id IN
          (SELECT id FROM analysis_tasks WHERE run_id=NEW.id);
      END;`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS analysis_asset_counts_invalidate
      AFTER UPDATE OF source_listing_json,source_detail_json ON analysis_tasks
      WHEN OLD.source_listing_json IS NOT NEW.source_listing_json OR OLD.source_detail_json IS NOT NEW.source_detail_json BEGIN
        UPDATE analysis_tasks SET asset_counts_json=NULL WHERE id=NEW.id;
      END;`);
    this.recover();
  }
  acquire(owner: string) {
    return (
      this.db
        .prepare(
          `INSERT INTO analysis_lock VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE analysis_lock.expires_at<? OR analysis_lock.owner=?`,
        )
        .run(owner, Date.now() + 120_000, Date.now(), owner).changes === 1
    );
  }
  owns(owner: string) {
    return !!this.db
      .prepare("SELECT 1 FROM analysis_lock WHERE owner=? AND expires_at>?")
      .get(owner, Date.now());
  }
  release(owner: string) {
    this.db.prepare("DELETE FROM analysis_lock WHERE owner=?").run(owner);
  }
  recover() {
    if (this.db.prepare("SELECT 1 FROM analysis_lock WHERE expires_at>?").get(Date.now())) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT 1 FROM analysis_lock WHERE expires_at>?").get(Date.now())) {
        this.db.exec("COMMIT");
        return;
      }
      this.db
        .prepare(
          "UPDATE analysis_attempts SET state='interrupted',finished_at=?,error='服务已中断，可继续分析' WHERE state='running'",
        )
        .run(now());
      this.db
        .prepare(
          "UPDATE analysis_tasks SET status='queued',error='服务已中断，可继续分析' WHERE status='running'",
        )
        .run();
      this.db
        .prepare(
          "UPDATE analysis_runs SET status='paused',error='服务已中断，请点击继续分析',updated_at=? WHERE status='running'",
        )
        .run(now());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  counts() {
    const row = this.db
      .prepare(
        `SELECT (SELECT count(*) FROM listings) total,
        (SELECT count(*) FROM listings WHERE status='complete' AND detail_json IS NOT NULL) complete,
        (SELECT count(*) FROM listings WHERE status='failed') failed,
        (SELECT count(*) FROM listings WHERE status='unavailable') unavailable`,
      )
      .get()!;
    const total = Number(row.total),
      complete = Number(row.complete || 0),
      failedDetail = Number(row.failed || 0),
      waitingDetail = total - complete - Number(row.unavailable || 0);
    return {
      total,
      complete,
      waitingDetail,
      pendingDetail: waitingDetail - failedDetail,
      failedDetail,
    };
  }
  run(id: string, includeAssets = true): AnalysisRun | null {
    const row = this.db
      .prepare(`SELECT r.*,count(CASE WHEN t.status!='skipped' THEN t.id END) total,
      coalesce(sum(t.status='completed'),0) completed,coalesce(sum(t.status='failed'),0) failed,
      coalesce(sum(t.status='queued'),0) queued,coalesce(sum(t.reused),0) reused,
      EXISTS(SELECT 1 FROM analysis_tasks ready JOIN listings l ON l.key=ready.listing_key
        WHERE ready.run_id=r.id AND ready.status='queued' AND l.status='complete'
        AND l.detail_json IS NOT NULL) ready_queued,
      coalesce(sum(t.status='running'),0) running_count,
      coalesce(sum(t.status='running' AND t.queue_lane='new'),0) new_running,
      coalesce(sum(t.status='running' AND t.queue_lane='old'),0) old_running,
      (SELECT json_group_array(json_extract(source_listing_json,'$.name')) FROM analysis_tasks WHERE run_id=r.id AND status='running') current_names,
      coalesce(sum(t.status='waiting_pricing'),0) waiting_pricing,
      (SELECT pricing_progress_json FROM analysis_tasks WHERE run_id=r.id AND status='running' LIMIT 1) pricing_progress_json,
      (SELECT asset_counts_json FROM analysis_tasks WHERE run_id=r.id AND status='running' LIMIT 1) asset_counts_json,
      (SELECT json_extract(source_listing_json,'$.name') FROM analysis_tasks WHERE run_id=r.id AND status='running' LIMIT 1) current,
      ${includeAssets ? `(SELECT source_listing_json FROM analysis_tasks WHERE run_id=r.id AND status='running' LIMIT 1)` : "NULL"} current_listing_json,
      ${includeAssets ? `(SELECT source_detail_json FROM analysis_tasks WHERE run_id=r.id AND status='running' LIMIT 1)` : "NULL"} current_detail_json,
      (SELECT CASE
        WHEN (equipment_pricing_json IS NULL OR json_type(equipment_pricing_json,'$.searchComplete')='false' OR ${expiredPricingTimeSql("equipment_pricing_json", "$")}) AND json_extract(r.profile_json,'$.equipmentSearch')=1 THEN 'equipment_search'
        WHEN (pet_pricing_json IS NULL OR json_type(pet_pricing_json,'$.searchComplete')='false' OR ${expiredPricingTimeSql("pet_pricing_json", "$")}) AND json_extract(r.profile_json,'$.petSearch')=1 THEN 'pet_search'
        WHEN json_extract(r.profile_json,'$.petGearSearch')=1 AND (json_extract(pet_pricing_json,'$.gearPricing.searchComplete') IS NOT 1 OR ${expiredPricingTimeSql("pet_pricing_json", "$.gearPricing")})
          AND EXISTS(SELECT 1 FROM json_each(source_detail_json,'$.tabs') tab,json_each(tab.value,'$.pets') pet,json_each(pet.value,'$.equipment') gear WHERE json_extract(tab.value,'$.name')='召唤兽/孩子')
          AND NOT EXISTS(SELECT 1 FROM analysis_attempts a WHERE a.task_id=analysis_tasks.id AND a.state='running') THEN 'pet_gear_search'
        ELSE 'analysis'
      END FROM analysis_tasks WHERE run_id=r.id AND status='running' LIMIT 1) phase
      FROM analysis_runs r LEFT JOIN analysis_tasks t ON t.run_id=r.id WHERE r.id=? GROUP BY r.id`)
      .get(id);
    const storedError = row ? nullable(row.error) : null;
    const profile = row?.profile_json
      ? (JSON.parse(String(row.profile_json)) as AnalysisProfile)
      : undefined;
    const finiteServers =
      profile && row?.follow_capture === "0"
        ? new Set(
            this.db
              .prepare(
                "SELECT DISTINCT json_extract(source_listing_json,'$.serverId') server_id FROM analysis_tasks WHERE run_id=?",
              )
              .all(id)
              .map((task) => String(task.server_id)),
          )
        : null;
    const pauseNotice =
      row?.status === "paused" && storedError?.startsWith("已暂停") ? storedError : null;
    return row
      ? {
          id: String(row.id),
          concurrency: Number(row.concurrency || 1),
          runningCount: Number(row.running_count),
          newRunning: Number(row.new_running),
          oldRunning: Number(row.old_running),
          ...analysisLaneLimits(Number(row.concurrency || 1)),
          currentItems: JSON.parse(String(row.current_names)),
          provider: String(row.provider) as AiProvider,
          model: String(row.model),
          ruleVersion: String(row.rule_version),
          status: String(row.status) as AnalysisRun["status"],
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
          error: pauseNotice || !storedError ? null : aiRequestMessage(storedError),
          pauseNotice,
          rateLimit: this.providerBackoff(String(row.provider) as AiProvider),
          total: Number(row.total),
          completed: Number(row.completed),
          failed: Number(row.failed),
          queued: Number(row.queued),
          waitingPricing: Number(row.waiting_pricing),
          pricingProgress: row.pricing_progress_json
            ? JSON.parse(String(row.pricing_progress_json))
            : null,
          reused: Number(row.reused),
          current: nullable(row.current),
          assetCounts: row.asset_counts_json
            ? JSON.parse(String(row.asset_counts_json))
            : row.current_listing_json && row.current_detail_json
              ? capturedAssetCounts({
                  listing: JSON.parse(String(row.current_listing_json)),
                  detail: JSON.parse(String(row.current_detail_json)),
                  status: "complete",
                  error: null,
                })
              : null,
          phase:
            row.status === "running" &&
            row.follow_capture === "1" &&
            !row.phase &&
            !row.ready_queued
              ? "waiting_capture"
              : (nullable(row.phase) as AnalysisRun["phase"]),
          ...(profile
            ? {
                profileHash: profile.hash,
                marketExpired: automaticMarketExpired(
                  finiteServers
                    ? {
                        ...profile,
                        marketSources: profile.marketSources?.filter((source) =>
                          finiteServers.has(source.serverId),
                        ),
                      }
                    : profile,
                ),
                calculationVersion: profile.calculationVersion,
              }
            : {}),
        }
      : null;
  }
  activeRun() {
    const row = this.db
      .prepare(
        "SELECT id FROM analysis_runs WHERE status='running' ORDER BY created_at DESC LIMIT 1",
      )
      .get();
    return row ? this.run(String(row.id)) : null;
  }
  progress(
    options: {
      provider?: AiProvider;
      runId?: string;
      scope?: import("../crawler/types").SavedListingScope;
    } = {},
  ): AnalysisProgress {
    const active = this.db
      .prepare(
        "SELECT id FROM analysis_runs WHERE status='running' ORDER BY created_at DESC LIMIT 1",
      )
      .get();
    const activeRun = active ? this.run(String(active.id), false) : null;
    const selected =
      options.runId ||
      activeRun?.id ||
      this.db
        .prepare(
          `SELECT id FROM analysis_runs ${options.provider ? "WHERE provider=?" : ""} ORDER BY created_at DESC LIMIT 1`,
        )
        .get(...(options.provider ? [options.provider] : []))?.id;
    return {
      ...this.collectionCounts(options.scope),
      run:
        selected === activeRun?.id
          ? activeRun
          : selected
            ? this.run(String(selected), false)
            : null,
      activeRun,
    };
  }
  private collectionCounts(scope?: import("../crawler/types").SavedListingScope) {
    const counts = this.counts();
    return {
      captureTasks: {
        total: counts.waitingDetail,
        pending: counts.pendingDetail,
        failed: counts.failedDetail,
      },
      counts:
        scope === "complete"
          ? {
              total: counts.complete,
              complete: counts.complete,
              waitingDetail: 0,
              pendingDetail: 0,
              failedDetail: 0,
            }
          : scope === "tasks"
            ? { ...counts, total: counts.waitingDetail, complete: 0 }
            : counts,
    };
  }
  /** Refresh unfinished inputs after collection, retaining the run's original settings. */
  refreshPendingCaptures(id: string, listingKey?: string) {
    const run = this.db.prepare("SELECT profile_json FROM analysis_runs WHERE id=?").get(id);
    if (!run) throw new Error("分析批次不存在");
    const profile = run.profile_json
      ? (JSON.parse(String(run.profile_json)) as AnalysisProfile)
      : undefined;
    const rows = this.db
      .prepare(`SELECT t.id,t.source_listing_json,t.source_detail_json,l.listing_json,l.detail_json
      FROM analysis_tasks t JOIN listings l ON l.key=t.listing_key
      WHERE t.run_id=? AND t.status IN ('queued','waiting_pricing','failed') AND l.status='complete' AND l.detail_json IS NOT NULL
      ${listingKey === undefined ? "" : "AND t.listing_key=?"}`)
      .all(id, ...(listingKey === undefined ? [] : [listingKey]));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const current: SavedRoleRecord = {
          listing: JSON.parse(String(row.listing_json)),
          detail: JSON.parse(String(row.detail_json)),
          status: "complete",
          error: null,
        };
        if (
          (profile || isCurrentRoleCapture(current.detail)) &&
          captureIssues(current.detail!, false, true, current.listing).length
        )
          throw new Error("采集完整性或身份未核验，不能更新分析输入");
        if (
          row.source_listing_json === row.listing_json &&
          row.source_detail_json === row.detail_json
        ) {
          // Old queues froze a full-product request even with asset analysis disabled.
          // Refresh only pending requests; retain full inputs and all previous attempts.
          if (profile && !profile.equipmentSearch && !profile.petSearch) {
            const record: SavedRoleRecord = {
              listing: JSON.parse(String(row.source_listing_json)),
              detail: JSON.parse(String(row.source_detail_json)),
              status: "complete",
              error: null,
            };
            const prompt = valuationPrompt(buildProductDocument(record), record, profile);
            this.db
              .prepare("UPDATE analysis_tasks SET prompt_text=?,prompt_hash=? WHERE id=?")
              .run(prompt, textHash(prompt), row.id);
          }
          continue;
        }
        const record = current;
        if (captureIssues(record.detail!, false, true, record.listing).length)
          throw new Error("采集完整性未核验，不能更新分析输入");
        const document = buildProductDocument(record);
        const prompt = profile
          ? valuationPrompt(document, record, profile)
          : analysisPrompt(document);
        this.db
          .prepare(`UPDATE analysis_tasks SET analysis_data_hash=?,input_hash=?,input_text=?,prompt_hash=?,prompt_text=?,source_listing_json=?,source_detail_json=?,collected_at=?,
          status='queued',error=NULL,result_json=NULL,completed_at=NULL,reused=0,source_task_id=NULL,equipment_pricing_json=NULL,pet_pricing_json=NULL,pricing_progress_json=NULL WHERE id=?`)
          .run(
            analysisDataHash(record),
            document.contentHash,
            document.text,
            textHash(prompt),
            prompt,
            row.listing_json,
            row.detail_json,
            document.collectedAt,
            row.id,
          );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  setRun(id: string, state: AnalysisRun["status"], error: string | null, owner: string) {
    this.db
      .prepare(
        "UPDATE analysis_runs SET status=?,error=?,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM analysis_lock WHERE owner=? AND expires_at>?)",
      )
      .run(state, error, now(), id, owner, Date.now());
  }
  setConcurrency(id: string, concurrency: number, owner: string) {
    analysisConcurrency(concurrency);
    if (!this.owns(owner)) throw new Error("分析锁已失效");
    this.db
      .prepare("UPDATE analysis_runs SET concurrency=? WHERE id=?")
      .run(String(concurrency), id);
  }
  providerBackoff(provider: AiProvider): AnalysisBackoff | null {
    const row = this.db
      .prepare("SELECT state_json FROM analysis_provider_backoff WHERE provider=?")
      .get(provider);
    return row ? (JSON.parse(String(row.state_json)) as AnalysisBackoff) : null;
  }
  saveProviderBackoff(provider: AiProvider, state: AnalysisBackoff | null, owner: string) {
    if (!this.owns(owner)) throw new Error("分析锁已失效");
    if (state)
      this.db
        .prepare(
          "INSERT INTO analysis_provider_backoff(provider,state_json) VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET state_json=excluded.state_json",
        )
        .run(provider, JSON.stringify(state));
    else this.db.prepare("DELETE FROM analysis_provider_backoff WHERE provider=?").run(provider);
  }
  private reusableResult(
    provider: AiProvider,
    model: string,
    record: SavedRoleRecord,
    document: ProductDocument,
    prompt: string,
    profile?: AnalysisProfile,
  ) {
    const dataHash = analysisDataHash(record);
    const previous = this.db
      .prepare(`SELECT t.*,r.profile_json FROM analysis_tasks t
      JOIN analysis_runs r ON t.run_id=r.id
      WHERE t.listing_key=? AND (t.input_hash=? OR t.analysis_data_hash=? OR t.analysis_data_hash IS NULL) AND t.status='completed'
      AND r.provider=? AND r.model=? AND r.rule_version=?
      AND coalesce((${expiredPricingSql}),0)=0 ORDER BY t.completed_at DESC,t.id DESC`)
      .all(
        document.productKey,
        document.contentHash,
        dataHash,
        provider,
        model,
        profile?.version || RULE_VERSION,
      );
    for (const row of previous) {
      try {
        const savedProfile = row.profile_json
          ? (JSON.parse(String(row.profile_json)) as AnalysisProfile)
          : null;
        const sameProfile = isDeepStrictEqual(
          profileScope(savedProfile, record.listing.serverId, record.listing.key),
          profileScope(profile, record.listing.serverId, record.listing.key),
        );
        const sameBodyReview =
          !!profile &&
          !!savedProfile &&
          !profile.equipmentSearch &&
          !profile.petSearch &&
          !savedProfile.equipmentSearch &&
          !savedProfile.petSearch &&
          bodyReviewVersionCompatible(
            savedProfile.calculationVersion,
            profile.calculationVersion,
          ) &&
          String(row.prompt_text).startsWith(BARE_ROLE_TEMPLATE + "\n\n") &&
          isDeepStrictEqual(
            bodyReviewScope(savedProfile, record.listing.serverId, record.listing.key),
            bodyReviewScope(profile, record.listing.serverId, record.listing.key),
          );
        if (!sameProfile && !sameBodyReview) continue;
        if (!profile) {
          if (row.input_hash === document.contentHash && row.prompt_hash === textHash(prompt))
            return row;
          continue;
        }
        const source: SavedRoleRecord = {
          listing: JSON.parse(String(row.source_listing_json)),
          detail: JSON.parse(String(row.source_detail_json)),
          status: "complete",
          error: null,
        };
        // Legacy completions already have a durable status and original source. Backfill
        // their material-data version on demand instead of rebuilding the whole queue.
        const savedDataHash = analysisDataHash(source);
        if (row.analysis_data_hash !== savedDataHash)
          this.db
            .prepare("UPDATE analysis_tasks SET analysis_data_hash=? WHERE id=?")
            .run(savedDataHash, row.id);
        if (savedDataHash !== dataHash) continue;
        const equipment: EquipmentPricingSnapshot | undefined = row.equipment_pricing_json
          ? JSON.parse(String(row.equipment_pricing_json))
          : undefined;
        const pets: PetPricingSnapshot | undefined = row.pet_pricing_json
          ? JSON.parse(String(row.pet_pricing_json))
          : undefined;
        if (
          profile.equipmentSearch &&
          (equipment?.searchComplete !== true ||
            equipment.inputHash !== equipmentInventory(record, profile.settings).inputHash ||
            !validateExactPricing(equipment, equipmentInventory(record, profile.settings).items))
        )
          continue;
        if (
          profile.petSearch &&
          (pets?.searchComplete !== true || !validateExactPricing(pets, petInventory(record).items))
        )
          continue;
        if (profile.petGearSearch && petGearInventory(record).items.length) {
          const gear = pets?.gearPricing;
          const age = gear ? Date.now() - Date.parse(gear.searchedAt) : Infinity;
          if (
            !gear ||
            gear.searchComplete !== true ||
            gear.inputHash !== petGearInventory(record).inputHash ||
            !inventoryMatchesSnapshot(gear, petGearInventory(record).items) ||
            !Number.isFinite(age) ||
            age < -60_000 ||
            age >= 24 * 60 * 60 * 1000
          )
            continue;
        }
        const attempt = this.db
          .prepare(`SELECT id,task_id,raw_response FROM analysis_attempts
          WHERE task_id IN (?,?) AND state='completed'
          ORDER BY CASE WHEN task_id=? THEN 0 ELSE 1 END,finished_at DESC LIMIT 1`)
          .get(row.id, row.source_task_id || row.id, row.id);
        if (!attempt?.raw_response) continue;
        if (sameProfile && row.input_hash === document.contentHash) {
          try {
            const replayed = validateValuation(
              String(attempt.raw_response),
              document,
              record,
              profile,
              equipment,
              pets,
            );
            if (
              isDeepStrictEqual(
                JSON.parse(JSON.stringify(replayed)),
                JSON.parse(String(row.result_json)),
              )
            )
              return { ...row, proof_id: attempt.id, proof_task_id: attempt.task_id };
          } catch {
            // Pricing may have changed since the review; reuse facts only after
            // checking the original response and both archived source versions below.
          }
        }
        if (sameBodyReview) {
          const result = recalculateReviewedBody(
            String(attempt.raw_response),
            JSON.parse(String(row.result_json)),
            source,
            document,
            record,
            profile,
          );
          return {
            ...row,
            result_json: JSON.stringify(result),
            prompt_text: prompt,
            prompt_hash: textHash(prompt),
            completed_at: now(),
            recalculated: 1,
          };
        }
      } catch {
        // Missing or incompatible saved evidence requires a fresh analysis.
      }
    }
    return undefined;
  }
  private insertTask(
    runId: string,
    ordinal: number,
    row: Row,
    record: SavedRoleRecord,
    document: ProductDocument,
    prompt: string,
    previous?: Row,
    validationKey?: string,
  ) {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO analysis_tasks(id,run_id,ordinal,listing_key,input_hash,input_text,prompt_hash,prompt_text,source_listing_json,source_detail_json,collected_at,status,reused,result_json,completed_at,source_task_id,equipment_pricing_json,pet_pricing_json,queue_lane,analysis_data_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        runId,
        ordinal,
        row.key,
        document.contentHash,
        document.text,
        previous?.prompt_hash || textHash(prompt),
        previous?.prompt_text || prompt,
        row.listing_json,
        row.detail_json,
        document.collectedAt,
        previous ? "completed" : "queued",
        previous ? 1 : 0,
        previous?.result_json ?? null,
        previous?.completed_at ?? null,
        previous
          ? previous.recalculated
            ? previous.id
            : previous.proof_task_id || previous.source_task_id || previous.id
          : null,
        previous?.equipment_pricing_json ?? null,
        previous?.pet_pricing_json ?? null,
        row.capture_lane === "new" ? "new" : "old",
        analysisDataHash(record),
      );
    if (previous?.recalculated) {
      const result = JSON.parse(String(previous.result_json)) as ProductAnalysis;
      const time = now();
      const proofId = randomUUID();
      this.db
        .prepare(`INSERT INTO analysis_attempts(id,task_id,state,created_at,finished_at,raw_response,usage_json,request_text)
        VALUES(?,?,'completed',?,?,?,?,?)`)
        .run(
          proofId,
          id,
          time,
          time,
          JSON.stringify({
            decision: result.valuation!.decision,
            reason: result.valuation!.reason,
            extracted_facts: result.valuation!.extracted_facts ?? [],
          }),
          JSON.stringify({ source: "validated-body-recalculation", sourceTaskId: previous.id }),
          "复用已完成且原文引用有效的裸号核对，按当前资料快照和价格配置本地复算；未调用AI。",
        );
      this.rememberCapture(
        runId,
        row,
        { id, result_json: previous.result_json, proof_id: proofId },
        validationKey,
      );
    }
  }
  private rememberCapture(id: string, row: Row, previous?: Row, validationKey?: string) {
    const valuation = previous?.result_json
      ? (JSON.parse(String(previous.result_json)) as ProductAnalysis).valuation
      : undefined;
    const expiry = [
      valuation?.equipment_pricing,
      valuation?.pet_pricing,
      valuation?.pet_pricing?.gearPricing,
    ]
      .filter((pricing) => !!pricing)
      .map((pricing) => Date.parse(pricing!.searchedAt) + 24 * 60 * 60 * 1000);
    const until = Math.min(Number.MAX_SAFE_INTEGER, ...expiry);
    this.db
      .prepare(`INSERT INTO analysis_capture_checks
      (run_id,listing_key,listing_revision,result_task_id,result_revision,proof_id,proof_revision,valid_until,validation_key)
      VALUES(?,?,(SELECT revision FROM record_versions WHERE entity='listings' AND record_key=?),?,
        (SELECT revision FROM record_versions WHERE entity='analysis_tasks' AND record_key=?),?,
        (SELECT revision FROM record_versions WHERE entity='analysis_attempts' AND record_key=?),?,?)
      ON CONFLICT(run_id,listing_key) DO UPDATE SET listing_revision=excluded.listing_revision,
      result_task_id=excluded.result_task_id,result_revision=excluded.result_revision,
      proof_id=excluded.proof_id,proof_revision=excluded.proof_revision,valid_until=excluded.valid_until,validation_key=excluded.validation_key`)
      .run(
        id,
        row.key,
        row.key,
        previous?.id ?? null,
        previous?.id ?? null,
        previous?.proof_id ?? null,
        previous?.proof_id ?? null,
        Number.isFinite(until) ? until : 0,
        validationKey ?? null,
      );
  }
  createRun(
    provider: AiProvider,
    model: string,
    force = false,
    profile?: AnalysisProfile,
    sample = false,
    sampleSize = 1,
    productKeys?: string[],
    concurrency = DEFAULT_ANALYSIS_CONCURRENCY,
  ) {
    analysisConcurrency(concurrency);
    validateSampleSelection(sample, sampleSize, productKeys);
    const id = randomUUID();
    const validationKey = checkpointKey(provider, model, profile ? JSON.stringify(profile) : null);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO analysis_runs(id,provider,model,rule_version,status,created_at,updated_at,error,profile_json,follow_capture,concurrency) VALUES(?,?,?,?,?,?,?,NULL,?,?,?)",
        )
        .run(
          id,
          provider,
          model,
          profile?.version || RULE_VERSION,
          "running",
          now(),
          now(),
          profile ? JSON.stringify(profile) : null,
          sample ? "0" : "1",
          String(concurrency),
        );
      const selected = productKeys
        ? " AND key IN (" + productKeys.map(() => "?").join(",") + ")"
        : "";
      const rows = this.db
        .prepare(
          "SELECT key,listing_json,detail_json,capture_lane FROM listings l WHERE status='complete' AND detail_json IS NOT NULL" +
            selected +
            (sample || force
              ? ""
              : ` AND NOT EXISTS(SELECT 1 FROM analysis_capture_checks c WHERE ${currentCheckpointSql})`) +
            " ORDER BY " +
            (sample ? "key ASC" : "first_seen_at ASC,key ASC") +
            (sample && !productKeys ? " LIMIT ?" : ""),
        )
        .all(
          ...(productKeys || (sample ? [sampleSize] : force ? [] : [validationKey, Date.now()])),
        );
      if (productKeys) {
        if (rows.length !== productKeys.length)
          throw new Error("指定商品不存在或详情未完成，请先补采后再试分析");
        rows.sort(
          (left, right) =>
            productKeys.indexOf(String(left.key)) - productKeys.indexOf(String(right.key)),
        );
      }
      if (!rows.length && sample) throw new Error("暂无详情完整的商品，请先采集商品详情");
      let inserted = 0;
      rows.forEach((row, index) => {
        const record: SavedRoleRecord = {
          listing: JSON.parse(String(row.listing_json)),
          detail: JSON.parse(String(row.detail_json)),
          status: "complete",
          error: null,
        };
        if (record.listing.key !== row.key) throw new Error("商品 ID 与数据库记录不一致");
        if (
          (profile || isCurrentRoleCapture(record.detail)) &&
          captureIssues(record.detail!, false, true, record.listing).length
        )
          throw new Error("角色资料尚未完整采集，不能进入分析任务");
        const document = buildProductDocument(record);
        const prompt = profile
          ? valuationPrompt(document, record, profile)
          : analysisPrompt(document);
        const previous = force
          ? undefined
          : this.reusableResult(provider, model, record, document, prompt, profile);
        if (previous && !sample && !previous.recalculated) {
          this.rememberCapture(id, row, previous, validationKey);
          return;
        }
        inserted++;
        this.insertTask(id, index, row, record, document, prompt, previous, validationKey);
      });
      if (!inserted) {
        // Reuse an ordinary batch only with the same frozen settings. A trial stays finite;
        // otherwise retain this empty batch so newly captured roles still have a waiting worker.
        const latest = this.db
          .prepare(`SELECT id FROM analysis_runs
          WHERE id!=? AND provider=? AND model=? AND rule_version=? AND profile_json IS ?
          AND follow_capture='1' AND error IS NULL
          AND NOT EXISTS(SELECT 1 FROM analysis_tasks t WHERE t.run_id=analysis_runs.id AND t.status!='completed')
          ORDER BY created_at DESC,id DESC LIMIT 1`)
          .get(
            id,
            provider,
            model,
            profile?.version || RULE_VERSION,
            profile ? JSON.stringify(profile) : null,
          );
        if (latest) {
          this.db.prepare("DELETE FROM analysis_runs WHERE id=?").run(id);
          this.db.exec("COMMIT");
          return String(latest.id);
        }
      }
      this.db.exec("COMMIT");
      return id;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  followsCapture(id: string) {
    return (
      this.db.prepare("SELECT follow_capture FROM analysis_runs WHERE id=?").get(id)
        ?.follow_capture === "1"
    );
  }
  hasCapturedPending(id: string) {
    return (
      this.followsCapture(id) &&
      !!this.db
        .prepare(`SELECT 1 FROM listings l
      WHERE l.status='complete' AND l.detail_json IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM analysis_tasks t WHERE t.run_id=? AND t.listing_key=l.key) LIMIT 1`)
        .get(id)
    );
  }
  appendCaptured(id: string, owner: string) {
    if (!this.owns(owner)) return 0;
    const run = this.db
      .prepare("SELECT * FROM analysis_runs WHERE id=? AND status='running' AND follow_capture='1'")
      .get(id);
    if (!run) return 0;
    const validationKey = checkpointKey(
      String(run.provider),
      String(run.model),
      nullable(run.profile_json),
    );
    const profile = run.profile_json
      ? (JSON.parse(String(run.profile_json)) as AnalysisProfile)
      : undefined;
    const rows = this.db
      .prepare(`SELECT l.key,l.listing_json,l.detail_json,l.capture_lane,input.revision input_revision FROM listings l
      JOIN record_versions input ON input.entity='listings' AND input.record_key=l.key
      WHERE l.status='complete' AND l.detail_json IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM analysis_tasks t WHERE t.run_id=? AND t.listing_key=l.key)
      AND NOT EXISTS(SELECT 1 FROM analysis_capture_checks c
        JOIN record_versions v ON v.entity='listings' AND v.record_key=l.key
        WHERE c.run_id=? AND c.validation_key=? AND c.listing_key=l.key AND c.listing_revision=v.revision AND c.valid_until>?
        AND (c.result_task_id IS NULL OR c.result_revision=(SELECT revision FROM record_versions WHERE entity='analysis_tasks' AND record_key=c.result_task_id))
        AND (c.proof_id IS NULL OR c.proof_revision=(SELECT revision FROM record_versions WHERE entity='analysis_attempts' AND record_key=c.proof_id)))
      AND NOT EXISTS(SELECT 1 FROM analysis_capture_checks c WHERE ${currentCheckpointSql})
      ORDER BY l.first_seen_at ASC,l.key ASC`)
      .all(id, id, validationKey, Date.now(), validationKey, Date.now());
    let ordinal = Number(
      this.db
        .prepare("SELECT coalesce(max(ordinal),-1)+1 n FROM analysis_tasks WHERE run_id=?")
        .get(id)!.n,
    );
    let added = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        // The discovery SELECT precedes the write transaction; another connection may
        // have replaced an input meanwhile. Never memoize or enqueue its old version.
        if (
          !this.db
            .prepare(
              "SELECT 1 FROM record_versions WHERE entity='listings' AND record_key=? AND revision=?",
            )
            .get(row.key, row.input_revision)
        )
          continue;
        const record: SavedRoleRecord = {
          listing: JSON.parse(String(row.listing_json)),
          detail: JSON.parse(String(row.detail_json)),
          status: "complete",
          error: null,
        };
        if (record.listing.key !== row.key) throw new Error("商品 ID 与数据库记录不一致");
        if (
          (profile || isCurrentRoleCapture(record.detail)) &&
          captureIssues(record.detail!, false, true, record.listing).length
        ) {
          this.rememberCapture(id, row, undefined, validationKey);
          continue;
        }
        const document = buildProductDocument(record);
        const prompt = profile
          ? valuationPrompt(document, record, profile)
          : analysisPrompt(document);
        const previous = this.reusableResult(
          String(run.provider) as AiProvider,
          String(run.model),
          record,
          document,
          prompt,
          profile,
        );
        if (previous && !previous.recalculated) {
          this.rememberCapture(id, row, previous, validationKey);
          continue;
        }
        this.insertTask(id, ordinal++, row, record, document, prompt, previous, validationKey);
        added++;
      }
      if (added) this.db.prepare("UPDATE analysis_runs SET updated_at=? WHERE id=?").run(now(), id);
      this.db.exec("COMMIT");
      return added;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  skipUnavailableQueued(runId: string): number {
    return Number(
      this.db
        .prepare(`UPDATE analysis_tasks SET status='skipped',error=(SELECT error FROM listings WHERE key=analysis_tasks.listing_key)
      WHERE run_id=? AND status IN ('queued','waiting_pricing','failed')
      AND listing_key IN (SELECT key FROM listings WHERE status='unavailable')`)
        .run(runId).changes,
    );
  }
  /** Stop work before a new request; already dispatched attempts remain historical evidence. */
  skipUnavailableTask(task: AnalysisTask, owner: string): boolean {
    if (!this.owns(owner)) throw new Error("分析锁已失效");
    const unavailable = this.db
      .prepare("SELECT error FROM listings WHERE key=? AND status='unavailable'")
      .get(task.document.productKey);
    if (!unavailable) return false;
    this.db
      .prepare(`UPDATE analysis_tasks SET status='skipped',error=? WHERE id=?
      AND status IN ('queued','running','waiting_pricing','failed')
      AND NOT EXISTS(SELECT 1 FROM analysis_attempts WHERE task_id=? AND state='running')`)
      .run(String(unavailable.error), task.id, task.id);
    return true;
  }
  next(runId: string, preferredLane?: AnalysisLane): AnalysisTask | null {
    this.skipUnavailableQueued(runId);
    const next = this.db.prepare(
      `SELECT t.*,r.profile_json,${matchingSourceSql} AS source_matches,
          (SELECT length(trim(coalesce(a.raw_response,'')))>0 FROM analysis_attempts a
           WHERE a.task_id=t.id ORDER BY a.rowid DESC LIMIT 1) last_attempt_had_response
         FROM analysis_tasks t JOIN analysis_runs r ON t.run_id=r.id JOIN listings l ON l.key=t.listing_key
         WHERE t.run_id=? AND t.status='queued' AND l.status='complete' AND l.detail_json IS NOT NULL
         ORDER BY CASE WHEN t.queue_lane=? THEN 0 ELSE 1 END,t.ordinal ASC LIMIT 1`,
    );
    let row = next.get(runId, preferredLane ?? null);
    if (!row) return null;
    if (row.source_matches !== 1) {
      // Collection may finish while analysis is waiting. Refresh only this input;
      // unchanged tasks use the indexed source match rather than a queue-wide scan.
      this.refreshPendingCaptures(runId, String(row.listing_key));
      row = next.get(runId, preferredLane ?? null);
      if (!row) return null;
      if (row.source_matches !== 1) throw new Error("角色资料正在更新，请资料稳定后继续分析");
    }
    const task: AnalysisTask = {
      id: String(row.id),
      runId,
      lane: row.queue_lane === "new" ? "new" : "old",
      document: {
        formatVersion: 1,
        productKey: String(row.listing_key),
        contentHash: String(row.input_hash),
        text: String(row.input_text),
        collectedAt: String(row.collected_at),
      },
      record: {
        listing: JSON.parse(String(row.source_listing_json)),
        detail: JSON.parse(String(row.source_detail_json)),
        status: "complete",
        error: null,
      },
      prompt: String(row.prompt_text),
      attempts: Number(row.attempt_count),
      profile: row.profile_json ? JSON.parse(String(row.profile_json)) : null,
      lastError: nullable(row.error),
      lastAttemptHadResponse: row.last_attempt_had_response === 1,
      ...(row.result_json ? { previousResult: JSON.parse(String(row.result_json)) } : {}),
      ...(row.equipment_pricing_json
        ? { equipmentPricing: JSON.parse(String(row.equipment_pricing_json)) }
        : {}),
      ...(row.pet_pricing_json ? { petPricing: JSON.parse(String(row.pet_pricing_json)) } : {}),
    };
    this.db
      .prepare("UPDATE analysis_tasks SET asset_counts_json=? WHERE id=?")
      .run(JSON.stringify(capturedAssetCounts(task.record)), task.id);
    return task;
  }
  deferPricing(task: AnalysisTask, owner: string, error: string) {
    if (!this.owns(owner)) throw new Error("分析锁已失效");
    if (
      this.db
        .prepare(`UPDATE analysis_tasks SET status='waiting_pricing',error=?
      WHERE id=? AND status IN ('queued','running')
      AND NOT EXISTS(SELECT 1 FROM analysis_attempts WHERE task_id=? AND state='running')`)
        .run(error + "；已保留查价进度，可单独重试待补齐项", task.id, task.id).changes !== 1
    )
      throw new Error("查价任务状态已变化");
    this.setRun(task.runId, "paused", error, owner);
  }
  pricingProgress(
    task: AnalysisTask,
    owner: string,
    progress: NonNullable<AnalysisRun["pricingProgress"]>,
  ) {
    if (!this.owns(owner)) return;
    this.db
      .prepare("UPDATE analysis_tasks SET pricing_progress_json=? WHERE id=? AND status='running'")
      .run(JSON.stringify(progress), task.id);
  }
  beginEquipmentSearch(task: AnalysisTask, owner: string) {
    if (!this.owns(owner)) throw new Error("分析锁已失效");
    if (
      this.db
        .prepare(
          "UPDATE analysis_tasks SET status='running',error=NULL WHERE id=? AND status='queued' AND equipment_pricing_json IS ?",
        )
        .run(task.id, task.equipmentPricing ? JSON.stringify(task.equipmentPricing) : null)
        .changes !== 1
    )
      throw new Error("装备查价任务状态已变化");
  }
  saveEquipmentPricing(
    task: AnalysisTask,
    snapshot: EquipmentPricingSnapshot,
    owner: string,
    keepRunning = false,
  ): AnalysisTask {
    if (
      !task.profile?.equipmentSearch ||
      snapshot.inputHash !== equipmentInventory(task.record, task.profile?.settings).inputHash
    )
      throw new Error("装备查价资料与当前任务不匹配");
    const prompt = valuationPrompt(
      task.document,
      task.record,
      task.profile,
      snapshot,
      task.petPricing,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.owns(owner)) throw new Error("分析锁已失效");
      if (
        this.db
          .prepare(
            "UPDATE analysis_tasks SET equipment_pricing_json=?,prompt_text=?,prompt_hash=?,status=?,error=NULL WHERE id=? AND status='running' AND equipment_pricing_json IS ?",
          )
          .run(
            JSON.stringify(snapshot),
            prompt,
            textHash(prompt),
            keepRunning ? "running" : "queued",
            task.id,
            task.equipmentPricing ? JSON.stringify(task.equipmentPricing) : null,
          ).changes !== 1
      )
        throw new Error("装备查价任务状态已变化");
      this.db.prepare("UPDATE analysis_runs SET updated_at=? WHERE id=?").run(now(), task.runId);
      this.db.exec("COMMIT");
      return { ...task, prompt, equipmentPricing: snapshot, lastError: null };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  abortEquipmentSearch(task: AnalysisTask, owner: string) {
    if (!this.owns(owner)) throw new Error("分析锁已失效");
    this.db
      .prepare(
        "UPDATE analysis_tasks SET status='queued' WHERE id=? AND status='running' AND NOT EXISTS(SELECT 1 FROM analysis_attempts WHERE task_id=? AND state='running')",
      )
      .run(task.id, task.id);
  }
  beginPetSearch(task: AnalysisTask, owner: string) {
    if (!this.owns(owner)) throw new Error("分析锁已失效");
    if (
      this.db
        .prepare(
          "UPDATE analysis_tasks SET status='running',error=NULL WHERE id=? AND status='queued' AND pet_pricing_json IS ?",
        )
        .run(task.id, task.petPricing ? JSON.stringify(task.petPricing) : null).changes !== 1
    )
      throw new Error("宝宝查价任务状态已变化");
  }
  savePetPricing(task: AnalysisTask, snapshot: PetPricingSnapshot, owner: string): AnalysisTask {
    if (!task.profile?.petSearch || snapshot.inputHash !== petInventory(task.record).inputHash)
      throw new Error("宝宝查价资料与当前任务不匹配");
    if (
      snapshot.gearPricing &&
      (!task.profile.petGearSearch ||
        snapshot.gearPricing.inputHash !== petGearInventory(task.record).inputHash ||
        !inventoryMatchesSnapshot(snapshot.gearPricing, petGearInventory(task.record).items) ||
        snapshot.gearPricing.total !== null ||
        snapshot.gearPricing.knownTotal !== 0)
    )
      throw new Error("宝宝装备查价资料与当前任务不匹配");
    const prompt = valuationPrompt(
      task.document,
      task.record,
      task.profile,
      task.equipmentPricing,
      snapshot,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.owns(owner)) throw new Error("分析锁已失效");
      if (
        this.db
          .prepare(
            "UPDATE analysis_tasks SET pet_pricing_json=?,prompt_text=?,prompt_hash=?,status='queued',error=NULL WHERE id=? AND status='running' AND pet_pricing_json IS ?",
          )
          .run(
            JSON.stringify(snapshot),
            prompt,
            textHash(prompt),
            task.id,
            task.petPricing ? JSON.stringify(task.petPricing) : null,
          ).changes !== 1
      )
        throw new Error("宝宝查价任务状态已变化");
      this.db.prepare("UPDATE analysis_runs SET updated_at=? WHERE id=?").run(now(), task.runId);
      this.db.exec("COMMIT");
      return { ...task, prompt, petPricing: snapshot, lastError: null };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  abortPetSearch(task: AnalysisTask, owner: string) {
    if (!this.owns(owner)) throw new Error("分析锁已失效");
    this.db
      .prepare(
        "UPDATE analysis_tasks SET status='queued' WHERE id=? AND status='running' AND NOT EXISTS(SELECT 1 FROM analysis_attempts WHERE task_id=? AND state='running')",
      )
      .run(task.id, task.id);
  }
  begin(task: AnalysisTask, owner: string, request = task.prompt) {
    const id = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.owns(owner)) throw new Error("分析锁已失效");
      if (
        this.db
          .prepare(
            "UPDATE analysis_tasks SET status='running',attempt_count=attempt_count+1,error=NULL WHERE id=? AND status='queued'",
          )
          .run(task.id).changes !== 1
      )
        throw new Error("商品任务状态已变化");
      this.db
        .prepare(
          "INSERT INTO analysis_attempts(id,task_id,state,created_at,request_text,request_hash) VALUES(?,?,'running',?,?,?)",
        )
        .run(id, task.id, now(), request, textHash(request));
      this.db.exec("COMMIT");
      return id;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  finish(
    task: AnalysisTask,
    attempt: string,
    owner: string,
    outcome: {
      state: "completed" | "failed" | "interrupted";
      result?: ProductAnalysis;
      raw?: string;
      usage?: unknown;
      error?: string;
      diagnosticError?: string;
      requeue?: boolean;
    },
  ) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.owns(owner)) throw new Error("分析锁已失效");
      this.db
        .prepare(
          "UPDATE analysis_attempts SET state=?,finished_at=?,raw_response=?,usage_json=?,error=? WHERE id=?",
        )
        .run(
          outcome.state,
          now(),
          outcome.raw ?? null,
          outcome.usage == null ? null : JSON.stringify(outcome.usage),
          outcome.diagnosticError ?? outcome.error ?? null,
          attempt,
        );
      this.db
        .prepare(
          "UPDATE analysis_tasks SET status=?,result_json=?,completed_at=?,error=? WHERE id=?",
        )
        .run(
          outcome.result ? "completed" : outcome.requeue ? "queued" : "failed",
          outcome.result ? JSON.stringify(outcome.result) : null,
          outcome.result ? now() : null,
          outcome.error ?? null,
          task.id,
        );
      this.db.prepare("UPDATE analysis_runs SET updated_at=? WHERE id=?").run(now(), task.runId);
      if (
        outcome.result &&
        outcome.raw &&
        this.db.prepare("SELECT matches FROM analysis_source_matches WHERE task_id=?").get(task.id)
          ?.matches === 1
      ) {
        const run = this.db
          .prepare("SELECT provider,model,profile_json FROM analysis_runs WHERE id=?")
          .get(task.runId)!;
        this.rememberCapture(
          task.runId,
          { key: task.record.listing.key },
          { id: task.id, result_json: JSON.stringify(outcome.result), proof_id: attempt },
          checkpointKey(String(run.provider), String(run.model), nullable(run.profile_json)),
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  retry(runId: string) {
    this.db
      .prepare(
        "UPDATE analysis_tasks SET status='queued',error=CASE WHEN status='failed' THEN error ELSE NULL END,attempt_count=CASE WHEN status='failed' THEN attempt_count ELSE 0 END,pricing_progress_json=NULL WHERE run_id=? AND status IN ('failed','waiting_pricing')",
      )
      .run(runId);
  }
  detail(id: string, currentProfile?: AnalysisProfile): AnalysisDetail | null {
    const row = this.db
      .prepare(
        "SELECT t.*,r.provider,r.model,r.rule_version,r.profile_json FROM analysis_tasks t JOIN analysis_runs r ON t.run_id=r.id WHERE t.id=?",
      )
      .get(id);
    if (!row) return null;
    const listing = JSON.parse(String(row.source_listing_json)) as Listing;
    const savedProfile = row.profile_json
      ? (JSON.parse(String(row.profile_json)) as AnalysisProfile)
      : null;
    const attempts = this.db
      .prepare(
        "SELECT * FROM analysis_attempts WHERE task_id IN (?,?) ORDER BY created_at ASC,rowid ASC",
      )
      .all(id, row.source_task_id || id)
      .map((attempt) => ({
        id: String(attempt.id),
        state: String(attempt.state),
        createdAt: String(attempt.created_at),
        finishedAt: nullable(attempt.finished_at),
        rawResponse: nullable(attempt.raw_response),
        usage: attempt.usage_json ? JSON.parse(String(attempt.usage_json)) : null,
        error: nullable(attempt.error),
        requestText: nullable(attempt.request_text),
        requestHash: nullable(attempt.request_hash),
      }));
    return {
      taskId: id,
      runId: String(row.run_id),
      provider: String(row.provider) as AiProvider,
      model: String(row.model),
      ruleVersion: String(row.rule_version),
      listing,
      assetCounts: capturedAssetCounts({
        listing,
        detail: JSON.parse(String(row.source_detail_json)),
        status: "complete",
        error: null,
      }),
      state: String(row.status),
      inputHash: String(row.input_hash),
      inputText: String(row.input_text),
      promptHash: String(row.prompt_hash),
      promptText: String(row.prompt_text),
      ...(String(row.prompt_text).startsWith("【裸号核对专用模板 ")
        ? { requestTemplate: String(row.prompt_text).split("\n\n")[0] }
        : {}),
      result: row.result_json ? JSON.parse(String(row.result_json)) : null,
      completedAt: nullable(row.completed_at),
      error: nullable(row.error),
      reusedFrom: nullable(row.source_task_id),
      profile: savedProfile,
      profileChanged:
        !!currentProfile &&
        !isDeepStrictEqual(
          profileScope(savedProfile, listing.serverId, listing.key),
          profileScope(currentProfile, listing.serverId, listing.key),
        ),
      equipmentPricing: row.equipment_pricing_json
        ? JSON.parse(String(row.equipment_pricing_json))
        : null,
      petPricing: row.pet_pricing_json ? JSON.parse(String(row.pet_pricing_json)) : null,
      attempts,
    };
  }
  private item(row: Row, currentProfile?: AnalysisProfile, summary = false): AnalysisItem {
    const listing = JSON.parse(String(row.listing_json)) as Listing;
    const savedProfile = row.profile_json
      ? (JSON.parse(String(row.profile_json)) as AnalysisProfile)
      : null;
    const result: ProductAnalysis | null = row.result_json
      ? JSON.parse(String(row.result_json))
      : null;
    return {
      key: String(row.key),
      name: listing.name,
      server: listing.serverName || listing.serverId,
      price: listing.price,
      url: listing.url,
      collectionStatus: String(row.collection_status),
      collectedAt: nullable(row.collected_at),
      lastSeenAt: nullable(row.last_seen_at),
      state: String(row.state) as AnalysisItem["state"],
      taskId: nullable(row.task_id),
      score: row.state === "completed" ? (result?.score ?? null) : null,
      summary: result?.summary ?? null,
      highlights: row.state === "completed" ? result?.highlights || [] : listing.highlights || [],
      error: nullable(row.task_error),
      marketExpired: savedProfile
        ? automaticMarketExpired({
            ...savedProfile,
            marketSources: savedProfile.marketSources?.filter(
              (source) => source.serverId === listing.serverId,
            ),
          })
        : false,
      profileChanged:
        !!row.task_id &&
        !!currentProfile &&
        !isDeepStrictEqual(
          profileScope(savedProfile, listing.serverId, listing.key),
          profileScope(currentProfile, listing.serverId, listing.key),
        ),
      valuation: row.state === "completed" ? overviewResult(result, summary)?.valuation : undefined,
    };
  }
  markRecommendationViewed(key: unknown) {
    if (typeof key !== "string" || !key || key !== key.trim() || key.length > 100)
      throw new Error("商品编号无效");
    if (!this.db.prepare("SELECT 1 FROM listings WHERE key=?").get(key))
      throw new Error("商品不存在");
    this.db
      .prepare("INSERT INTO recommendation_views VALUES(?,?) ON CONFLICT(listing_key) DO NOTHING")
      .run(key, now());
    return { key, viewed: true };
  }
  overview(options: Parameters<AnalysisStore["overviewSteps"]>[0] = {}): AnalysisOverview {
    const steps = this.overviewSteps(options);
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
  }
  async overviewAsync(
    options: Parameters<AnalysisStore["overviewSteps"]>[0] = {},
    signal?: AbortSignal,
  ): Promise<AnalysisOverview> {
    signal?.throwIfAborted();
    const key = JSON.stringify(options);
    let request = this.overviewRequests.get(key);
    if (!request) {
      const controller = new AbortController();
      request = {
        controller,
        readers: 0,
        promise: (async () => {
          const steps = this.overviewSteps(options);
          try {
            let step = steps.next();
            while (!step.done) {
              await yieldThread();
              controller.signal.throwIfAborted();
              step = steps.next();
            }
            return step.value;
          } finally {
            steps.return(undefined as never);
          }
        })(),
      };
      this.overviewRequests.set(key, request);
    }
    const current = request;
    current.readers++;
    let cancel: (() => void) | undefined;
    try {
      return signal
        ? await Promise.race([
            current.promise,
            new Promise<never>((_resolve, reject) => {
              cancel = () => reject(signal.reason);
              signal.addEventListener("abort", cancel, { once: true });
              if (signal.aborted) cancel();
            }),
          ])
        : await current.promise;
    } finally {
      if (cancel) signal!.removeEventListener("abort", cancel);
      if (--current.readers === 0) {
        if (this.overviewRequests.get(key) === current) this.overviewRequests.delete(key);
        current.controller.abort(new Error("商品记录请求已结束"));
      }
    }
  }
  private *overviewSteps(
    options: {
      provider?: AiProvider;
      runId?: string;
      page?: number;
      resultsPage?: number;
      rankingPage?: number;
      currentProfile?: AnalysisProfile;
      search?: string;
      filter?: string;
      summary?: boolean;
      showViewed?: boolean;
      includeRanking?: boolean;
      includeRecords?: boolean;
      includeResults?: boolean;
      scope?: import("../crawler/types").SavedListingScope;
    } = {},
  ): Generator<void, AnalysisOverview, void> {
    yield;
    const ids = this.db
      .prepare(
        `SELECT id FROM analysis_runs ${options.provider ? "WHERE provider=?" : ""} ORDER BY created_at DESC LIMIT 30`,
      )
      .all(...(options.provider ? [options.provider] : []));
    const runs = ids.map((row) => this.run(String(row.id), false)!);
    yield;
    const activeRun = this.activeRun();
    const run = options.runId ? this.run(options.runId) : activeRun || runs[0] || null;
    const sourceValues = options.runId ? [run?.id || ""] : [];
    const taskSelection = options.runId
      ? "t.listing_key=l.key AND t.run_id=?"
      : `t.id=(
      SELECT candidate.id FROM analysis_tasks candidate JOIN analysis_runs r ON r.id=candidate.run_id
      WHERE candidate.listing_key=l.key ORDER BY
        CASE WHEN candidate.status='completed' AND (${matchingSourceSql.replaceAll("t.", "candidate.")})
          AND coalesce((${expiredPricingSql.replaceAll("t.", "candidate.")}),0)=0 THEN 0 ELSE 1 END,
        r.created_at DESC,candidate.ordinal DESC,candidate.id DESC LIMIT 1)`;
    // Omit evidence before transferring/parsing a summary; detail reads retain the full result.
    const resultColumn = options.summary
      ? `json_remove(t.result_json,${["equipment_pricing", "pet_pricing"]
          .flatMap((key) =>
            ["items", "queries", "rawResponse", "searchItems", "searchAttempts", "requestText"].map(
              (field) => `'$.valuation.${key}.${field}'`,
            ),
          )
          .concat(
            "'$.valuation.pet_pricing.gearPricing'",
            "'$.valuation.extracted_facts'",
            "'$.valuation.ai_explanation'",
            "'$.dimensions.foundation.evidence'",
            "'$.dimensions.equipment.evidence'",
            "'$.dimensions.pets.evidence'",
          )
          .join(",")})`
      : "t.result_json";
    const productColumns = `l.key,l.listing_json,l.collected_at,l.last_seen_at,l.status collection_status,t.id task_id,${resultColumn} result_json,t.error task_error,selected_run.profile_json,${stateSql} state`;
    const scopeCondition =
      options.scope === "complete"
        ? " WHERE l.status='complete' AND l.detail_json IS NOT NULL"
        : options.scope === "tasks"
          ? " WHERE (l.status!='complete' OR l.detail_json IS NULL)"
          : "";
    const source = `SELECT ${productColumns} FROM listings l LEFT JOIN analysis_tasks t ON ${taskSelection} LEFT JOIN analysis_runs selected_run ON selected_run.id=t.run_id${scopeCondition}`;
    const conditions: string[] = [],
      values: string[] = [...sourceValues];
    if (options.search?.trim()) {
      conditions.push("instr(lower(listing_json),lower(?))>0");
      values.push(options.search.trim().slice(0, 200));
    }
    if (options.filter && options.filter !== "all") {
      conditions.push("state=?");
      values.push(options.filter);
    }
    const query = `WITH products AS (${source}) SELECT * FROM products${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""}`;
    // Default counts and page selection must not replay every historical task/source.
    const stateFiltered = !!options.filter && options.filter !== "all";
    const listingSearch = options.search?.trim()
      ? `${scopeCondition ? " AND" : " WHERE"} instr(lower(l.listing_json),lower(?))>0`
      : "";
    const listingValues = options.search?.trim() ? [options.search.trim().slice(0, 200)] : [];
    const listingSource = `FROM listings l${scopeCondition}${listingSearch}`;
    const total = Number(
      stateFiltered
        ? this.db.prepare(`SELECT count(*) n FROM (${query})`).get(...values)!.n
        : this.db.prepare(`SELECT count(*) n ${listingSource}`).get(...listingValues)!.n,
    );
    const totalPages = Math.max(1, Math.ceil(total / 20));
    const page = Math.max(1, Math.min(totalPages, Math.trunc(options.page || 1)));
    let records: AnalysisItem[] = [];
    if (options.includeRecords !== false) {
      const pageKeys = stateFiltered
        ? undefined
        : this.db
            .prepare(`SELECT l.key ${listingSource} ORDER BY l.key ASC LIMIT 20 OFFSET ?`)
            .all(...listingValues, (page - 1) * 20)
            .map((row) => row.key);
      const recordQuery = pageKeys
        ? `WITH products AS (${source}${scopeCondition ? " AND" : " WHERE"} l.key IN (${pageKeys.map(() => "?").join(",") || "NULL"})) SELECT * FROM products${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""} ORDER BY key ASC`
        : `${query} ORDER BY key ASC LIMIT 20 OFFSET ?`;
      records = this.db
        .prepare(recordQuery)
        .all(
          ...(pageKeys
            ? [...sourceValues, ...pageKeys, ...listingValues]
            : [...values, (page - 1) * 20]),
        )
        .map((row) => this.item(row, options.currentProfile, options.summary));
    }
    yield;
    let currentRanking: AnalysisItem[] = [],
      currentManual: AnalysisItem[] = [],
      rankingPagination: AnalysisOverview["rankingPagination"];
    if (options.includeRanking !== false) {
      const ranking: {
        key: string;
        taskId: SQLOutputValue;
        signature: string;
        cached: {
          recommendation?: AnalysisItem["recommendation"];
          assetSummary?: AnalysisItem["assetSummary"];
        };
      }[] = [];
      const manualReview: AnalysisItem[] = [];
      const profileKey = textHash(JSON.stringify(options.currentProfile || null));
      const signature = (row: Row) =>
        textHash(
          JSON.stringify([row.listing_revision, row.task_revision, row.profile_json, profileKey]),
        );
      // Materialize only keys before yielding: never leave a SQLite iterator open
      // while collection can update the same connection's tables.
      const rankedRows = this.db
        .prepare(
          `SELECT l.key,t.id task_id,views.viewed_at FROM listings l LEFT JOIN analysis_tasks t ON ${taskSelection} LEFT JOIN recommendation_views views ON views.listing_key=l.key WHERE (${stateSql})='completed' AND json_type(t.result_json,'$.valuation.bare_role_value') IN ('integer','real')${options.showViewed ? "" : " AND views.listing_key IS NULL"} ORDER BY coalesce(json_extract(t.result_json,'$.valuation.price_difference_ratio'),json_extract(t.result_json,'$.valuation.margin_of_safety')) DESC,json_extract(t.result_json,'$.score') DESC,l.key ASC`,
        )
        .all(...sourceValues);
      const candidateKeys = new Set(rankedRows.map((row) => String(row.key)));
      for (const key of this.recommendationCache.keys())
        if (!candidateKeys.has(key)) this.recommendationCache.delete(key);
      yield;
      const revisions = "lv.revision listing_revision,tv.revision task_revision";
      // Sorting carries keys only. Batch small version identities afterwards instead
      // of rerunning source comparisons and historical-task selection for each key.
      const metadata = new Map<SQLOutputValue, Row>();
      const profiles = new Map<string, SQLOutputValue>();
      const readProfile = this.db.prepare("SELECT profile_json FROM analysis_runs WHERE id=?");
      for (let offset = 0; offset < rankedRows.length; offset += 128) {
        const batch = rankedRows.slice(offset, offset + 128);
        const rows = this.db
          .prepare(`SELECT l.key,t.id task_id,t.run_id,${revisions}
        FROM analysis_tasks t JOIN listings l ON l.key=t.listing_key
        JOIN record_versions lv ON lv.entity='listings' AND lv.record_key=l.key
        JOIN record_versions tv ON tv.entity='analysis_tasks' AND tv.record_key=t.id
        WHERE t.id IN (${batch.map(() => "?").join(",")})`)
          .all(...batch.map((row) => row.task_id));
        for (const row of rows) {
          const id = String(row.run_id);
          if (!profiles.has(id)) profiles.set(id, readProfile.get(id)?.profile_json ?? null);
          metadata.set(row.task_id, {
            ...row,
            state: "completed",
            profile_json: profiles.get(id)!,
          });
        }
        yield;
      }
      const rankedSource = `FROM listings l JOIN analysis_tasks t ON t.listing_key=l.key
      JOIN analysis_runs selected_run ON selected_run.id=t.run_id
      JOIN record_versions lv ON lv.entity='listings' AND lv.record_key=l.key
      JOIN record_versions tv ON tv.entity='analysis_tasks' AND tv.record_key=t.id
      LEFT JOIN recommendation_views views ON views.listing_key=l.key
      WHERE l.key=? AND t.id=? AND (${taskSelection})`;
      const rankedMetadata = this.db.prepare(
        `SELECT l.key,${revisions},selected_run.profile_json,views.viewed_at,${stateSql} state ${rankedSource}`,
      );
      const rankedProduct = this.db.prepare(
        `SELECT ${productColumns},l.detail_json,views.viewed_at,${revisions} ${rankedSource}`,
      );
      const selected = new Map<string, { taskId: SQLOutputValue; signature: string }>();
      let deadline = performance.now() + 8;
      for (const candidate of rankedRows) {
        if (performance.now() >= deadline) {
          yield;
          deadline = performance.now() + 8;
        }
        const observed = metadata.get(candidate.task_id);
        let row: Row | undefined = observed
          ? { ...observed, viewed_at: candidate.viewed_at }
          : undefined;
        if (!row || row.state !== "completed" || (!options.showViewed && row.viewed_at)) continue;
        const key = String(row.key),
          fingerprint = signature(row);
        let cached = this.recommendationCache.get(key);
        let item: AnalysisItem | undefined;
        let record: SavedRoleRecord | undefined;
        if (!cached || cached.signature !== fingerprint) {
          row = rankedProduct.get(candidate.key, candidate.task_id, ...sourceValues);
          if (!row || row.state !== "completed" || signature(row) !== fingerprint) continue;
          item = this.item(row, options.currentProfile, options.summary);
          record = {
            listing: JSON.parse(String(row.listing_json)),
            detail: JSON.parse(String(row.detail_json)),
            status: "complete",
            error: null,
          };
          cached = {
            signature: fingerprint,
            ...(!item.profileChanged
              ? { recommendation: recommendationFor(record, item.valuation) }
              : {}),
          };
        }
        // One small decision per current candidate; source documents are never cached.
        this.recommendationCache.set(key, cached);
        const status = cached.recommendation?.status;
        if (status === "recommended") {
          ranking.push({ key, taskId: candidate.task_id, signature: fingerprint, cached });
        } else if (status === "manual" && manualReview.length < 10) {
          if (!item) {
            row = rankedProduct.get(candidate.key, candidate.task_id, ...sourceValues);
            if (!row || row.state !== "completed" || signature(row) !== fingerprint) continue;
          }
          item ||= this.item(row, options.currentProfile, options.summary);
          item.recommendationViewed = !!row.viewed_at;
          item.recommendation = structuredClone(cached.recommendation);
          manualReview.push(item);
          selected.set(key, { taskId: candidate.task_id, signature: fingerprint });
        }
      }
      // A yielding overview may overlap capture, deletion, quote expiry or a view action.
      // Revalidate displayed rows synchronously before publishing; do not resurrect stale results.
      const stillCurrent = (item: AnalysisItem) => {
        const chosen = selected.get(item.key)!;
        const row = rankedMetadata.get(item.key, chosen.taskId, ...sourceValues);
        return (
          !!row &&
          row.state === "completed" &&
          (options.showViewed || !row.viewed_at) &&
          signature(row) === chosen.signature
        );
      };
      currentManual = manualReview.filter(stillCurrent);
      // Recheck every eligible key after the yielding scan so removed or viewed items
      // do not inflate totals or leave an empty page.
      const validRanking = ranking.filter((entry) => {
        const row = rankedMetadata.get(entry.key, entry.taskId, ...sourceValues);
        return (
          !!row &&
          row.state === "completed" &&
          (options.showViewed || !row.viewed_at) &&
          signature(row) === entry.signature
        );
      });
      const rankingTotal = validRanking.length;
      const rankingTotalPages = Math.max(1, Math.ceil(rankingTotal / 20));
      const requestedPage = Number.isFinite(options.rankingPage)
        ? Math.trunc(options.rankingPage!)
        : 1;
      const rankingPage = Math.max(1, Math.min(rankingTotalPages, requestedPage));
      rankingPagination = { page: rankingPage, totalPages: rankingTotalPages, total: rankingTotal };
      for (const entry of validRanking.slice((rankingPage - 1) * 20, rankingPage * 20)) {
        const row = rankedProduct.get(entry.key, entry.taskId, ...sourceValues);
        const { cached } = entry;
        if (!row || row.state !== "completed" || signature(row) !== entry.signature) continue;
        const item = this.item(row, options.currentProfile, options.summary);
        item.recommendationViewed = !!row.viewed_at;
        item.recommendation = structuredClone(cached.recommendation);
        cached.assetSummary ??= capturedAssetSummary({
          listing: JSON.parse(String(row.listing_json)),
          detail: JSON.parse(String(row.detail_json)),
          status: "complete",
          error: null,
        });
        item.assetSummary = structuredClone(cached.assetSummary);
        currentRanking.push(item);
      }
    }
    const historyKeys = this.db
      .prepare(
        `SELECT a.id FROM analysis_attempts a JOIN analysis_tasks t ON a.task_id=t.id WHERE t.run_id=? ORDER BY a.created_at DESC,a.id ASC LIMIT 30`,
      )
      .all(run?.id || "")
      .map((row) => row.id);
    const history = this.db
      .prepare(
        `SELECT a.id,a.state,a.created_at,a.finished_at,a.error,t.id task_id,json_extract(t.source_listing_json,'$.name') name FROM analysis_attempts a JOIN analysis_tasks t ON a.task_id=t.id WHERE a.id IN (${historyKeys.map(() => "?").join(",") || "NULL"}) ORDER BY a.created_at DESC,a.id ASC`,
      )
      .all(...historyKeys)
      .map((row) => ({
        id: String(row.id),
        taskId: String(row.task_id),
        name: String(row.name),
        state: String(row.state),
        createdAt: String(row.created_at),
        finishedAt: nullable(row.finished_at),
        error: nullable(row.error),
      }));
    const resultsSource = `FROM listings l JOIN analysis_tasks t ON t.id=(
      SELECT completed.id FROM analysis_tasks completed JOIN analysis_runs r ON r.id=completed.run_id
      WHERE completed.listing_key=l.key AND completed.status='completed' AND completed.result_json IS NOT NULL
      ${options.runId ? "AND completed.run_id=?" : ""}
      ORDER BY completed.completed_at DESC,r.created_at DESC,completed.id DESC LIMIT 1)
      JOIN analysis_runs r ON r.id=t.run_id`;
    const resultTotal = Number(
      this.db
        .prepare(`SELECT count(*) n FROM listings l WHERE EXISTS(
      SELECT 1 FROM analysis_tasks completed JOIN analysis_runs r ON r.id=completed.run_id
      WHERE completed.listing_key=l.key AND completed.status='completed' AND completed.result_json IS NOT NULL
      ${options.runId ? "AND completed.run_id=?" : ""})`)
        .get(...sourceValues)!.n,
    );
    const resultTotalPages = Math.max(1, Math.ceil(resultTotal / 20));
    const resultPage = Math.max(
      1,
      Math.min(resultTotalPages, Math.trunc(options.resultsPage || 1)),
    );
    let results: AnalysisOverview["results"]["items"] = [];
    if (options.includeResults !== false) {
      const resultKeys = this.db
        .prepare(
          `SELECT t.id ${resultsSource} ORDER BY t.completed_at DESC,t.id DESC LIMIT 20 OFFSET ?`,
        )
        .all(...sourceValues, (resultPage - 1) * 20)
        .map((row) => row.id);
      results = this.db
        .prepare(`SELECT t.id task_id,t.source_listing_json,${resultColumn} result_json,t.completed_at,
      r.provider,r.model,r.profile_json,${stateSql} state ${resultsSource}
      WHERE t.id IN (${resultKeys.map(() => "?").join(",") || "NULL"})
      ORDER BY t.completed_at DESC,t.id DESC`)
        .all(...sourceValues, ...resultKeys)
        .map((row) => {
          const listing = JSON.parse(String(row.source_listing_json)) as Listing;
          const savedProfile = row.profile_json
            ? (JSON.parse(String(row.profile_json)) as AnalysisProfile)
            : null;
          return {
            taskId: String(row.task_id),
            name: listing.name,
            server: listing.serverName || listing.serverId,
            price: listing.price,
            provider: String(row.provider) as AiProvider,
            model: String(row.model),
            completedAt: String(row.completed_at),
            stale: row.state !== "completed",
            profileHash: savedProfile?.hash || null,
            profileChanged:
              !!options.currentProfile &&
              !isDeepStrictEqual(
                profileScope(savedProfile, listing.serverId, listing.key),
                profileScope(options.currentProfile, listing.serverId, listing.key),
              ),
            result: overviewResult(
              JSON.parse(String(row.result_json)) as ProductAnalysis,
              !!options.summary,
            )!,
          };
        });
    }
    return {
      ...(options.includeRanking === false ? { rankingDeferred: true } : {}),
      ...this.collectionCounts(options.scope),
      // A yielding records/ranking request must not publish the old progress snapshot.
      run: run ? this.run(run.id) : null,
      activeRun: this.activeRun(),
      runs,
      ranking: currentRanking,
      ...(rankingPagination ? { rankingPagination } : {}),
      manualReview: currentManual,
      records: { page, totalPages, total, items: records },
      history,
      results: {
        page: resultPage,
        totalPages: resultTotalPages,
        total: resultTotal,
        items: results,
      },
    };
  }
}
