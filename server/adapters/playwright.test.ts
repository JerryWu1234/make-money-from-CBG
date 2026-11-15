import { expect, it, vi } from "vite-plus/test";
import type { Page } from "playwright-core";
import type { AccessContext } from "../access";
import type { CrawlSource } from "../crawler/types";
import { analysisRecord, valuationRecord } from "../../tests/fixtures/analysis";
import { createPlaywrightCrawlAdapter } from "./playwright";
import { validateObservedCapture } from "./contracts";
const context: AccessContext = {
  owner: "owner",
  fence: 1,
  stopEpoch: 0,
  runId: "run",
  queryId: "query",
  pageId: "page",
  pageGeneration: 1,
  browserSessionEpoch: "session",
  sourceKind: "crawl",
};
vi.mock("../official-access", () => ({ officialPageContext: () => context }));
function fixture() {
  const record = analysisRecord("adapter-fixture");
  const detail = {
    ...record.detail!,
    captureMode: "all" as const,
    accessContext: context,
    valuation: {
      version: 1 as const,
      fields: [],
      issues: [],
      source: { serverId: record.listing.serverId, eid: record.listing.eid },
    },
    tabs: record.detail!.tabs.map((tab) =>
      tab.name === "技能" ? valuationRecord("skills").detail!.tabs[1] : tab,
    ),
  };
  const listing = { page: 1, totalPages: 1, order: "selling_time DESC", items: [record.listing] };
  const source: CrawlSource = {
    prepare: async () => listing,
    page: async () => listing,
    onShelf: async () => true,
    hover: async (item) => item,
    detail: async () => detail,
  };
  const page = { url: () => record.listing.url, isClosed: () => false } as unknown as Page;
  const adapter = createPlaywrightCrawlAdapter(
    {
      listPage: page,
      detailPage: page,
      signal: new AbortController().signal,
      log: vi.fn(),
      onDetailProgress: vi.fn(),
    },
    source,
  );
  return { record, detail, source, adapter };
}
it("T12/T17 新旧通路同一离线资料使用相同纯完整性校验，不调用Page API验证资料", async () => {
  const { record, detail, adapter } = fixture();
  await adapter.source.prepare();
  const result = await adapter.source.detail(record.listing);
  const observed = await adapter.observer.snapshot();
  expect(result).toEqual(
    validateObservedCapture(
      { ...observed, context: { ...observed.context, sourceKind: "extension-native" } },
      record.listing,
    ),
  );
  expect(result).toEqual(detail);
  expect(observed.productIdentity).toEqual({
    serverId: record.listing.serverId,
    eid: record.listing.eid,
  });
});
it("资料缺项不升complete；不支持的语义操作显式失败且关闭取消等待器", async () => {
  const { record, detail, adapter, source } = fixture();
  await adapter.source.prepare();
  await expect(
    adapter.driver.execute({
      ...context,
      actionId: "unsupported",
      target: { kind: "query-field", field: "price_min", value: "10" },
      expected: { kind: "changed" },
    }),
  ).rejects.toThrow("不支持");
  source.detail = async () => ({ ...detail, petCapture: undefined });
  await expect(adapter.source.detail(record.listing)).rejects.toThrow("宝宝完整性");
  const snapshot = await adapter.observer.snapshot();
  const pending = expect(
    adapter.observer.waitFor(() => true, {
      pageId: snapshot.context.pageId,
      after: snapshot.revision,
      timeoutMs: 60000,
    }),
  ).rejects.toThrow("已关闭");
  await adapter.observer.close();
  await pending;
});
