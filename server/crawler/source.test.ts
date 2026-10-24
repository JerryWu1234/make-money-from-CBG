import type { Page } from "playwright-core";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { collectRole, createCrawlSource } from "./source";
import { collectDetail, isOnShelf } from "./detail";
import { saveCaptureFailure } from "./capture-failure";
import { SellingOrderUnavailableError, type Listing, type RoleDetail } from "./types";
import { captureBrowserStep } from "../browser-evidence";
import { prepareList, gotoPage, hoverListing } from "./page";
import { CAPTURE_VERSION } from "./compact";

vi.mock("./detail", () => ({
  MAIN_TABS: [],
  collectDetail: vi.fn(),
  collectValuationDetail: vi.fn(),
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
const page = {} as Page;
const item = { key: "367:abc", serverId: "367", eid: "abc", name: "角色" } as Listing;
const options = () => ({
  signal: new AbortController().signal,
  log: vi.fn(),
  onDetailProgress: vi.fn(),
});

it("每轮超时在重读导航之前记录对应阶段，最终保留原错误作为cause", async () => {
  const original = Object.assign(new Error("坐骑读取超时"), { name: "TimeoutError" });
  vi.mocked(collectDetail).mockImplementation(async (_page, _item, _signal, report) => {
    report?.("正在读取第 1 只坐骑…");
    throw original;
  });
  await expect(collectRole(page, item, options())).rejects.toMatchObject({ cause: original });
  expect(saveCaptureFailure).toHaveBeenCalledTimes(3);
  for (let attempt = 1; attempt <= 3; attempt++)
    expect(saveCaptureFailure).toHaveBeenNthCalledWith(
      attempt,
      page,
      expect.any(AbortSignal),
      {
        key: item.key,
        attempt,
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
  expect(saveCaptureFailure).toHaveBeenCalledTimes(3);
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
