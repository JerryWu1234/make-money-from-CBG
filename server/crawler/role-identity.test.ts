import { expect, it, vi } from "vite-plus/test";
import { gunzipSync } from "node:zlib";
import { analysisRecord, valuationRecord } from "../../tests/fixtures/analysis";
import { AnalysisStore } from "../analysis/store";
import { AnalysisRunner } from "../analysis/runner";
import { createProfile } from "../analysis/profile";
import { captureIssues, collectCompleteCapture, IncompleteCaptureError } from "./capture-readiness";
import { CAPTURE_VERSION } from "./compact";
import { CrawlStore } from "./store";
import type { RoleDetail } from "./types";

function currentRecord(key = "identity-fixture") {
  const record = analysisRecord(key);
  const detail = record.detail!;
  detail.captureMode = "all";
  detail.captureVersion = CAPTURE_VERSION;
  detail.valuation = {
    version: 1,
    fields: [],
    issues: [],
    source: { serverId: record.listing.serverId, eid: record.listing.eid },
  };
  detail.tabs = detail.tabs.map((tab) =>
    tab.name === "技能"
      ? valuationRecord(key).detail!.tabs.find((entry) => entry.name === "技能")!
      : tab,
  );
  return record;
}

it.each([
  ["两项空串", { serverId: "", eid: "" }],
  ["缺服务器", { eid: "item-identity-fixture" }],
  ["缺商品", { serverId: "367" }],
  ["空白", { serverId: " 367", eid: "item-identity-fixture" }],
  ["无效服务器", { serverId: "abc", eid: "item-identity-fixture" }],
  ["无效商品", { serverId: "367", eid: "bad?query" }],
  ["不同服务器", { serverId: "750", eid: "item-identity-fixture" }],
  ["不同商品", { serverId: "367", eid: "another-item" }],
])("当前完整采集拒绝%s，裸号开关不能绕过身份核对", (_label, source) => {
  for (const mode of ["all", "body"] as const) {
    const record = currentRecord();
    record.detail!.captureMode = mode;
    record.detail!.valuation!.source = source;
    expect(captureIssues(record.detail!, true, mode === "all", record.listing).join("；")).toMatch(
      /身份/,
    );
  }
});

it("当前身份精确一致可通过；旧非当前合同不伪造身份也不强制升级", () => {
  const record = currentRecord();
  expect(captureIssues(record.detail!, true, true, record.listing)).toEqual([]);
  record.detail!.valuation!.source = {};
  delete record.detail!.captureMode;
  expect(captureIssues(record.detail!, false, true, record.listing)).toEqual([]);
  record.detail!.captureMode = "all";
  record.detail!.captureVersion = CAPTURE_VERSION - 1;
  expect(captureIssues(record.detail!, false, true, record.listing)).toEqual([]);
});

it.each(["missing", "mismatch"])(
  "%s身份有界重读后归档隔离，不发布、不推进成功断点",
  async (kind) => {
    const store = new CrawlStore(":memory:");
    const record = currentRecord();
    record.detail!.valuation!.source =
      kind === "missing" ? {} : { serverId: "367", eid: "another-item" };
    const read = vi.fn(async () => record.detail!);
    try {
      store.observe(record.listing);
      const error = await collectCompleteCapture(
        read,
        new AbortController().signal,
        vi.fn(),
        record.listing,
      ).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(IncompleteCaptureError);
      expect(read).toHaveBeenCalledTimes(3);
      const point = {
        key: record.listing.key,
        page: 1,
        order: "selling_time DESC",
        time: null,
        savedAt: "fixture",
      };
      expect(store.save(record.listing, (error as IncompleteCaptureError).detail, point)).toBe(
        false,
      );
      expect(store.count()).toBe(0);
      expect(store.countRoles()).toBe(0);
      expect(store.checkpoint()).toBeUndefined();
      expect(store.detail(record.listing.key)).toMatchObject({
        status: "failed",
        error: expect.stringMatching(/身份/),
      });
      const archived = JSON.parse(
        gunzipSync(
          store.db
            .prepare("SELECT source_gzip FROM role_sources WHERE listing_key=?")
            .get(record.listing.key)!.source_gzip as Uint8Array,
        ).toString(),
      ) as RoleDetail;
      expect(archived.valuation!.source).toEqual(record.detail!.valuation!.source);
    } finally {
      store.close();
    }
  },
);

it.each(["missing", "mismatch"])(
  "分析入口拒绝原有伪complete的%s身份，不创建模型任务",
  async (kind) => {
    const crawl = new CrawlStore(":memory:");
    const record = currentRecord();
    const store = new AnalysisStore(crawl.db);
    const profile = createProfile("身份门禁模拟设置", undefined, false);
    const analyze = vi.fn();
    const runner = new AnalysisRunner(store, async () => ({ model: "fixture-model", analyze }));
    try {
      crawl.observe(record.listing);
      record.detail!.valuation!.source =
        kind === "missing" ? {} : { serverId: "367", eid: "another-item" };
      crawl.db
        .prepare("UPDATE listings SET status='complete',detail_json=? WHERE key=?")
        .run(JSON.stringify(record.detail), record.listing.key);
      await expect(runner.start("codex", false, profile, true)).rejects.toThrow(/完整|身份/);
      expect(analyze).not.toHaveBeenCalled();
      expect(crawl.db.prepare("SELECT count(*) n FROM analysis_tasks").get()!.n).toBe(0);
    } finally {
      await runner.shutdown();
      crawl.close();
    }
  },
);

it("跟随采集追加不会接收伪complete身份，正常匹配后只入队一次", () => {
  const crawl = new CrawlStore(":memory:");
  const store = new AnalysisStore(crawl.db);
  const profile = createProfile("模拟设置", undefined, false);
  const record = currentRecord();
  const owner = "identity-owner";
  try {
    store.acquire(owner);
    const id = store.createRun("codex", "fixture-model", false, profile);
    crawl.observe(record.listing);
    const invalid = structuredClone(record.detail!);
    invalid.valuation!.source.eid = "another-item";
    crawl.db
      .prepare("UPDATE listings SET status='complete',detail_json=? WHERE key=?")
      .run(JSON.stringify(invalid), record.listing.key);
    expect(store.appendCaptured(id, owner)).toBe(0);
    expect(store.run(id)?.total).toBe(0);
    expect(crawl.save(record.listing, record.detail!)).toBe(true);
    expect(store.appendCaptured(id, owner)).toBe(1);
    expect(store.appendCaptured(id, owner)).toBe(0);
  } finally {
    crawl.close();
  }
});

it("继续分析拒绝未变化的旧伪complete，不改冻结输入或调用模型", async () => {
  const crawl = new CrawlStore(":memory:");
  const record = currentRecord();
  const store = new AnalysisStore(crawl.db);
  const profile = createProfile("模拟设置", undefined, false);
  const analyze = vi.fn();
  const runner = new AnalysisRunner(store, async () => ({ model: "fixture-model", analyze }));
  try {
    crawl.observe(record.listing);
    crawl.save(record.listing, record.detail!);
    const id = store.createRun("codex", "fixture-model", false, profile);
    record.detail!.valuation!.source.eid = "another-item";
    const frozen = JSON.stringify(record.detail);
    crawl.db
      .prepare("UPDATE listings SET detail_json=? WHERE key=?")
      .run(frozen, record.listing.key);
    crawl.db
      .prepare("UPDATE analysis_tasks SET source_detail_json=? WHERE run_id=?")
      .run(frozen, id);
    crawl.db.prepare("UPDATE analysis_runs SET status='paused' WHERE id=?").run(id);
    expect(() => store.refreshPendingCaptures(id)).toThrow(/完整|身份/);
    await runner.resume(id);
    await runner.settled();
    expect(store.run(id)).toMatchObject({ status: "paused", completed: 0 });
    expect(analyze).not.toHaveBeenCalled();
    expect(
      crawl.db.prepare("SELECT source_detail_json FROM analysis_tasks WHERE run_id=?").get(id)!
        .source_detail_json,
    ).toBe(frozen);
  } finally {
    await runner.shutdown();
    crawl.close();
  }
});

it("实际处理任务前仍核对身份，旧任务伪装complete也不会发模型请求", async () => {
  const crawl = new CrawlStore(":memory:");
  const record = currentRecord();
  const store = new AnalysisStore(crawl.db);
  const profile = createProfile("模拟设置", undefined, false);
  const analyze = vi.fn();
  const runner = new AnalysisRunner(store, async () => ({ model: "fixture-model", analyze }));
  try {
    crawl.observe(record.listing);
    crawl.save(record.listing, record.detail!);
    const next = store.next.bind(store);
    vi.spyOn(store, "next").mockImplementation((...args) => {
      const task = next(...args);
      if (task) task.record.detail!.valuation!.source.serverId = "750";
      return task;
    });
    const id = await runner.start("codex", false, profile, true);
    await runner.settled();
    expect(analyze).not.toHaveBeenCalled();
    expect(store.run(id)).toMatchObject({ status: "paused", completed: 0 });
  } finally {
    await runner.shutdown();
    crawl.close();
  }
});
