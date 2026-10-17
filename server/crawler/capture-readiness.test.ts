import { expect, it, vi } from "vite-plus/test";
import { CAPTURE_VERSION } from "./compact";
import { captureIssues, collectCompleteCapture, IncompleteCaptureError } from "./capture-readiness";
import { CrawlStore } from "./store";
import { analysisRecord } from "../../tests/fixtures/analysis";

const complete = () => ({
  ...analysisRecord("a").detail!,
  captureVersion: CAPTURE_VERSION,
  valuation: { version: 1 as const, fields: [], issues: [], source: {} },
  equipmentCapture: {
    version: 1 as const,
    collectedAt: "now",
    complete: true,
    issues: [] as string[],
    emptyProof: "explicit-text" as const,
  },
  petCapture: { version: 1 as const, collectedAt: "now", complete: true, issues: [] as string[] },
});
it("采集本轮自动重读缺项，核验通过才返回完整资料", async () => {
  const partial = complete();
  partial.equipmentCapture.complete = false;
  partial.equipmentCapture.issues = ["武器属性尚未读取"];
  const read = vi.fn().mockResolvedValueOnce(partial).mockResolvedValueOnce(complete());
  const report = vi.fn();
  const captured = await collectCompleteCapture(read, new AbortController().signal, report);
  expect(captureIssues(captured, true)).toEqual([]);
  expect(read).toHaveBeenCalledTimes(2);
  expect(report).toHaveBeenCalledWith(expect.stringContaining("本轮内自动重读"));
});
it("三次仍缺项时在采集阶段失败，不返回可分析的半成品", async () => {
  const partial = complete();
  partial.petCapture.complete = false;
  partial.petCapture.issues = ["宝宝装备图标未完整读取"];
  const read = vi.fn().mockResolvedValue(partial);
  await expect(
    collectCompleteCapture(read, new AbortController().signal, vi.fn()),
  ).rejects.toMatchObject({
    name: "IncompleteDetailError",
    message: expect.stringContaining("未进入角色分析"),
  });
  expect(read).toHaveBeenCalledTimes(3);
});
it("连续重读失败保留最后一次部分资料，供本地详情定位缺项", async () => {
  const partial = complete();
  partial.equipmentCapture.complete = false;
  partial.equipmentCapture.issues = ["装备库存未核验"];
  const error = await collectCompleteCapture(
    vi.fn().mockResolvedValue(partial),
    new AbortController().signal,
    vi.fn(),
  ).catch((error) => error);
  expect(error).toBeInstanceOf(IncompleteCaptureError);
  expect(error.detail).toBe(partial);
  expect(captureIssues(error.detail, true)).toContain("装备库存未核验");
});
it("登录或安全验证不自动重试，停止采集而不越过访问限制", async () => {
  const read = vi
    .fn()
    .mockRejectedValue(
      Object.assign(new Error("网站要求安全验证"), { name: "IncompleteDetailError" }),
    );
  await expect(collectCompleteCapture(read, new AbortController().signal, vi.fn())).rejects.toThrow(
    "安全验证",
  );
  expect(read).toHaveBeenCalledOnce();
});
it("缺少完整性证据不能通过新采集核验", () => {
  const detail = analysisRecord("a").detail!;
  delete detail.equipmentCapture;
  delete detail.petCapture;
  expect(captureIssues(detail, true)).toEqual(
    expect.arrayContaining(["装备完整性未核验", "宝宝完整性未核验"]),
  );
});
it("装备空库存原因只显示一次，仍保留失败核验", () => {
  const detail = complete();
  delete (detail.equipmentCapture as { emptyProof?: string }).emptyProof;
  detail.equipmentCapture.complete = false;
  detail.equipmentCapture.issues = [
    "人物装备库存是否为空尚未核对，需确认穿戴与随身装备区域后再计价",
  ];
  detail.tabs.push({
    name: "道具/法宝",
    text: "现金100",
    fields: [],
    tables: [],
    elements: [],
    tooltips: [],
    items: [],
  });
  expect(
    captureIssues(detail, true).filter((issue) => issue.includes("装备库存是否为空")),
  ).toHaveLength(1);
  expect(captureIssues(detail, true).length).toBeGreaterThan(0);
});
it("部分资料仍保存，但不标记详情完整、不推进成功断点；补采后才能转完整", () => {
  const store = new CrawlStore(":memory:");
  const record = analysisRecord("a");
  try {
    store.observe(record.listing);
    const partial = complete();
    partial.equipmentCapture.complete = false;
    partial.equipmentCapture.issues = ["装备属性未读全"];
    const point = {
      key: record.listing.key,
      time: null,
      order: "selling_time DESC",
      page: 1,
      savedAt: "now",
    };
    expect(store.save(record.listing, partial, point)).toBe(false);
    expect(store.detail(record.listing.key)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("装备属性未读全"),
    });
    expect(store.checkpoint()).toBeUndefined();
    expect(store.save(record.listing, complete(), point)).toBe(true);
    expect(store.detail(record.listing.key)).toMatchObject({ status: "complete", error: null });
    expect(store.checkpoint()).toEqual(point);
  } finally {
    store.close();
  }
});
