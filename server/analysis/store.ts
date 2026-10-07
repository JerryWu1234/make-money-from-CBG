import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { AiProvider } from "../ai/types";
import type { Listing, SavedRoleRecord } from "../crawler/types";
import { analysisPrompt, RULE_VERSION, textHash } from "./contract";
import { buildProductDocument } from "./product-document";
import { valuationPrompt } from "./valuation-contract";
import type { AnalysisProfile } from "./valuation-types";
import type { ProductDocument } from "./product-document";
import { equipmentInventory, type EquipmentPricingSnapshot } from "./equipment-pricing";
import { petInventory, type PetPricingSnapshot } from "./pet-pricing";
import { validateSampleSelection } from "./sample-selection";
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
const expiredPricingSql = ["equipment_pricing", "pet_pricing"]
  .map((key) => {
    const time = `julianday(json_extract(t.result_json,'$.valuation.${key}.searchedAt'))`;
    return `(json_type(t.result_json,'$.valuation.${key}')='object' AND (${time} IS NULL OR ${time}<=julianday('now','-24 hours') OR ${time}>julianday('now','+1 minute')))`;
  })
  .join(" OR ");
const stateSql = `CASE WHEN l.status!='complete' OR l.detail_json IS NULL THEN 'waiting_detail'
  WHEN t.id IS NULL THEN 'ready'
  WHEN t.source_listing_json!=l.listing_json OR t.source_detail_json!=l.detail_json THEN 'stale'
  WHEN t.status='completed' AND (${expiredPricingSql}) THEN 'stale'
  ELSE t.status END`;

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
      (SELECT json_extract(source_listing_json,'$.name') FROM analysis_tasks WHERE run_id=r.id AND status='running' LIMIT 1) current,
      (SELECT CASE
        WHEN (equipment_pricing_json IS NULL OR json_type(equipment_pricing_json,'$.searchComplete')='false') AND json_extract(r.profile_json,'$.equipmentSearch')=1 THEN 'equipment_search'
        WHEN (pet_pricing_json IS NULL OR json_type(pet_pricing_json,'$.searchComplete')='false') AND json_extract(r.profile_json,'$.petSearch')=1 THEN 'pet_search'
        ELSE 'analysis'
      END FROM analysis_tasks WHERE run_id=r.id AND status='running' LIMIT 1) phase
      FROM analysis_runs r LEFT JOIN analysis_tasks t ON t.run_id=r.id WHERE r.id=? GROUP BY r.id`)
      .get(id);
    return row
      ? {
          id: String(row.id),
          provider: String(row.provider) as AiProvider,
          model: String(row.model),
          ruleVersion: String(row.rule_version),
          status: String(row.status) as AnalysisRun["status"],
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
          error: nullable(row.error),
          total: Number(row.total),
          completed: Number(row.completed),
          failed: Number(row.failed),
          queued: Number(row.queued),
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
  setRun(id: string, state: AnalysisRun["status"], error: string | null, owner: string) {
    this.db
      .prepare(
        "UPDATE analysis_runs SET status=?,error=?,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM analysis_lock WHERE owner=? AND expires_at>?)",
      )
      .run(state, error, now(), id, owner, Date.now());
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
          "INSERT INTO analysis_runs(id,provider,model,rule_version,status,created_at,updated_at,error,profile_json) VALUES(?,?,?,?,?,?,?,NULL,?)",
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
        `INSERT INTO analysis_tasks(id,run_id,ordinal,listing_key,input_hash,input_text,prompt_hash,prompt_text,source_listing_json,source_detail_json,collected_at,status,reused,result_json,completed_at,source_task_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      rows.forEach((row, index) => {
        const record: SavedRoleRecord = {
          listing: JSON.parse(String(row.listing_json)),
          detail: JSON.parse(String(row.detail_json)),
          status: "complete",
          error: null,
        };
        if (record.listing.key !== row.key) throw new Error("商品 ID 与数据库记录不一致");
        const document = buildProductDocument(record);
        const prompt = profile
          ? valuationPrompt(document, record, profile)
          : analysisPrompt(document);
        const previous =
          force || profile?.equipmentSearch || profile?.petSearch
            ? undefined
            : this.db
                .prepare(
                  `SELECT t.id,t.source_task_id,t.result_json,t.completed_at FROM analysis_tasks t JOIN analysis_runs r ON t.run_id=r.id WHERE t.input_hash=? AND t.prompt_hash=? AND t.status='completed' AND r.provider=? AND r.model=? AND r.rule_version=? AND coalesce(json_extract(r.profile_json,'$.hash'),'')=? ORDER BY t.completed_at DESC LIMIT 1`,
                )
                .get(
                  document.contentHash,
                  textHash(prompt),
                  provider,
                  model,
                  profile?.version || RULE_VERSION,
                  profile?.hash || "",
                );
        insert.run(
          randomUUID(),
          id,
          index,
          String(row.key),
          document.contentHash,
          document.text,
          textHash(prompt),
          prompt,
          String(row.listing_json),
          String(row.detail_json),
          document.collectedAt,
          previous ? "completed" : "queued",
          previous ? 1 : 0,
          previous?.result_json ?? null,
          previous?.completed_at ?? null,
          previous ? previous.source_task_id || previous.id : null,
        );
      });
      this.db.exec("COMMIT");
      return id;
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
            "UPDATE analysis_tasks SET equipment_pricing_json=?,prompt_text=?,prompt_hash=?,status='queued',error=NULL WHERE id=? AND status='running' AND equipment_pricing_json IS ?",
          )
          .run(
            JSON.stringify(snapshot),
            prompt,
            textHash(prompt),
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
        "UPDATE analysis_tasks SET status='queued',error=NULL,attempt_count=0 WHERE run_id=? AND status='failed'",
      )
      .run(runId);
  }
  detail(id: string): AnalysisDetail | null {
    const row = this.db
      .prepare(
        "SELECT t.*,r.provider,r.model,r.rule_version,r.profile_json FROM analysis_tasks t JOIN analysis_runs r ON t.run_id=r.id WHERE t.id=?",
      )
      .get(id);
    if (!row) return null;
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
      listing: JSON.parse(String(row.source_listing_json)),
      state: String(row.status),
      inputHash: String(row.input_hash),
      inputText: String(row.input_text),
      promptHash: String(row.prompt_hash),
      promptText: String(row.prompt_text),
      result: row.result_json ? JSON.parse(String(row.result_json)) : null,
      completedAt: nullable(row.completed_at),
      error: nullable(row.error),
      reusedFrom: nullable(row.source_task_id),
      profile: row.profile_json ? JSON.parse(String(row.profile_json)) : null,
      equipmentPricing: row.equipment_pricing_json
        ? JSON.parse(String(row.equipment_pricing_json))
        : null,
      petPricing: row.pet_pricing_json ? JSON.parse(String(row.pet_pricing_json)) : null,
      attempts,
    };
  }
  private item(row: Row): AnalysisItem {
    const listing = JSON.parse(String(row.listing_json)) as Listing;
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
      valuation: row.state === "completed" ? result?.valuation : undefined,
    };
  }
  overview(
    options: {
      provider?: AiProvider;
      runId?: string;
      page?: number;
      search?: string;
      filter?: string;
    } = {},
  ): AnalysisOverview {
    const ids = this.db
      .prepare(
        `SELECT id FROM analysis_runs ${options.provider ? "WHERE provider=?" : ""} ORDER BY created_at DESC LIMIT 30`,
      )
      .all(...(options.provider ? [options.provider] : []));
    const runs = ids.map((row) => this.run(String(row.id))!);
    const run = options.runId ? this.run(options.runId) : runs[0] || null;
    const source = `SELECT l.key,l.listing_json,l.collected_at,l.status collection_status,t.id task_id,t.result_json,t.error task_error,${stateSql} state FROM listings l LEFT JOIN analysis_tasks t ON t.listing_key=l.key AND t.run_id=?`;
    const conditions: string[] = [],
      values: string[] = [run?.id || ""];
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
      .map((row) => this.item(row));
    const ranking = this.db
      .prepare(
        `WITH products AS (${source}) SELECT * FROM products WHERE state='completed' AND (json_extract(result_json,'$.valuation.decision')='BUY' OR (json_extract(result_json,'$.valuation') IS NULL AND json_extract(result_json,'$.score') IS NOT NULL)) ORDER BY coalesce(json_extract(result_json,'$.valuation.price_difference_ratio'),json_extract(result_json,'$.valuation.margin_of_safety')) DESC,json_extract(result_json,'$.score') DESC,key ASC LIMIT 10`,
      )
      .all(run?.id || "")
      .map((row) => this.item(row));
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
    return {
      counts: this.counts(),
      run,
      activeRun: this.activeRun(),
      runs,
      ranking,
      records: { page, totalPages, total, items: records },
      history,
    };
  }
}
