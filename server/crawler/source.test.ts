import type { Page } from "playwright-core";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { collectRole, createCrawlSource } from "./source";
import { collectDetail, isOnShelf } from "./detail";
import { saveCaptureFailure } from "./capture-failure";
import { SellingOrderUnavailableError, type Listing, type RoleDetail } from "./types";
import { captureBrowserStep } from "../browser-evidence";
import { prepareList, gotoPage, hoverListing } from "./page";
import { CAPTURE_VERSION } from "./compact";
import { IncompleteCaptureError } from "./capture-readiness";

vi.mock("./detail", () => ({
  MAIN_TABS: ["人物/修炼", "技能", "道具/法宝", "召唤兽/孩子", "坐骑", "锦衣/外观", "玩家之家"],
  collectDetail: vi.fn(),
  isOnShelf: vi.fn(),
}));
vi.mock("./page", () => ({
  pace: vi.fn().mockResolvedValue(undefined),
  prepareList: vi.fn(),
  gotoPage: vi.fn(),
  hoverListing: vi.fn(),
}));
vi.mock("./capture-failure", () => ({ saveCaptureFailure: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../browser-evidence", () => ({
  captureBrowserStep: vi.fn().mockResolvedValue(undefined),
}));
beforeEach(() => vi.clearAllMocks());
const page = {
  isClosed: () => false,
  url: () => "https://xyq.cbg.163.com/equip?s=367&eid=abc",
  waitForURL: vi.fn().mockResolvedValue(undefined),
} as unknown as Page;
const item = { key: "367:abc", serverId: "367", eid: "abc", name: "角色" } as Listing;
const options = () => ({
  signal: new AbortController().signal,
  log: vi.fn(),
  onDetailProgress: vi.fn(),
});

it("整件采集总预算到期会关闭独占详情页并保留部分资料，不在后台继续重读", async () => {
  vi.useFakeTimers();
  let rejectRead!: (error: Error) => void;
  let closed = false;
  const partial = { url: "fixture", collectedAt: "now", tabs: [], raw: {} } as RoleDetail;
  const close = vi.fn(async () => {
    closed = true;
    rejectRead(new IncompleteCaptureError("读取被取消", partial, new Error("Target closed")));
  });
  const localPage = {
    ...page,
    isClosed: () => closed,
    close,
  } as unknown as Page;
  vi.mocked(collectDetail).mockImplementation(
    async () =>
      new Promise((_resolve, reject) => {
        rejectRead = reject;
      }),
  );
  const control = new AbortController();
  const src = createCrawlSource({
    ...options(),
    signal: control.signal,
    listPage: page,
    detailPage: localPage,
  });
  const outcome = src.detail(item).catch((error: unknown) => error);
  try {
    for (let n = 0; n < 20; n++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(close).toHaveBeenCalledOnce();
    expect(await outcome).toMatchObject({ name: "IncompleteDetailError", detail: partial });
    expect(collectDetail).toHaveBeenCalledOnce();
  } finally {
    control.abort(new Error("cleanup"));
    rejectRead(new Error("cleanup"));
    await outcome;
    vi.useRealTimers();
  }
});

it("中途超时只记录一次对应阶段，不自动重开整件并保留原错误cause", async () => {
  const original = Object.assign(new Error("坐骑读取超时"), { name: "TimeoutError" });
  vi.mocked(collectDetail).mockImplementation(async (_page, _item, _signal, report) => {
    report?.("正在读取第 1 只坐骑…");
    throw original;
  });
  await expect(collectRole(page, item, options())).rejects.toMatchObject({ cause: original });
  expect(saveCaptureFailure).toHaveBeenCalledOnce();
  expect(saveCaptureFailure).toHaveBeenCalledWith(
    page,
    expect.any(AbortSignal),
    {
      key: item.key,
      attempt: 1,
      stage: "正在读取第 1 只坐骑…",
      error: original,
    },
    expect.any(Function),
  );
});

it("返回缺项资料时也保存当前失败现场，并保留部分资料", async () => {
  const partial = { tabs: [], raw: {}, url: item.url, collectedAt: "now" } as RoleDetail;
  vi.mocked(collectDetail).mockResolvedValue(partial);
  await expect(collectRole(page, item, options())).rejects.toMatchObject({ detail: partial });
  expect(saveCaptureFailure).toHaveBeenCalledOnce();
  expect(saveCaptureFailure).toHaveBeenCalledWith(
    page,
    expect.any(AbortSignal),
    expect.objectContaining({
      key: item.key,
      issues: expect.arrayContaining(["角色本体资料未核验"]),
    }),
    expect.any(Function),
  );
});

it("不可重试错误保留原对象和现场，诊断不改变采集策略", async () => {
  const original = new Error("网站要求登录");
  vi.mocked(collectDetail).mockRejectedValue(original);
  await expect(collectRole(page, item, options())).rejects.toBe(original);
  expect(saveCaptureFailure).toHaveBeenCalledOnce();
  expect(collectDetail).toHaveBeenCalledOnce();
});

it("统一读取入口将导航中的登录地址分类为访问暂停，不增加整件重读", async () => {
  const redirected = { ...page, url: () => "https://xyq.cbg.163.com/cgi-bin/login.py" } as Page;
  vi.mocked(collectDetail).mockRejectedValue(
    new Error(
      "page.evaluate: Execution context was destroyed, most likely because of a navigation",
    ),
  );
  await expect(collectRole(redirected, item, options())).rejects.toMatchObject({
    name: "CrawlAccessError",
    kind: "login",
  });
  expect(collectDetail).toHaveBeenCalledOnce();
  expect(saveCaptureFailure).toHaveBeenCalledOnce();
});

it("完整详情通过校验后才记录读取完成", async () => {
  const complete = {
    tabs: [],
    raw: {},
    url: "https://xyq.cbg.163.com/equip",
    collectedAt: "now",
    captureVersion: CAPTURE_VERSION,
    valuation: {
      version: 1,
      fields: [],
      issues: [],
      source: { serverId: item.serverId, eid: item.eid },
    },
    equipmentCapture: {
      version: 1,
      collectedAt: "now",
      complete: true,
      issues: [],
      emptyProof: "explicit-text",
    },
    petCapture: { version: 1, collectedAt: "now", complete: true, issues: [] },
  } as RoleDetail;
  vi.mocked(collectDetail).mockResolvedValue(complete);
  const opts = options();
  await expect(collectRole(page, item, opts)).resolves.toBe(complete);
  expect(captureBrowserStep).toHaveBeenCalledWith(
    page,
    { flow: "collection", stage: "角色详情读取完成", key: item.key },
    opts.signal,
  );
  expect(saveCaptureFailure).not.toHaveBeenCalled();
});

it("列表准备、切页、悬停及上架核验均在业务动作完成后截图", async () => {
  const listing = { page: 1, totalPages: 2, order: "time", items: [item] };
  vi.mocked(prepareList).mockResolvedValue(listing);
  vi.mocked(gotoPage).mockResolvedValue({ ...listing, page: 2 });
  vi.mocked(hoverListing).mockResolvedValue(item);
  vi.mocked(isOnShelf).mockResolvedValue(true);
  const opts = options();
  const source = createCrawlSource({ ...opts, listPage: page, detailPage: page });
  await expect(source.prepare()).resolves.toBe(listing);
  await source.page(2);
  await expect(source.hover(item)).resolves.toBe(item);
  await expect(source.onShelf(item)).resolves.toBe(true);
  expect(vi.mocked(captureBrowserStep).mock.calls.map((call) => call[1].stage)).toEqual([
    "列表准备完成",
    "列表翻页至第 2 页完成",
    "列表角色悬停读取完成",
    "角色上架状态读取完成",
  ]);
  expect(vi.mocked(prepareList).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(captureBrowserStep).mock.invocationCallOrder[0],
  );
});

it("列表业务操作报错先留现场，再抛回原错误", async () => {
  const error = new Error("列表翻页超时");
  vi.mocked(gotoPage).mockRejectedValue(error);
  const opts = options();
  const source = createCrawlSource({ ...opts, listPage: page, detailPage: page });
  await expect(source.page(3)).rejects.toBe(error);
  expect(captureBrowserStep).toHaveBeenCalledWith(
    page,
    { flow: "collection", stage: "列表翻页至第 3 页失败", key: undefined, error },
    opts.signal,
  );
});

it("缺少上架排序仅记录现有全扫策略切换，typed信号原样交给runner且不触发错误监控", async () => {
  const fallback = new SellingOrderUnavailableError();
  const listing = { page: 1, totalPages: 2, order: "expire_time DESC", items: [item] };
  vi.mocked(prepareList).mockRejectedValueOnce(fallback).mockResolvedValueOnce(listing);
  const opts = options();
  const source = createCrawlSource({ ...opts, listPage: page, detailPage: page });
  const supervisorErrors: unknown[] = [];
  vi.mocked(captureBrowserStep).mockImplementation(async (_page, step) => {
    if (step.error) supervisorErrors.push(step.error);
  });
  await expect(source.prepare("selling_time DESC")).rejects.toBe(fallback);
  // The existing runner handles precisely this signal and prepares expiry-order full scanning.
  await expect(source.prepare("expire_time DESC")).resolves.toBe(listing);
  expect(supervisorErrors).toEqual([]);
  expect(vi.mocked(captureBrowserStep).mock.calls.map((call) => call[1].stage)).toEqual([
    "上架时间排序不可用-切换逐页全表扫描",
    "列表准备完成",
  ]);
  expect(opts.log).toHaveBeenCalledWith("list.selling_order_unavailable", {
    requestedOrder: "selling_time DESC",
    strategy: "full-scan",
  });
  expect(opts.log).toHaveBeenCalledWith("list.prepared", {
    page: 1,
    totalPages: 2,
    order: "expire_time DESC",
    count: 1,
  });
});

it("无法切换上架倒序的真实失败仍记录原错，不冒充可恢复策略切换", async () => {
  const error = new Error("未能确认上架时间倒序，已暂停采集");
  vi.mocked(prepareList).mockRejectedValueOnce(error);
  const opts = options();
  const source = createCrawlSource({ ...opts, listPage: page, detailPage: page });
  await expect(source.prepare("selling_time DESC")).rejects.toBe(error);
  expect(captureBrowserStep).toHaveBeenCalledWith(
    page,
    {
      flow: "collection",
      stage: "列表准备失败",
      key: undefined,
      error,
    },
    opts.signal,
  );
  expect(opts.log).not.toHaveBeenCalledWith("list.selling_order_unavailable", expect.anything());
});

const reusableDetail = (): RoleDetail => ({
  tabs: ["人物/修炼", "技能", "道具/法宝", "召唤兽/孩子", "坐骑", "锦衣/外观", "玩家之家"].map(
    (name) => ({
      name,
      text: "已读",
      fields: [],
      tables: [],
      elements: [],
      tooltips: [],
      items:
        name === "技能"
          ? Array.from({ length: 7 }, (_, index) => ({
              index,
              name: `师门${index}`,
              kind: "skill" as const,
              category: "师门技能",
              level: "150",
            }))
          : [],
    }),
  ),
  raw: {},
  url: item.url,
  collectedAt: "saved-at",
  captureVersion: CAPTURE_VERSION,
  captureMode: "all",
  valuation: {
    version: 1,
    fields: [],
    issues: [],
    source: { serverId: item.serverId, eid: item.eid },
  },
  equipmentCapture: {
    version: 1,
    collectedAt: "saved-at",
    complete: true,
    issues: [],
    emptyProof: "explicit-text",
  },
  petCapture: { version: 1, collectedAt: "saved-at", complete: true, issues: [] },
});
it("同一上架版本已完整的商品直接复用，不打开详情也不刷新宝宝装备", async () => {
  const detail = reusableDetail();
  const opts = options();
  const result = await collectRole(page, item, {
    ...opts,
    savedRecord: () => ({ listing: item, detail, status: "complete", error: null }),
  });
  expect(result).toEqual(detail);
  expect(result).not.toBe(detail);
  expect(collectDetail).not.toHaveBeenCalled();
  expect(saveCaptureFailure).not.toHaveBeenCalled();
  expect(opts.log).toHaveBeenCalledWith("detail.reused", {
    key: item.key,
    collectedAt: "saved-at",
  });
  expect(opts.log).not.toHaveBeenCalledWith("detail.collected", expect.anything());
});
it.each([
  "key",
  "serverId",
  "eid",
  "ordersn",
  "sellingTime",
  "price",
  "identity",
  "missing-main-tab",
  "missing-mode",
  "incomplete-school-skills",
  "version",
  "failed",
])("已存资料的%s变化时不复用旧上架资料", async (kind) => {
  const detail = reusableDetail();
  const previous = {
    listing: { ...item },
    detail,
    status: "complete" as "complete" | "failed",
    error: null,
  };
  if (["key", "serverId", "eid", "ordersn", "sellingTime", "price"].includes(kind))
    (previous.listing as unknown as Record<string, unknown>)[kind] = "changed";
  if (kind === "identity") detail.valuation!.source.eid = "another-role";
  if (kind === "missing-main-tab") detail.tabs = detail.tabs.slice(1);
  if (kind === "missing-mode") delete detail.captureMode;
  if (kind === "incomplete-school-skills")
    detail.tabs.find((tab) => tab.name === "技能")!.items!.pop();
  if (kind === "version") detail.captureVersion = CAPTURE_VERSION - 1;
  if (kind === "failed") previous.status = "failed";
  const full = reusableDetail();
  vi.mocked(collectDetail).mockResolvedValue(full);
  await expect(
    collectRole(page, item, { ...options(), savedRecord: () => previous }),
  ).resolves.toBe(full);
  expect(collectDetail).toHaveBeenCalledOnce();
});
it("明确刷新不提供savedRecord时始终重新读取，不能被默认复用短路", async () => {
  const full = reusableDetail();
  vi.mocked(collectDetail).mockResolvedValue(full);
  await expect(collectRole(page, item, options())).resolves.toBe(full);
  expect(collectDetail).toHaveBeenCalledOnce();
});
