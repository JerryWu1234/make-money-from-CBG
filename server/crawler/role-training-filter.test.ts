import { afterEach, expect, it, vi } from "vite-plus/test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { trainingTotal } from "./role-training-filter";
import { RoleTrainingSettingsStore } from "./role-training-settings";
import { crawl, validateCrawlOptions } from "./runner";
import { CrawlStore } from "./store";
import { CAPTURE_VERSION } from "./compact";
import type { CrawlSource, CrawlStatus, Listing, RoleDetail } from "./types";

const logs = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("../diagnostics", () => ({ diagnostics: logs }));
const dirs: string[] = [],
  stores: CrawlStore[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const store of stores.splice(0)) store.close();
  vi.clearAllMocks();
});
const attrs = (n: string) => ({ 攻修: n, 防修: n, 法修: n, 抗法: n });
it.each([
  ["0", 0],
  ["25", 100],
  ["20/25", 80],
  [" 20 / 25 ", 80],
])("四修显式值%s取当前等级", (value, expected) => {
  expect(trainingTotal(attrs(value as string))).toBe(expected);
});
it.each([
  "",
  "?",
  "--",
  "-1",
  "1.5",
  "1e2",
  "20/",
  "/25",
  "30/25",
  "20/25/30",
  "20/unknown",
  "9007199254740992",
  "2251799813685248",
])("非法/溢出%s不是零", (value) => {
  expect(trainingTotal(attrs(value))).toBeNull();
});
it.each(["攻修", "防修", "法修", "抗法"])("缺少%s或仅有相似名称不能计算", (key) => {
  const value: Record<string, string> = attrs("0");
  delete value[key];
  value[`${key}上限`] = "25";
  expect(trainingTotal(value)).toBeNull();
});
it("继承值不是当前列表证据", () => {
  expect(trainingTotal(Object.create(attrs("0")))).toBeNull();
});
it("缺少attrs不被当作四个零", () => {
  expect(trainingTotal(undefined as unknown as Record<string, string>)).toBeNull();
});
function file() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cbg-training-settings-"));
  dirs.push(dir);
  return path.join(dir, "role-training-settings.json");
}
it("空值禁用、0有效、原子保存并跨实例读取；快照互不修改", () => {
  const name = file(),
    store = new RoleTrainingSettingsStore(name);
  expect(store.get()).toEqual({ minTotal: 21 });
  expect(readdirSync(path.dirname(name))).toEqual([]);
  store.save(0);
  expect(new RoleTrainingSettingsStore(name).get()).toEqual({ minTotal: 0 });
  const snapshot = store.save(90);
  snapshot.minTotal = 1;
  expect(store.get()).toEqual({ minTotal: 90 });
  expect(JSON.parse(readFileSync(name, "utf8"))).toEqual({ minTotal: 90 });
  expect(store.save("")).toEqual({ minTotal: null });
  expect(new RoleTrainingSettingsStore(name).get()).toEqual({ minTotal: null });
});
it.each([undefined, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "90", true, {}, []])(
  "拒绝非法设置%j并保留原值",
  (value) => {
    const name = file(),
      store = new RoleTrainingSettingsStore(name);
    store.save(90);
    const before = readFileSync(name, "utf8");
    expect(() => store.save(value)).toThrow();
    expect(store.get()).toEqual({ minTotal: 90 });
    expect(readFileSync(name, "utf8")).toBe(before);
  },
);
it.each(["{", "null", "[]", "{}", '{"minTotal":-1}', '{"minTotal":"90"}'])(
  "已存在坏配置%s明确报错，不能静默禁用",
  (value) => {
    const name = file();
    writeFileSync(name, value);
    expect(() => new RoleTrainingSettingsStore(name).get()).toThrow();
    expect(readFileSync(name, "utf8")).toBe(value);
  },
);
it("持久替换失败不改变缓存且清理临时文件", () => {
  const name = file(),
    store = new RoleTrainingSettingsStore(name);
  store.save(90);
  rmSync(name);
  mkdirSync(name);
  expect(() => store.save(80)).toThrow();
  expect(store.get()).toEqual({ minTotal: 90 });
  expect(readdirSync(path.dirname(name))).toEqual([path.basename(name)]);
});
it.each([-1, 1.5, Infinity, "", "90"])("直接CrawlOptions非法阈值%j不能派发", (value) => {
  expect(() => validateCrawlOptions({ minRoleTrainingTotal: value as number })).toThrow();
});

const item = (id: number, value: Record<string, string>): Listing => {
  const time = new Date(Date.now() - id * 1000).toISOString();
  return {
    key: `1:${id}`,
    serverId: "1",
    eid: String(id),
    ordersn: String(id),
    url: `https://xyq.cbg.163.com/equip?s=1&eid=${id}`,
    sellingTime: time,
    createdTime: time,
    orderTime: time,
    name: String(id),
    price: "100",
    attrs: value,
    summary: null,
  };
};
const detail = (row: Listing): RoleDetail => ({
  captureVersion: CAPTURE_VERSION,
  url: row.url,
  collectedAt: new Date().toISOString(),
  tabs: [],
  raw: {},
  equipmentCapture: {
    version: 1,
    collectedAt: new Date().toISOString(),
    complete: true,
    issues: [],
    emptyProof: "official-containers",
  },
  petCapture: { version: 1, collectedAt: new Date().toISOString(), complete: true, issues: [] },
});
function fixture(pages: Listing[][]) {
  const store = new CrawlStore(":memory:");
  stores.push(store);
  const read = (n: number) => ({
    page: n,
    totalPages: pages.length,
    order: "selling_time DESC",
    items: pages[n - 1],
  });
  const source: CrawlSource = {
    prepare: vi.fn(async () => read(1)),
    page: vi.fn(async (n) => read(n)),
    hover: vi.fn(async (row) => row),
    detail: vi.fn(async (row) => detail(row)),
    onShelf: vi.fn(async () => true),
  };
  return { store, source };
}
it("已知低四修在hover前跳过；等于阈值和未知继续，无永久已见记录", async () => {
  const low = item(1, attrs("19")),
    equal = item(2, attrs("20")),
    unknown = item(3, {}),
    x = fixture([[low, equal, unknown]]),
    updates: Partial<CrawlStatus>[] = [];
  await crawl(x.source, x.store, new AbortController().signal, (s) => updates.push(s), {
    minRoleTrainingTotal: 80,
  });
  expect(vi.mocked(x.source.hover).mock.calls.map(([r]) => r.key)).toEqual([
    equal.key,
    unknown.key,
  ]);
  expect(x.store.detail(low.key)).toBeNull();
  expect(updates.at(-1)).toMatchObject({ filteredTraining: 1, saved: 2 });
  expect(logs.record).toHaveBeenCalledWith(
    "crawl.training_filter",
    expect.objectContaining({
      key: unknown.key,
      reason: "missing-or-invalid-training",
      skip: false,
    }),
  );
  const next = fixture([[low]]);
  await crawl(next.source, x.store, new AbortController().signal, () => {}, {
    minRoleTrainingTotal: 76,
  });
  expect(next.source.hover).toHaveBeenCalledOnce();
  expect(x.store.detail(low.key)).not.toBeNull();
});
it.each([null, 0])("禁用或零下限%s保持原流程", async (minRoleTrainingTotal) => {
  const x = fixture([[item(1, attrs("0"))]]);
  await crawl(x.source, x.store, new AbortController().signal, () => {}, { minRoleTrainingTotal });
  expect(x.source.hover).toHaveBeenCalledOnce();
});
it("补采不拿数据库旧attrs误拒，保持详情重试", async () => {
  const old = item(1, attrs("0")),
    x = fixture([[]]);
  x.store.observe(old, "old");
  await crawl(x.source, x.store, new AbortController().signal, () => {}, {
    minRoleTrainingTotal: 100,
    backfillOnly: true,
  });
  expect(x.source.detail).toHaveBeenCalledOnce();
  expect(x.source.hover).not.toHaveBeenCalled();
  expect(logs.record).toHaveBeenCalledWith(
    "crawl.training_filter",
    expect.objectContaining({ reason: "saved-listing-not-current", skip: false, total: null }),
  );
});
it("watch新老页过滤不登记；刷新同版本只计一次", async () => {
  const a = item(1, attrs("10")),
    b = item(2, attrs("10")),
    x = fixture([[a], [b]]),
    control = new AbortController(),
    done = new Error("end-test"),
    updates: Partial<CrawlStatus>[] = [];
  let refreshes = 0;
  x.source.refresh = vi.fn(async () => {
    if (++refreshes === 3) control.abort(done);
    return { page: 1, totalPages: 2, order: "selling_time DESC", items: [a] };
  });
  await expect(
    crawl(x.source, x.store, control.signal, (s) => updates.push(s), {
      watch: true,
      minRoleTrainingTotal: 80,
      headIntervalMs: 20,
    }),
  ).rejects.toBe(done);
  expect(x.source.hover).not.toHaveBeenCalled();
  expect(x.source.detail).not.toHaveBeenCalled();
  expect(Math.max(...updates.map((s) => s.filteredTraining ?? 0))).toBe(2);
  expect(x.store.detail(a.key)).toBeNull();
  expect(x.store.detail(b.key)).toBeNull();
});
