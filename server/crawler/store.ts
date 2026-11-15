import { AsyncLocalStorage } from "node:async_hooks";
import { AccessGovernor, type AccessContext, type CrawlLease } from "../access";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  CAPTURE_VERSION,
  compactDetail,
  compactListing,
  hasUnconfirmedEmptyEquipment,
} from "./compact";
import type {
  Checkpoint,
  CrawlLane,
  HeadCheckpoint,
  Listing,
  PageReview,
  RoleDetail,
  SavedListingPage,
  SavedListingScope,
} from "./types";
import { captureIssues } from "./capture-readiness";
import { diagnostics } from "../diagnostics";
import { trackRecordVersions } from "../record-versions";

const listingVersion = (row: Record<string, unknown>) =>
  JSON.stringify([row.server_id, row.eid, row.ordersn, row.selling_time, row.price]);

export class CrawlStore {
  readonly db: DatabaseSync;
  private businessLease = new AsyncLocalStorage<{
    owner: string;
    fence: number;
    versions: Map<string, string>;
    revisions: Map<string, number>;
  }>();
  crawlLease(owner: string): CrawlLease {
    const lease = this.db.prepare("SELECT owner,fence,expires_at FROM crawl_lock WHERE id=1").get();
    if (!lease || lease.owner !== owner || Number(lease.expires_at) <= Date.now())
      throw new Error("采集业务租约已失效");
    return { owner, fence: Number(lease.fence) };
  }
  withCrawlLease<T>(owner: string, work: () => T): T {
    const lease = this.crawlLease(owner);
    this.businessLease ??= new AsyncLocalStorage();
    return this.businessLease.run({ ...lease, versions: new Map(), revisions: new Map() }, work);
  }
  private assertBusinessLease() {
    const context = this.businessLease?.getStore();
    const lease = this.db.prepare("SELECT owner,fence,expires_at FROM crawl_lock WHERE id=1").get();
    if (
      !context ||
      !lease ||
      lease.owner !== context.owner ||
      lease.fence !== context.fence ||
      Number(lease.expires_at) <= Date.now()
    )
      throw new Error("采集业务租约或停止代次已变化，旧任务不能推进进度");
  }
  private progressContext?: AccessContext | (() => AccessContext | undefined);
  private currentProgressContext() {
    return typeof this.progressContext === "function"
      ? this.progressContext()
      : this.progressContext;
  }
  private recordRevision(key: string) {
    return Number(
      this.db
        .prepare("SELECT revision FROM record_versions WHERE entity='listings' AND record_key=?")
        .get(key)?.revision ?? 0,
    );
  }
  private rememberAttemptRevision(key: string) {
    this.businessLease?.getStore()?.revisions.set(key, this.recordRevision(key));
  }
  private assertAttemptRevision(key: string) {
    const expected = this.businessLease?.getStore()?.revisions.get(key);
    if (expected === undefined || expected !== this.recordRevision(key))
      throw new Error("商品资料或尝试版本已变化，旧任务只能归档");
  }
  private archiveAttemptError(
    key: string,
    error: string,
    kind: "failure" | "unavailable",
    context?: AccessContext,
  ) {
    this.db
      .prepare(
        "INSERT INTO crawl_attempt_errors(listing_key,error,kind,context_json,created_at) VALUES(?,?,?,?,?)",
      )
      .run(
        key,
        error,
        kind,
        JSON.stringify(context ?? this.currentProgressContext() ?? null),
        new Date().toISOString(),
      );
  }
  private assertAvailabilityProof(key: string, context: AccessContext) {
    const worker = this.businessLease?.getStore();
    if (
      !context.crawlLease ||
      context.crawlLease.owner !== worker?.owner ||
      context.crawlLease.fence !== worker?.fence
    )
      throw new Error("下架证据不属于当前业务租约");
    const result = this.db
      .prepare("SELECT identity_json,accepted FROM query_health_results WHERE query_id=?")
      .get(context.queryId);
    const listing = this.db
      .prepare("SELECT server_id,eid,ordersn FROM listings WHERE key=?")
      .get(key);
    const identity = result ? JSON.parse(String(result.identity_json)) : undefined;
    if (
      result?.accepted !== 1 ||
      !listing ||
      identity?.category !== "role-availability" ||
      identity.server !== listing.server_id ||
      identity.conditions?.eid !== listing.eid ||
      identity.conditions?.ordersn !== listing.ordersn
    )
      throw new Error("下架证据未核验当前商品身份");
  }
  private accessGovernor?: AccessGovernor;
  setProgressContext(context: AccessContext | (() => AccessContext | undefined) | undefined) {
    this.progressContext = context;
  }
  private progressGate() {
    if (
      !this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='access_schema'")
        .get()
    )
      return undefined;
    return (this.accessGovernor ??= new AccessGovernor(this.db));
  }
  private progressWrite<T>(write: () => T): T {
    const gate = this.progressGate();
    if (!gate) return write();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (gate) {
        this.assertBusinessLease();
        const context = this.currentProgressContext();
        if (!context) throw new Error("缺少当前官网查询身份，不能推进采集进度");
        gate.assertProgress(context);
      }
      const value = write();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private retrySnapshot?: { changes: number; version: number; listings: string[] };
  private pageReviewSchemaReady?: boolean;
  constructor(readonly filename = path.resolve("data/cbg.sqlite")) {
    if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS listings (
        key TEXT PRIMARY KEY, server_id TEXT NOT NULL, eid TEXT NOT NULL, ordersn TEXT NOT NULL,
        url TEXT NOT NULL, selling_time TEXT, created_time TEXT, name TEXT NOT NULL, price TEXT NOT NULL,
        listing_json TEXT NOT NULL, detail_json TEXT, status TEXT NOT NULL DEFAULT 'pending', error TEXT,
        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, collected_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0, last_attempt_at TEXT
      );
      CREATE INDEX IF NOT EXISTS listings_selling_time ON listings(selling_time);
      CREATE INDEX IF NOT EXISTS listings_status_collected ON listings(status,collected_at DESC,key DESC);
      CREATE INDEX IF NOT EXISTS listings_recent ON listings(last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS listings_first_seen ON listings(first_seen_at DESC,key ASC);
      CREATE INDEX IF NOT EXISTS listings_capture_queue ON listings(status,first_seen_at,key)
        WHERE status IN ('pending','failed');
      CREATE INDEX IF NOT EXISTS listings_complete_keys ON listings(key)
        WHERE status='complete' AND detail_json IS NOT NULL;
      CREATE TABLE IF NOT EXISTS role_tabs (listing_key TEXT NOT NULL, tab_index INTEGER NOT NULL, name TEXT NOT NULL, snapshot_json TEXT NOT NULL, PRIMARY KEY(listing_key,tab_index));
      CREATE TABLE IF NOT EXISTS role_parameters (listing_key TEXT NOT NULL, section TEXT NOT NULL, path TEXT NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(listing_key,section,path));
      CREATE TABLE IF NOT EXISTS crawl_state (id INTEGER PRIMARY KEY CHECK(id=1), checkpoint_json TEXT, backfill_complete INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS crawl_lock (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS role_sources (listing_key TEXT PRIMARY KEY, source_gzip BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS crawl_attempt_errors (id INTEGER PRIMARY KEY,listing_key TEXT NOT NULL,error TEXT NOT NULL,kind TEXT NOT NULL,context_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS role_source_history (source_hash TEXT PRIMARY KEY, listing_key TEXT NOT NULL, source_gzip BLOB NOT NULL, archived_at TEXT NOT NULL);`);
    if (
      !this.db
        .prepare("PRAGMA table_info(crawl_lock)")
        .all()
        .some((column) => column.name === "fence")
    )
      this.db.exec("ALTER TABLE crawl_lock ADD COLUMN fence INTEGER NOT NULL DEFAULT 1");
    this.ensureListingColumn("attempt_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureListingColumn("last_attempt_at", "TEXT");
    this.ensureListingColumn("capture_lane", "TEXT NOT NULL DEFAULT 'old'");
    this.ensureCrawlStateColumn("backfill_complete", "INTEGER NOT NULL DEFAULT 0");
    this.ensureCrawlStateColumn("head_checkpoint_json", "TEXT");
    this.ensureCrawlStateColumn("page_reviews_json", "TEXT");
    this.pageReviewSchemaReady = true;
    trackRecordVersions(this.db, "listings");
    this.compactExisting();
    for (const row of this.db
      .prepare(
        "SELECT key,listing_json,detail_json FROM listings WHERE status='complete' AND detail_json IS NOT NULL",
      )
      .all()) {
      const detail = JSON.parse(String(row.detail_json)) as RoleDetail;
      const issues = captureIssues(
        detail,
        false,
        true,
        JSON.parse(String(row.listing_json)) as Listing,
      );
      if (
        (detail.equipmentCapture || detail.petCapture) &&
        detail.captureVersion !== CAPTURE_VERSION
      )
        issues.push("采集核验规则已更新，需重新完整采集角色资料");
      if (issues.length)
        this.db
          .prepare("UPDATE listings SET status='failed',error=? WHERE key=?")
          .run("采集资料尚未完整：" + issues.join("；"), row.key);
    }
  }
  acquire(owner: string, now = Date.now()): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO crawl_lock(id,owner,expires_at,fence) VALUES(1,?,?,1) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at, fence=CASE WHEN crawl_lock.owner=excluded.owner AND crawl_lock.expires_at>? THEN crawl_lock.fence ELSE crawl_lock.fence+1 END WHERE crawl_lock.expires_at < ? OR crawl_lock.owner = ?`,
      )
      .run(owner, now + 120000, now, now, owner);
    return result.changes === 1;
  }
  release(owner: string) {
    this.db.prepare("DELETE FROM crawl_lock WHERE owner=?").run(owner);
  }
  checkpoint(): Checkpoint | undefined {
    const row = this.db.prepare("SELECT checkpoint_json FROM crawl_state WHERE id=1").get();
    return row?.checkpoint_json
      ? (JSON.parse(String(row.checkpoint_json)) as Checkpoint)
      : undefined;
  }
  headCheckpoint(): HeadCheckpoint | undefined {
    const row = this.db.prepare("SELECT head_checkpoint_json FROM crawl_state WHERE id=1").get();
    return row?.head_checkpoint_json
      ? (JSON.parse(String(row.head_checkpoint_json)) as HeadCheckpoint)
      : undefined;
  }
  setHeadCheckpoint(point: HeadCheckpoint) {
    return this.progressWrite(() => {
      if (
        !Number.isFinite(Date.parse(point.time)) ||
        !point.keys.length ||
        point.keys.some((key) => typeof key !== "string" || !key.trim()) ||
        new Set(point.keys).size !== point.keys.length
      )
        throw new Error("首页巡检边界无效");
      this.db
        .prepare(`INSERT INTO crawl_state(id,head_checkpoint_json) VALUES(1,?)
      ON CONFLICT(id) DO UPDATE SET head_checkpoint_json=excluded.head_checkpoint_json`)
        .run(JSON.stringify(point));
    });
  }
  captureLane(key: string): CrawlLane {
    return this.db.prepare("SELECT capture_lane FROM listings WHERE key=?").get(key)
      ?.capture_lane === "new"
      ? "new"
      : "old";
  }
  backfillComplete(): boolean {
    return !!this.db.prepare("SELECT backfill_complete FROM crawl_state WHERE id=1").get()
      ?.backfill_complete;
  }
  markBackfillComplete() {
    return this.progressWrite(() => {
      if (this.pageReviews().length) return;
      this.db
        .prepare(
          "INSERT INTO crawl_state(id,backfill_complete) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET backfill_complete=1",
        )
        .run();
    });
  }
  pageReviews(order?: string): PageReview[] {
    // The dev server retains the live store across module reloads, including pre-migration instances.
    if (!this.pageReviewSchemaReady) {
      this.ensureCrawlStateColumn("page_reviews_json", "TEXT");
      this.pageReviewSchemaReady = true;
    }
    const row = this.db.prepare("SELECT page_reviews_json FROM crawl_state WHERE id=1").get();
    const reviews: PageReview[] = row?.page_reviews_json
      ? JSON.parse(String(row.page_reviews_json))
      : [];
    return reviews
      .filter((review) => order === undefined || review.order === order)
      .sort((left, right) => left.order.localeCompare(right.order) || left.page - right.page);
  }
  deferPageReview(order: string, page: number, signature: string) {
    return this.progressWrite(() => {
      if (!order.trim() || !Number.isSafeInteger(page) || page < 1 || !signature)
        throw new Error("待复核列表页无效");
      const reviews = this.pageReviews();
      const previous = reviews.find((review) => review.order === order && review.page === page);
      if (previous) previous.signature = signature;
      else reviews.push({ order, page, signature, detectedAt: new Date().toISOString() });
      this.db
        .prepare(`INSERT INTO crawl_state(id,page_reviews_json,backfill_complete) VALUES(1,?,0)
        ON CONFLICT(id) DO UPDATE SET page_reviews_json=excluded.page_reviews_json,backfill_complete=0`)
        .run(JSON.stringify(reviews));
    });
  }
  resolvePageReview(order: string, page: number) {
    return this.progressWrite(() => {
      const reviews = this.pageReviews();
      const remaining = reviews.filter((review) => review.order !== order || review.page !== page);
      if (remaining.length === reviews.length) return;
      this.db
        .prepare("UPDATE crawl_state SET page_reviews_json=? WHERE id=1")
        .run(JSON.stringify(remaining));
    });
  }
  hasListing(key: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM listings WHERE key=?").get(key);
  }
  observe(item: Listing, lane: CrawlLane = "old"): boolean {
    return this.progressWrite(() => {
      if (lane !== "new" && lane !== "old") throw new Error("采集任务来源无效");
      const now = new Date().toISOString();
      const old = this.db
        .prepare(
          "SELECT status, selling_time, detail_json, json_extract(detail_json,'$.captureVersion') AS version,json_array_length(json_extract(detail_json,'$.valuation.issues')) AS valuation_issues,json_extract(detail_json,'$.equipmentCapture.complete') AS equipment_complete,json_array_length(json_extract(detail_json,'$.equipmentCapture.issues')) AS equipment_issues,json_extract(detail_json,'$.petCapture.complete') AS pet_complete,json_array_length(json_extract(detail_json,'$.petCapture.issues')) AS pet_issues FROM listings WHERE key=?",
        )
        .get(item.key);
      // 同一商品重新上架时更新原记录、重采详情，不插入重复商品。
      const complete =
        old?.status === "complete" &&
        old.selling_time === item.sellingTime &&
        old.version === CAPTURE_VERSION &&
        !old.valuation_issues &&
        old.equipment_complete === 1 &&
        !old.equipment_issues &&
        old.pet_complete === 1 &&
        !old.pet_issues &&
        !hasUnconfirmedEmptyEquipment(old.detail_json ? JSON.parse(String(old.detail_json)) : null);
      this.db
        .prepare(`INSERT INTO listings(key,server_id,eid,ordersn,url,selling_time,created_time,name,price,listing_json,first_seen_at,last_seen_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET ordersn=excluded.ordersn,url=excluded.url,selling_time=excluded.selling_time,
      created_time=excluded.created_time,name=excluded.name,price=excluded.price,listing_json=excluded.listing_json,last_seen_at=excluded.last_seen_at`)
        .run(
          item.key,
          item.serverId,
          item.eid,
          item.ordersn,
          item.url,
          item.sellingTime,
          item.createdTime,
          item.name,
          item.price,
          JSON.stringify(compactListing(item)),
          now,
          now,
        );
      if (lane === "new")
        this.db.prepare("UPDATE listings SET capture_lane='new' WHERE key=?").run(item.key);
      // 列表重现不是一次详情重试；同一上架版本保留原失败原因，实际派发时才清除。
      if (
        !complete &&
        old?.status !== "unavailable" &&
        !(old?.status === "failed" && old.selling_time === item.sellingTime)
      )
        this.db
          .prepare("UPDATE listings SET status='pending',error=NULL WHERE key=?")
          .run(item.key);
      return complete || old?.status === "unavailable";
    });
  }
  /** Steady-state dispatch reads only queued metadata; legacy validation stays in retryItems. */
  pendingItems(): Listing[] {
    return this.db
      .prepare(`SELECT listing_json FROM listings WHERE status IN ('pending','failed')
      ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,first_seen_at ASC,key ASC`)
      .all()
      .map((row) => JSON.parse(String(row.listing_json)) as Listing);
  }
  retryItems(keys?: string[], refresh = false): Listing[] {
    if (refresh) {
      if (keys?.length !== 1 || !keys[0]?.trim() || keys[0] !== keys[0].trim())
        throw new Error("刷新采集仅支持明确指定一个已保存商品");
      const row = this.db
        .prepare(
          "SELECT listing_json FROM listings WHERE key=? AND status IN ('pending','failed','complete')",
        )
        .get(keys[0]);
      if (!row) {
        const unavailable = this.unavailableReason(keys[0]);
        if (unavailable) throw new Error(unavailable);
        throw new Error("指定刷新商品不存在");
      }
      return [JSON.parse(String(row.listing_json)) as Listing];
    }
    const selectedKeys = keys ? new Set(keys) : undefined;
    if (selectedKeys?.size === 0) return [];
    const snapshot =
      selectedKeys || this.db.isTransaction
        ? undefined
        : {
            changes: Number(this.db.prepare("SELECT total_changes() AS n").get()!.n),
            version: Number(this.db.prepare("PRAGMA data_version").get()!.data_version),
          };
    if (
      snapshot &&
      snapshot.changes === this.retrySnapshot?.changes &&
      snapshot.version === this.retrySnapshot.version
    )
      return this.retrySnapshot.listings.map((listing) => JSON.parse(listing) as Listing);
    // 排序只携带轻量键，避免详情原文随排序记录写入临时文件；派发单件时先按主键缩小范围。
    const orderedKeys = this.db
      .prepare(
        `SELECT key FROM listings WHERE status IN ('pending','failed','complete')
        ${selectedKeys ? `AND key IN (${Array.from(selectedKeys, () => "?").join(",")})` : ""}
        ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,first_seen_at ASC,key ASC`,
      )
      .all(...(selectedKeys || []));
    const read = this.db.prepare(
      `SELECT listing_json,detail_json,(status IN ('pending','failed') OR (status='complete' AND (coalesce(json_extract(detail_json,'$.captureVersion'),0) < ${CAPTURE_VERSION} OR json_array_length(json_extract(detail_json,'$.valuation.issues')) > 0 OR coalesce(json_extract(detail_json,'$.equipmentCapture.complete'),0)!=1 OR json_array_length(json_extract(detail_json,'$.equipmentCapture.issues'))>0 OR coalesce(json_extract(detail_json,'$.petCapture.complete'),0)!=1 OR json_array_length(json_extract(detail_json,'$.petCapture.issues'))>0))) AS needs_retry FROM listings WHERE key=?`,
    );
    const items: Listing[] = [];
    for (const { key } of orderedKeys) {
      const row = read.get(key);
      if (
        row &&
        (row.needs_retry ||
          hasUnconfirmedEmptyEquipment(
            row.detail_json ? JSON.parse(String(row.detail_json)) : null,
          ))
      ) {
        const item = JSON.parse(String(row.listing_json)) as Listing;
        if (!selectedKeys || selectedKeys.has(item.key)) items.push(item);
      }
    }
    if (snapshot)
      this.retrySnapshot = { ...snapshot, listings: items.map((item) => JSON.stringify(item)) };
    return items;
  }
  anchorItems(): Listing[] {
    const items = this.db
      .prepare(
        "SELECT listing_json FROM listings WHERE status='complete' AND collected_at IS NOT NULL ORDER BY collected_at DESC,key DESC",
      )
      .all()
      .map((row) => JSON.parse(String(row.listing_json)) as Listing);
    const point = this.checkpoint();
    const last = point && items.find((item) => item.key === point.key);
    return last ? [last, ...items.filter((item) => item.key !== last.key)] : items;
  }
  /** Freeze an anchor's source version without demoting its saved complete snapshot. */
  beginAvailabilityCheck(key: string) {
    const gate = this.progressGate();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (gate) {
        this.assertBusinessLease();
        const context = this.currentProgressContext();
        if (!context) throw new Error("缺少当前官网任务身份");
        gate.assertActivity(context);
      }
      const current = this.db
        .prepare("SELECT server_id,eid,ordersn,selling_time,price FROM listings WHERE key=?")
        .get(key);
      if (!current) throw new Error("待核验商品不存在");
      this.businessLease?.getStore()?.versions.set(key, listingVersion(current));
      this.rememberAttemptRevision(key);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  beginRetry(key: string, refresh = false) {
    const gate = this.progressGate();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Starting a local attempt precedes its detail query; it requires a live runnable
      // worker, but cannot claim that the not-yet-run detail query was accepted.
      if (gate) {
        this.assertBusinessLease();
        const context = this.currentProgressContext();
        if (!context) throw new Error("缺少当前官网任务身份");
        gate.assertActivity(context);
      }
      const current = this.db
        .prepare("SELECT server_id,eid,ordersn,selling_time,price FROM listings WHERE key=?")
        .get(key);
      if (!this.retryItems([key], refresh).length) throw new Error("待补采商品不存在或已完成");
      const result = this.db
        .prepare(
          "UPDATE listings SET status='pending',error=NULL,attempt_count=attempt_count+1,last_attempt_at=? WHERE key=?",
        )
        .run(new Date().toISOString(), key);
      if (result.changes !== 1) throw new Error("待补采商品不存在或已完成");
      if (current) this.businessLease?.getStore()?.versions.set(key, listingVersion(current));
      this.rememberAttemptRevision(key);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  save(item: Listing, detail: RoleDetail, checkpoint?: Checkpoint) {
    return this.persistDetail(item, detail, checkpoint, false);
  }
  savePartial(item: Listing, detail: RoleDetail) {
    return this.persistDetail(item, detail, undefined, true);
  }
  private persistDetail(
    item: Listing,
    detail: RoleDetail,
    checkpoint: Checkpoint | undefined,
    partial: boolean,
  ) {
    if (this.unavailableReason(item.key)) return false;
    if (
      partial &&
      this.db.prepare("SELECT 1 FROM listings WHERE key=? AND status='complete'").get(item.key)
    )
      return false;
    const issues = captureIssues(detail, false, true, item);
    const complete = !partial && issues.length === 0;
    const gate = this.progressGate();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Re-read version and status under the same write lock as the update. A newer
      // connection may have committed between the earlier reuse checks and BEGIN.
      const current = this.db
        .prepare(
          "SELECT status,collected_at,server_id,eid,ordersn,selling_time,price FROM listings WHERE key=?",
        )
        .get(item.key);
      const newer =
        current &&
        Number.isFinite(Date.parse(String(current.collected_at))) &&
        Number.isFinite(Date.parse(detail.collectedAt)) &&
        Date.parse(String(current.collected_at)) > Date.parse(detail.collectedAt);
      const differentListing =
        current &&
        (current.server_id !== item.serverId ||
          current.eid !== item.eid ||
          current.ordersn !== item.ordersn ||
          current.selling_time !== item.sellingTime ||
          (this.businessLease?.getStore()?.versions.has(item.key) &&
            this.businessLease.getStore()!.versions.get(item.key) !== listingVersion(current)));
      if (
        current &&
        (current.status === "unavailable" ||
          (partial && current.status === "complete") ||
          newer ||
          differentListing)
      ) {
        this.archiveOnly(item.key, detail);
        this.db.exec("COMMIT");
        return false;
      }
      if (gate && partial) {
        try {
          this.assertBusinessLease();
          this.assertAttemptRevision(item.key);
        } catch {
          this.archiveOnly(item.key, detail);
          this.db.exec("COMMIT");
          return false;
        }
      }
      if (gate && !partial) {
        const context =
          detail.accessContext ||
          (typeof this.progressContext === "function"
            ? this.progressContext()
            : this.progressContext);
        try {
          this.assertBusinessLease();
          this.assertAttemptRevision(item.key);
          if (!context) throw new Error("缺少当前官网查询身份");
          gate.assertProgress(context);
        } catch {
          this.archiveOnly(item.key, detail);
          this.db.exec("COMMIT");
          return false;
        }
      }
      this.archive(item.key, detail);
      detail = compactDetail(detail);
      const result = this.db
        .prepare(
          "UPDATE listings SET listing_json=?,price=?,detail_json=?,status=?,error=?,collected_at=? WHERE key=?",
        )
        .run(
          JSON.stringify(compactListing(item)),
          item.price,
          JSON.stringify(detail),
          partial ? "pending" : complete ? "complete" : "failed",
          partial
            ? "采集已暂停，已保留已读资料，等待继续补齐"
            : complete
              ? null
              : "采集资料尚未完整：" + issues.join("；"),
          detail.collectedAt,
          item.key,
        );
      if (result.changes !== 1) throw new Error("商品尚未登记，不能推进断点");
      this.db.prepare("DELETE FROM role_tabs WHERE listing_key=?").run(item.key);
      this.db.prepare("DELETE FROM role_parameters WHERE listing_key=?").run(item.key);
      const tabInsert = this.db.prepare("INSERT INTO role_tabs VALUES(?,?,?,?)");
      const fieldInsert = this.db.prepare("INSERT INTO role_parameters VALUES(?,?,?,?)");
      detail.tabs.forEach((tab, index) => {
        tabInsert.run(item.key, index, tab.name, JSON.stringify(tab));
        tab.fields.forEach((field, fieldIndex) =>
          fieldInsert.run(
            item.key,
            `tab:${index}`,
            `${fieldIndex}:${field.name}`,
            JSON.stringify(field.value),
          ),
        );
      });
      const flatten = (value: unknown, pointer: string, section = "raw") => {
        if (value !== null && typeof value === "object" && Object.keys(value).length) {
          for (const [key, child] of Object.entries(value))
            flatten(
              child,
              `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
              section,
            );
        } else fieldInsert.run(item.key, section, pointer, JSON.stringify(value));
      };
      flatten(detail.raw, "");
      detail.tabs.forEach((tab, index) => flatten(tab.items || [], "", `items:${index}`));
      detail.tabs.forEach((tab, index) => flatten(tab.pets || [], "", `pets:${index}`));
      if (checkpoint && complete)
        this.db
          .prepare(
            "INSERT INTO crawl_state(id,checkpoint_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET checkpoint_json=excluded.checkpoint_json",
          )
          .run(JSON.stringify(checkpoint));
      this.rememberAttemptRevision(item.key);
      this.db.exec("COMMIT");
      return complete;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  fail(key: string, error: string) {
    return this.finishAttempt(key, error, "failure");
  }
  markUnavailable(key: string, reason: string, context?: AccessContext) {
    return this.finishAttempt(key, reason, "unavailable", context);
  }
  private finishAttempt(
    key: string,
    error: string,
    kind: "failure" | "unavailable",
    proof?: AccessContext,
  ) {
    const gate = this.progressGate();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.archiveAttemptError(key, error, kind, proof);
      if (gate) {
        try {
          this.assertBusinessLease();
          this.assertAttemptRevision(key);
          const context = kind === "unavailable" ? proof : this.currentProgressContext();
          if (!context) throw new Error("缺少当前官网查询身份");
          if (kind === "unavailable") {
            gate.assertProgress(context);
            this.assertAvailabilityProof(key, context);
          } else gate.assertActivity(context);
        } catch {
          this.db.exec("COMMIT");
          return false;
        }
      }
      // Local errors never demote a complete snapshot. Only accepted official
      // unavailability for this exact attempt may publish the online terminal state.
      const result = this.db
        .prepare(
          kind === "unavailable"
            ? "UPDATE listings SET status='unavailable',error=? WHERE key=?"
            : `UPDATE listings SET status='failed',error=? WHERE key=? AND status!='unavailable'${gate ? " AND status!='complete'" : ""}`,
        )
        .run(error, key);
      this.rememberAttemptRevision(key);
      this.db.exec("COMMIT");
      if (kind === "unavailable" && result.changes)
        diagnostics.record("crawl.item_unavailable", {
          key,
          reason: error,
          action: "skip_without_retry",
        });
      return result.changes === 1;
    } catch (failure) {
      this.db.exec("ROLLBACK");
      throw failure;
    }
  }
  unavailableReason(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT error FROM listings WHERE key=? AND status='unavailable'")
      .get(key);
    return row ? String(row.error || "官网商品已不存在，无法补齐，已跳过且不再重试") : undefined;
  }
  count(): number {
    return Number(
      this.db.prepare("SELECT count(*) AS n FROM listings WHERE status='complete'").get()?.n || 0,
    );
  }
  latestComplete(): { key: string; collectedAt: string } | undefined {
    const row = this.db
      .prepare(
        "SELECT key,collected_at FROM listings WHERE status='complete' AND collected_at IS NOT NULL ORDER BY collected_at DESC,key DESC LIMIT 1",
      )
      .get();
    return row ? { key: String(row.key), collectedAt: String(row.collected_at) } : undefined;
  }
  recent() {
    return this.db
      .prepare(
        "SELECT key,name,price,selling_time,collected_at,status,error FROM listings ORDER BY last_seen_at DESC LIMIT 30",
      )
      .all();
  }
  records(
    requestedPage = 1,
    requestedSize = 20,
    scope: SavedListingScope = "all",
  ): SavedListingPage {
    const pageSize = Number.isFinite(requestedSize)
      ? Math.max(1, Math.min(100, Math.trunc(requestedSize)))
      : 20;
    const where =
      scope === "complete"
        ? " WHERE status='complete' AND detail_json IS NOT NULL"
        : scope === "tasks"
          ? " WHERE status!='complete' OR detail_json IS NULL"
          : "";
    const total = Number(this.db.prepare("SELECT count(*) AS n FROM listings" + where).get()!.n);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Number.isFinite(requestedPage)
      ? Math.max(1, Math.min(totalPages, Math.trunc(requestedPage)))
      : 1;
    const rows = this.db
      .prepare(`SELECT key,name,price,url,server_id,selling_time,collected_at,last_seen_at,status,error,detail_json,
      json_extract(listing_json,'$.serverName') AS server_name,
      json_extract(listing_json,'$.highlights') AS highlights,
      json_extract(listing_json,'$.summary.summary') AS summary,last_attempt_at,attempt_count,
      json_extract(detail_json,'$.captureVersion') capture_version,json_array_length(json_extract(detail_json,'$.valuation.issues')) valuation_issues,
      json_extract(detail_json,'$.equipmentCapture.complete') equipment_complete,json_array_length(json_extract(detail_json,'$.equipmentCapture.issues')) equipment_issues,
      json_extract(detail_json,'$.petCapture.complete') pet_complete,json_array_length(json_extract(detail_json,'$.petCapture.issues')) pet_issues
      FROM listings${where} ORDER BY first_seen_at DESC,key ASC LIMIT ? OFFSET ?`)
      .all(pageSize, (page - 1) * pageSize);
    return {
      scope,
      page,
      pageSize,
      total,
      totalPages,
      items: rows.map((row) => {
        const highlights = row.highlights ? (JSON.parse(String(row.highlights)) as string[]) : [];
        return {
          key: String(row.key),
          name: String(row.name),
          price: String(row.price),
          url: String(row.url),
          serverId: String(row.server_id),
          serverName: String(row.server_name || ""),
          highlights: highlights.length ? highlights : row.summary ? [String(row.summary)] : [],
          sellingTime: row.selling_time ? String(row.selling_time) : null,
          collectedAt: row.collected_at ? String(row.collected_at) : null,
          lastSeenAt: String(row.last_seen_at),
          lastAttemptAt: row.last_attempt_at ? String(row.last_attempt_at) : null,
          attemptCount: Number(row.attempt_count || 0),
          valuationReady:
            row.status === "complete" &&
            row.capture_version === CAPTURE_VERSION &&
            !row.valuation_issues &&
            row.equipment_complete === 1 &&
            !row.equipment_issues &&
            row.pet_complete === 1 &&
            !row.pet_issues &&
            !hasUnconfirmedEmptyEquipment(
              row.detail_json ? JSON.parse(String(row.detail_json)) : null,
            ),
          status: String(row.status),
          published: row.status === "complete" && row.detail_json !== null,
          error: row.error ? String(row.error) : null,
        };
      }),
    };
  }
  detail(key: string): unknown {
    const row = this.db
      .prepare("SELECT listing_json,detail_json,status,error FROM listings WHERE key=?")
      .get(key);
    return row
      ? {
          listing: JSON.parse(String(row.listing_json)),
          detail: row.detail_json ? JSON.parse(String(row.detail_json)) : null,
          status: row.status,
          error: row.error,
        }
      : null;
  }
  close() {
    this.db.close();
  }
  clear() {
    this.db.exec("PRAGMA secure_delete=ON; BEGIN IMMEDIATE");
    try {
      const hasAnalysis = this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='analysis_lock'")
        .get();
      if (
        hasAnalysis &&
        this.db.prepare("SELECT 1 FROM analysis_lock WHERE expires_at>? LIMIT 1").get(Date.now())
      )
        throw new Error("分析任务仍在执行，请先暂停分析再清空数据");
      if (this.db.prepare("SELECT 1 FROM crawl_lock WHERE expires_at>? LIMIT 1").get(Date.now()))
        throw new Error("采集任务仍持有锁，请先暂停再清空数据");
      for (const table of [
        "recommendation_views",
        "analysis_school_formula_confirmations",
        "analysis_attempts",
        "analysis_tasks",
        "analysis_runs",
        "analysis_lock",
        "role_parameters",
        "role_tabs",
        "role_sources",
        "role_source_history",
        "crawl_attempt_errors",
        "crawl_state",
        "crawl_lock",
        "listings",
      ])
        if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
          this.db.exec(`DELETE FROM ${table}`);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  private archive(key: string, detail: RoleDetail) {
    const previous = this.db
      .prepare("SELECT source_gzip FROM role_sources WHERE listing_key=?")
      .get(key);
    if (previous) {
      const source = previous.source_gzip as Uint8Array;
      this.db
        .prepare("INSERT OR IGNORE INTO role_source_history VALUES(?,?,?,?)")
        .run(
          createHash("sha256").update(source).digest("hex"),
          key,
          source,
          new Date().toISOString(),
        );
    }
    this.db
      .prepare(
        "INSERT INTO role_sources VALUES(?,?) ON CONFLICT(listing_key) DO UPDATE SET source_gzip=excluded.source_gzip",
      )
      .run(key, gzipSync(JSON.stringify(detail)));
  }
  private archiveOnly(key: string, detail: RoleDetail) {
    const source = gzipSync(JSON.stringify(detail));
    this.db
      .prepare("INSERT OR IGNORE INTO role_source_history VALUES(?,?,?,?)")
      .run(
        createHash("sha256").update(source).digest("hex"),
        key,
        source,
        new Date().toISOString(),
      );
  }
  private ensureListingColumn(name: string, definition: string) {
    const exists = this.db
      .prepare("SELECT 1 FROM pragma_table_info('listings') WHERE name=?")
      .get(name);
    if (!exists) this.db.exec(`ALTER TABLE listings ADD COLUMN ${name} ${definition}`);
  }
  private ensureCrawlStateColumn(name: string, definition: string) {
    const exists = this.db
      .prepare("SELECT 1 FROM pragma_table_info('crawl_state') WHERE name=?")
      .get(name);
    if (!exists) this.db.exec(`ALTER TABLE crawl_state ADD COLUMN ${name} ${definition}`);
  }
  private compactExisting() {
    const old = this.db
      .prepare(
        "SELECT key,listing_json,detail_json FROM listings WHERE detail_json IS NOT NULL AND coalesce(json_extract(detail_json,'$.formatVersion'),0)<2",
      )
      .all();
    if (!old.length) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of old) {
        const key = String(row.key);
        const original: RoleDetail = JSON.parse(String(row.detail_json));
        this.archive(key, original);
        const detail = compactDetail(original);
        this.db
          .prepare("UPDATE listings SET listing_json=?,detail_json=? WHERE key=?")
          .run(
            JSON.stringify(compactListing(JSON.parse(String(row.listing_json)))),
            JSON.stringify(detail),
            key,
          );
        this.db.prepare("DELETE FROM role_tabs WHERE listing_key=?").run(key);
        detail.tabs.forEach((tab, index) =>
          this.db
            .prepare("INSERT INTO role_tabs VALUES(?,?,?,?)")
            .run(key, index, tab.name, JSON.stringify(tab)),
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
