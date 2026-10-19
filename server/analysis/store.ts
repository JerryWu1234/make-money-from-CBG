import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { AiProvider } from "../ai/types";
import type { Listing, SavedRoleRecord } from "../crawler/types";
import { analysisPrompt, RULE_VERSION, textHash } from "./contract";
import { buildProductDocument } from "./product-document";
import { valuationPrompt, validateValuation } from "./valuation-contract";
import { inventoryMatchesSnapshot, validateExactPricing } from "./pricing-integrity";
import type { AnalysisProfile } from "./valuation-types";
import type { ProductDocument } from "./product-document";
import { equipmentInventory, type EquipmentPricingSnapshot } from "./equipment-pricing";
import { petInventory, type PetPricingSnapshot } from "./pet-pricing";
import { petGearInventory } from "./pet-gear-inventory";
import { validateSampleSelection } from "./sample-selection";
import { captureIssues } from "../crawler/capture-readiness";
import type {
  AnalysisDetail,
  AnalysisItem,
  AnalysisOverview,
  AnalysisRun,
  ProductAnalysis,
} from "./types";

type Row = Record<string, SQLOutputValue>;
export type AnalysisTask = {
  id: string;
  runId: string;
  document: ProductDocument;
  record: SavedRoleRecord;
  prompt: string;
  attempts: number;
  profile: AnalysisProfile | null;
  lastError: string | null;
  equipmentPricing?: EquipmentPricingSnapshot;
  petPricing?: PetPricingSnapshot;
};
const now = () => new Date().toISOString();
const nullable = (value: SQLOutputValue | undefined) => (value == null ? null : String(value));
const expiredPricingTimeSql = (column: string, path: string) => {
  const time = `julianday(json_extract(${column},'${path}.searchedAt'))`;
  return `(${time} IS NULL OR ${time}<=julianday('now','-24 hours') OR ${time}>julianday('now','+1 minute'))`;
};
const expiredPricingSql = ["equipment_pricing", "pet_pricing", "pet_pricing.gearPricing"]
  .map((key) => {
    return `(json_type(t.result_json,'$.valuation.${key}')='object' AND ${expiredPricingTimeSql("t.result_json", "$.valuation." + key)})`;
  })
  .join(" OR ");
const stateSql = `CASE WHEN l.status!='complete' OR l.detail_json IS NULL THEN 'waiting_detail'
  WHEN t.id IS NULL THEN 'ready'
  WHEN t.source_listing_json!=l.listing_json OR t.source_detail_json!=l.detail_json THEN 'stale'
  WHEN t.status='completed' AND (${expiredPricingSql}) THEN 'stale'
  ELSE t.status END`;

function overviewResult(result: ProductAnalysis | null, summary: boolean) {
  if (!summary || !result?.valuation) return result;
  const value = result.valuation;
  return {
    ...result,
    valuation: {
      ...value,
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

export class AnalysisStore {
  constructor(readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS analysis_runs (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, rule_version TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT
    );
    CREATE TABLE IF NOT EXISTS analysis_tasks (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, ordinal INTEGER NOT NULL, listing_key TEXT NOT NULL,
      input_hash TEXT NOT NULL, input_text TEXT NOT NULL, prompt_hash TEXT NOT NULL, prompt_text TEXT NOT NULL,
      source_listing_json TEXT NOT NULL, source_detail_json TEXT NOT NULL, collected_at TEXT NOT NULL,
      status TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, reused INTEGER NOT NULL DEFAULT 0,
      result_json TEXT, completed_at TEXT, error TEXT, source_task_id TEXT, UNIQUE(run_id,listing_key)
    );
    CREATE INDEX IF NOT EXISTS analysis_tasks_run ON analysis_tasks(run_id,ordinal);
    CREATE INDEX IF NOT EXISTS analysis_tasks_input ON analysis_tasks(input_hash,status);
    CREATE INDEX IF NOT EXISTS analysis_tasks_listing ON analysis_tasks(listing_key,status,completed_at DESC);
    CREATE TABLE IF NOT EXISTS analysis_attempts (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL,
      finished_at TEXT, raw_response TEXT, usage_json TEXT, error TEXT
    );
    CREATE TABLE IF NOT EXISTS analysis_lock (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL);`);
    if (
      !db
        .prepare("PRAGMA table_info(analysis_tasks)")
        .all()
        .some((column) => column.name === "source_task_id")
    )
      db.exec("ALTER TABLE analysis_tasks ADD COLUMN source_task_id TEXT");
    for (const [table, column] of [
      ["analysis_runs", "profile_json"],
      ["analysis_runs", "follow_capture"],
      ["analysis_tasks", "pricing_progress_json"],
      ["analysis_attempts", "request_text"],
      ["analysis_attempts", "request_hash"],
      ["analysis_tasks", "equipment_pricing_json"],
      ["analysis_tasks", "pet_pricing_json"],
    ]) {
      if (
        !db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((row) => row.name === column)
      )
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    }
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
        "SELECT count(*) total,sum(CASE WHEN status='complete' AND detail_json IS NOT NULL THEN 1 ELSE 0 END) complete FROM listings",
      )
      .get()!;
    const total = Number(row.total),
      complete = Number(row.complete || 0);
    return { total, complete, waitingDetail: total - complete };
  }
  run(id: string): AnalysisRun | null {
    const row = this.db
      .prepare(`SELECT r.*,count(t.id) total,
      coalesce(sum(t.status='completed'),0) completed,coalesce(sum(t.status='failed'),0) failed,
      coalesce(sum(t.status='queued'),0) queued,coalesce(sum(t.reused),0) reused,
      coalesce(sum(t.status='waiting_pricing'),0) waiting_pricing,
      (SELECT pricing_progress_json FROM analysis_tasks WHERE run_id=r.id AND status='running' LIMIT 1) pricing_progress_json,
      (SELECT json_extract(source_listing_json,'$.name') FROM analysis_tasks WHERE run_id=r.id AND status='running' LIMIT 1) current,
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
    const pauseNotice =
      row?.status === "paused" && storedError?.startsWith("已暂停") ? storedError : null;
    return row
      ? {
          id: String(row.id),
          provider: String(row.provider) as AiProvider,
          model: String(row.model),
          ruleVersion: String(row.rule_version),
          status: String(row.status) as AnalysisRun["status"],
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
          error: pauseNotice ? null : storedError,
          pauseNotice,
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
          phase: nullable(row.phase) as AnalysisRun["phase"],
          ...(row.profile_json
            ? {
                profileHash: (JSON.parse(String(row.profile_json)) as AnalysisProfile).hash,
                calculationVersion: (JSON.parse(String(row.profile_json)) as AnalysisProfile)
                  .calculationVersion,
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
  /** Refresh unfinished inputs after collection, retaining the run's original settings. */
  refreshPendingCaptures(id: string) {
    const run = this.db.prepare("SELECT profile_json FROM analysis_runs WHERE id=?").get(id);
    if (!run) throw new Error("分析批次不存在");
    const profile = run.profile_json
      ? (JSON.parse(String(run.profile_json)) as AnalysisProfile)
      : undefined;
    const rows = this.db
      .prepare(`SELECT t.id,t.source_listing_json,t.source_detail_json,l.listing_json,l.detail_json
      FROM analysis_tasks t JOIN listings l ON l.key=t.listing_key
      WHERE t.run_id=? AND t.status IN ('queued','waiting_pricing','failed') AND l.status='complete' AND l.detail_json IS NOT NULL`)
      .all(id);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        if (
          row.source_listing_json === row.listing_json &&
          row.source_detail_json === row.detail_json
        )
          continue;
        const record: SavedRoleRecord = {
          listing: JSON.parse(String(row.listing_json)),
          detail: JSON.parse(String(row.detail_json)),
          status: "complete",
          error: null,
        };
        if (captureIssues(record.detail!).length)
          throw new Error("采集完整性未核验，不能更新分析输入");
        const document = buildProductDocument(record);
        const prompt = profile
          ? valuationPrompt(document, record, profile)
          : analysisPrompt(document);
        this.db
          .prepare(`UPDATE analysis_tasks SET input_hash=?,input_text=?,prompt_hash=?,prompt_text=?,source_listing_json=?,source_detail_json=?,collected_at=?,
          status='queued',error=NULL,result_json=NULL,completed_at=NULL,reused=0,source_task_id=NULL,equipment_pricing_json=NULL,pet_pricing_json=NULL,pricing_progress_json=NULL WHERE id=?`)
          .run(
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
  private reusableResult(
    provider: AiProvider,
    model: string,
    record: SavedRoleRecord,
    document: ProductDocument,
    prompt: string,
    profile?: AnalysisProfile,
  ) {
    const previous = this.db
      .prepare(`SELECT t.*,r.profile_json FROM analysis_tasks t
      JOIN analysis_runs r ON t.run_id=r.id
      WHERE t.listing_key=? AND t.input_hash=? AND t.status='completed'
      AND r.provider=? AND r.model=? AND r.rule_version=?
      AND coalesce((${expiredPricingSql}),0)=0 ORDER BY t.completed_at DESC,t.id DESC`)
      .all(
        document.productKey,
        document.contentHash,
        provider,
        model,
        profile?.version || RULE_VERSION,
      );
    for (const row of previous) {
      try {
        const savedProfile = row.profile_json
          ? (JSON.parse(String(row.profile_json)) as AnalysisProfile)
          : null;
        if (
          !isDeepStrictEqual(
            profileScope(savedProfile, record.listing.serverId, record.listing.key),
            profileScope(profile, record.listing.serverId, record.listing.key),
          )
        )
          continue;
        if (!profile) {
          if (row.prompt_hash === textHash(prompt)) return row;
          continue;
        }
        const equipment: EquipmentPricingSnapshot | undefined = row.equipment_pricing_json
          ? JSON.parse(String(row.equipment_pricing_json))
          : undefined;
        const pets: PetPricingSnapshot | undefined = row.pet_pricing_json
          ? JSON.parse(String(row.pet_pricing_json))
          : undefined;
        if (
          profile.equipmentSearch &&
          (equipment?.searchComplete !== true ||
            !validateExactPricing(equipment, equipmentInventory(record).items))
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
          .prepare(`SELECT raw_response FROM analysis_attempts
          WHERE task_id=? AND state='completed' ORDER BY finished_at DESC LIMIT 1`)
          .get(row.source_task_id || row.id);
        if (!attempt?.raw_response) continue;
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
          return row;
      } catch {
        // Missing or incompatible saved evidence requires a fresh analysis.
      }
    }
    return undefined;
  }
  createRun(
    provider: AiProvider,
    model: string,
    force = false,
    profile?: AnalysisProfile,
    sample = false,
    sampleSize = 1,
    productKeys?: string[],
  ) {
    validateSampleSelection(sample, sampleSize, productKeys);
    const id = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO analysis_runs(id,provider,model,rule_version,status,created_at,updated_at,error,profile_json,follow_capture) VALUES(?,?,?,?,?,?,?,NULL,?,?)",
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
        );
      const selected = productKeys
        ? " AND key IN (" + productKeys.map(() => "?").join(",") + ")"
        : "";
      const rows = this.db
        .prepare(
          "SELECT key,listing_json,detail_json FROM listings WHERE status='complete' AND detail_json IS NOT NULL" +
            selected +
            " ORDER BY " +
            (sample ? "key ASC" : "first_seen_at ASC,key ASC") +
            (sample && !productKeys ? " LIMIT ?" : ""),
        )
        .all(...(productKeys || (sample ? [sampleSize] : [])));
      if (productKeys) {
        if (rows.length !== productKeys.length)
          throw new Error("指定商品不存在或详情未完成，请先补采后再试分析");
        rows.sort(
          (left, right) =>
            productKeys.indexOf(String(left.key)) - productKeys.indexOf(String(right.key)),
        );
      }
      if (!rows.length) throw new Error("暂无详情完整的商品，请先采集商品详情");
      const insert = this.db.prepare(
        `INSERT INTO analysis_tasks(id,run_id,ordinal,listing_key,input_hash,input_text,prompt_hash,prompt_text,source_listing_json,source_detail_json,collected_at,status,reused,result_json,completed_at,source_task_id,equipment_pricing_json,pet_pricing_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
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
          profile &&
          (profile.equipmentSearch || profile.petSearch) &&
          captureIssues(record.detail!).length
        )
          throw new Error("角色资料尚未完整采集，不能进入分析任务");
        const document = buildProductDocument(record);
        const prompt = profile
          ? valuationPrompt(document, record, profile)
          : analysisPrompt(document);
        const previous = force
          ? undefined
          : this.reusableResult(provider, model, record, document, prompt, profile);
        if (previous && !sample) return;
        inserted++;
        insert.run(
          randomUUID(),
          id,
          index,
          String(row.key),
          document.contentHash,
          document.text,
          previous?.prompt_hash || textHash(prompt),
          previous?.prompt_text || prompt,
          String(row.listing_json),
          String(row.detail_json),
          document.collectedAt,
          previous ? "completed" : "queued",
          previous ? 1 : 0,
          previous?.result_json ?? null,
          previous?.completed_at ?? null,
          previous ? previous.source_task_id || previous.id : null,
          previous?.equipment_pricing_json ?? null,
          previous?.pet_pricing_json ?? null,
        );
      });
      if (!inserted) {
        this.db.prepare("DELETE FROM analysis_runs WHERE id=?").run(id);
        const latest = this.db
          .prepare(`SELECT id FROM analysis_runs
          WHERE provider=? AND model=? AND rule_version=? ORDER BY created_at DESC,id DESC LIMIT 1`)
          .get(provider, model, profile?.version || RULE_VERSION)!;
        this.db.exec("COMMIT");
        return String(latest.id);
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
    const profile = run.profile_json
      ? (JSON.parse(String(run.profile_json)) as AnalysisProfile)
      : undefined;
    const rows = this.db
      .prepare(`SELECT l.key,l.listing_json,l.detail_json FROM listings l
      WHERE l.status='complete' AND l.detail_json IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM analysis_tasks t WHERE t.run_id=? AND t.listing_key=l.key)
      ORDER BY l.first_seen_at ASC,l.key ASC`)
      .all(id);
    let ordinal = Number(
      this.db
        .prepare("SELECT coalesce(max(ordinal),-1)+1 n FROM analysis_tasks WHERE run_id=?")
        .get(id)!.n,
    );
    let added = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const record: SavedRoleRecord = {
          listing: JSON.parse(String(row.listing_json)),
          detail: JSON.parse(String(row.detail_json)),
          status: "complete",
          error: null,
        };
        if (record.listing.key !== row.key) throw new Error("商品 ID 与数据库记录不一致");
        if (
          profile &&
          (profile.equipmentSearch || profile.petSearch) &&
          captureIssues(record.detail!).length
        )
          continue;
        const document = buildProductDocument(record);
        const prompt = profile
          ? valuationPrompt(document, record, profile)
          : analysisPrompt(document);
        if (
          this.reusableResult(
            String(run.provider) as AiProvider,
            String(run.model),
            record,
            document,
            prompt,
            profile,
          )
        )
          continue;
        this.db
          .prepare(`INSERT INTO analysis_tasks(id,run_id,ordinal,listing_key,input_hash,input_text,prompt_hash,prompt_text,source_listing_json,source_detail_json,collected_at,status)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,'queued')`)
          .run(
            randomUUID(),
            id,
            ordinal++,
            String(row.key),
            document.contentHash,
            document.text,
            textHash(prompt),
            prompt,
            String(row.listing_json),
            String(row.detail_json),
            document.collectedAt,
          );
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

  next(runId: string): AnalysisTask | null {
    const row = this.db
      .prepare(
        "SELECT t.*,r.profile_json FROM analysis_tasks t JOIN analysis_runs r ON t.run_id=r.id WHERE t.run_id=? AND t.status='queued' ORDER BY t.ordinal ASC LIMIT 1",
      )
      .get(runId);
    if (!row) return null;
    return {
      id: String(row.id),
      runId,
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
      ...(row.equipment_pricing_json
        ? { equipmentPricing: JSON.parse(String(row.equipment_pricing_json)) }
        : {}),
      ...(row.pet_pricing_json ? { petPricing: JSON.parse(String(row.pet_pricing_json)) } : {}),
    };
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
      snapshot.inputHash !== equipmentInventory(task.record).inputHash
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
          outcome.error ?? null,
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
      .prepare("SELECT * FROM analysis_attempts WHERE task_id=? ORDER BY created_at ASC,rowid ASC")
      .all(row.source_task_id || id)
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
      state: String(row.status),
      inputHash: String(row.input_hash),
      inputText: String(row.input_text),
      promptHash: String(row.prompt_hash),
      promptText: String(row.prompt_text),
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
      state: String(row.state) as AnalysisItem["state"],
      taskId: nullable(row.task_id),
      score: row.state === "completed" ? (result?.score ?? null) : null,
      summary: result?.summary ?? null,
      highlights: row.state === "completed" ? result?.highlights || [] : listing.highlights || [],
      error: nullable(row.task_error),
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
  overview(
    options: {
      provider?: AiProvider;
      runId?: string;
      page?: number;
      resultsPage?: number;
      currentProfile?: AnalysisProfile;
      search?: string;
      filter?: string;
      summary?: boolean;
    } = {},
  ): AnalysisOverview {
    const ids = this.db
      .prepare(
        `SELECT id FROM analysis_runs ${options.provider ? "WHERE provider=?" : ""} ORDER BY created_at DESC LIMIT 30`,
      )
      .all(...(options.provider ? [options.provider] : []));
    const runs = ids.map((row) => this.run(String(row.id))!);
    const activeRun = this.activeRun();
    const run = options.runId ? this.run(options.runId) : activeRun || runs[0] || null;
    const sourceValues = options.runId ? [run?.id || ""] : [];
    const taskSelection = options.runId
      ? "t.listing_key=l.key AND t.run_id=?"
      : `t.id=(
      SELECT candidate.id FROM analysis_tasks candidate JOIN analysis_runs r ON r.id=candidate.run_id
      WHERE candidate.listing_key=l.key ORDER BY
        CASE WHEN candidate.status='completed' AND candidate.source_listing_json=l.listing_json
          AND candidate.source_detail_json=l.detail_json
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
          .concat("'$.valuation.pet_pricing.gearPricing'")
          .join(",")})`
      : "t.result_json";
    const source = `SELECT l.key,l.listing_json,l.collected_at,l.status collection_status,t.id task_id,${resultColumn} result_json,t.error task_error,selected_run.profile_json,${stateSql} state FROM listings l LEFT JOIN analysis_tasks t ON ${taskSelection} LEFT JOIN analysis_runs selected_run ON selected_run.id=t.run_id`;
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
    const total = Number(this.db.prepare(`SELECT count(*) n FROM (${query})`).get(...values)!.n);
    const totalPages = Math.max(1, Math.ceil(total / 20));
    const page = Math.max(1, Math.min(totalPages, Math.trunc(options.page || 1)));
    const records = this.db
      .prepare(`${query} ORDER BY key ASC LIMIT 20 OFFSET ?`)
      .all(...values, (page - 1) * 20)
      .map((row) => this.item(row, options.currentProfile, options.summary));
    const ranking: AnalysisItem[] = [];
    const rankedRows = this.db
      .prepare(
        `WITH products AS (${source}) SELECT * FROM products WHERE state='completed' AND (json_extract(result_json,'$.valuation.decision')='BUY' OR (json_extract(result_json,'$.valuation') IS NULL AND json_extract(result_json,'$.score') IS NOT NULL)) ORDER BY coalesce(json_extract(result_json,'$.valuation.price_difference_ratio'),json_extract(result_json,'$.valuation.margin_of_safety')) DESC,json_extract(result_json,'$.score') DESC,key ASC`,
      )
      .iterate(...sourceValues);
    for (const row of rankedRows) {
      const item = this.item(row, options.currentProfile, options.summary);
      if (!item.profileChanged) ranking.push(item);
      if (ranking.length === 10) break;
    }
    const history = this.db
      .prepare(
        `SELECT a.*,t.id task_id,json_extract(t.source_listing_json,'$.name') name FROM analysis_attempts a JOIN analysis_tasks t ON a.task_id=t.id WHERE t.run_id=? ORDER BY a.created_at DESC,a.id ASC LIMIT 30`,
      )
      .all(run?.id || "")
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
      this.db.prepare(`SELECT count(*) n ${resultsSource}`).get(...sourceValues)!.n,
    );
    const resultTotalPages = Math.max(1, Math.ceil(resultTotal / 20));
    const resultPage = Math.max(
      1,
      Math.min(resultTotalPages, Math.trunc(options.resultsPage || 1)),
    );
    const results = this.db
      .prepare(`SELECT t.id task_id,t.source_listing_json,${resultColumn} result_json,t.completed_at,
      r.provider,r.model,r.profile_json,${stateSql} state ${resultsSource}
      ORDER BY t.completed_at DESC,t.id DESC LIMIT 20 OFFSET ?`)
      .all(...sourceValues, (resultPage - 1) * 20)
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
    return {
      counts: this.counts(),
      run,
      activeRun,
      runs,
      ranking,
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
