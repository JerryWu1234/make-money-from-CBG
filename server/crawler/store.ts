import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { CAPTURE_VERSION, compactDetail, compactListing } from "./compact";
import type { Checkpoint, Listing, RoleDetail, SavedListingPage } from "./types";

export class CrawlStore {
  readonly db: DatabaseSync;
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
      CREATE TABLE IF NOT EXISTS role_tabs (listing_key TEXT NOT NULL, tab_index INTEGER NOT NULL, name TEXT NOT NULL, snapshot_json TEXT NOT NULL, PRIMARY KEY(listing_key,tab_index));
      CREATE TABLE IF NOT EXISTS role_parameters (listing_key TEXT NOT NULL, section TEXT NOT NULL, path TEXT NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(listing_key,section,path));
      CREATE TABLE IF NOT EXISTS crawl_state (id INTEGER PRIMARY KEY CHECK(id=1), checkpoint_json TEXT, backfill_complete INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS crawl_lock (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS role_sources (listing_key TEXT PRIMARY KEY, source_gzip BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS role_source_history (source_hash TEXT PRIMARY KEY, listing_key TEXT NOT NULL, source_gzip BLOB NOT NULL, archived_at TEXT NOT NULL);`);
    this.ensureListingColumn("attempt_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureListingColumn("last_attempt_at", "TEXT");
    this.ensureCrawlStateColumn("backfill_complete", "INTEGER NOT NULL DEFAULT 0");
    this.compactExisting();
  }
  acquire(owner: string, now = Date.now()): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO crawl_lock VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at WHERE crawl_lock.expires_at < ? OR crawl_lock.owner = ?`,
      )
      .run(owner, now + 120000, now, owner);
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
  backfillComplete(): boolean {
    return !!this.db.prepare("SELECT backfill_complete FROM crawl_state WHERE id=1").get()
      ?.backfill_complete;
  }
  markBackfillComplete() {
    this.db
      .prepare(
        "INSERT INTO crawl_state(id,backfill_complete) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET backfill_complete=1",
      )
      .run();
  }
  observe(item: Listing): boolean {
    const now = new Date().toISOString();
    const old = this.db
      .prepare(
        "SELECT status, selling_time, json_extract(detail_json,'$.captureVersion') AS version,json_array_length(json_extract(detail_json,'$.valuation.issues')) AS valuation_issues FROM listings WHERE key=?",
      )
      .get(item.key);
    // 同一商品重新上架时更新原记录、重采详情，不插入重复商品。
    const complete =
      old?.status === "complete" &&
      old.selling_time === item.sellingTime &&
      old.version === CAPTURE_VERSION &&
      !old.valuation_issues;
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
    if (!complete)
      this.db
        .prepare(
          "UPDATE listings SET status='pending',error=NULL,attempt_count=attempt_count+1,last_attempt_at=? WHERE key=?",
        )
        .run(now, item.key);
    return complete;
  }
  retryItems(keys?: string[]): Listing[] {
    return this.db
      .prepare(
        `SELECT listing_json FROM listings WHERE (status IN ('pending','failed') OR (status='complete' AND (coalesce(json_extract(detail_json,'$.captureVersion'),0) < ${CAPTURE_VERSION} OR json_array_length(json_extract(detail_json,'$.valuation.issues')) > 0)))
        ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,first_seen_at ASC,key ASC`,
      )
      .all()
      .map((row) => JSON.parse(String(row.listing_json)) as Listing)
      .filter((item) => !keys || keys.includes(item.key));
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
  beginRetry(key: string) {
    if (!this.retryItems([key]).length) throw new Error("待补采商品不存在或已完成");
    const result = this.db
      .prepare(
        "UPDATE listings SET status='pending',error=NULL,attempt_count=attempt_count+1,last_attempt_at=? WHERE key=?",
      )
      .run(new Date().toISOString(), key);
    if (result.changes !== 1) throw new Error("待补采商品不存在或已完成");
  }
  save(item: Listing, detail: RoleDetail, checkpoint?: Checkpoint) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.archive(item.key, detail);
      detail = compactDetail(detail);
      const result = this.db
        .prepare(
          "UPDATE listings SET listing_json=?,price=?,detail_json=?,status='complete',error=NULL,collected_at=? WHERE key=?",
        )
        .run(
          JSON.stringify(compactListing(item)),
          item.price,
          JSON.stringify(detail),
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
      if (checkpoint)
        this.db
          .prepare(
            "INSERT INTO crawl_state(id,checkpoint_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET checkpoint_json=excluded.checkpoint_json",
          )
          .run(JSON.stringify(checkpoint));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  fail(key: string, error: string) {
    this.db.prepare("UPDATE listings SET status='failed',error=? WHERE key=?").run(error, key);
  }
  count(): number {
    return Number(
      this.db.prepare("SELECT count(*) AS n FROM listings WHERE status='complete'").get()?.n || 0,
    );
  }
  recent() {
    return this.db
      .prepare(
        "SELECT key,name,price,selling_time,collected_at,status,error FROM listings ORDER BY last_seen_at DESC LIMIT 30",
      )
      .all();
  }
  records(requestedPage = 1, requestedSize = 20): SavedListingPage {
    const pageSize = Number.isFinite(requestedSize)
      ? Math.max(1, Math.min(100, Math.trunc(requestedSize)))
      : 20;
    const total = Number(this.db.prepare("SELECT count(*) AS n FROM listings").get()!.n);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Number.isFinite(requestedPage)
      ? Math.max(1, Math.min(totalPages, Math.trunc(requestedPage)))
      : 1;
    const rows = this.db
      .prepare(`SELECT key,name,price,url,server_id,selling_time,collected_at,last_seen_at,status,error,
      json_extract(listing_json,'$.serverName') AS server_name,
      json_extract(listing_json,'$.highlights') AS highlights,
      json_extract(listing_json,'$.summary.summary') AS summary,last_attempt_at,attempt_count,
      json_extract(detail_json,'$.captureVersion') capture_version,json_array_length(json_extract(detail_json,'$.valuation.issues')) valuation_issues
      FROM listings ORDER BY first_seen_at DESC,key ASC LIMIT ? OFFSET ?`)
      .all(pageSize, (page - 1) * pageSize);
    return {
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
          valuationReady: row.capture_version === CAPTURE_VERSION && !row.valuation_issues,
          status: String(row.status),
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
    this.db.exec("PRAGMA secure_delete=ON; BEGIN IMMEDIATE");
    try {
      for (const table of [
        "analysis_attempts",
        "analysis_tasks",
        "analysis_runs",
        "analysis_lock",
        "role_parameters",
        "role_tabs",
        "role_sources",
        "role_source_history",
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
