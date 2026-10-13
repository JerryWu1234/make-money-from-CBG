import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  rolePricingFixture,
  rolePricingRecord,
  roleSearchResultFixture,
} from "../../tests/fixtures/role-pricing";
import { searchRolePricing } from "./role-search";

const mocks = vi.hoisted(() => ({ create: vi.fn(), search: vi.fn(), close: vi.fn() }));
vi.mock("./browser-role-source", async (original) => ({
  ...(await original<typeof import("./browser-role-source")>()),
  createRoleSource: mocks.create,
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.close.mockResolvedValue(undefined);
  mocks.create.mockResolvedValue({ search: mocks.search, close: mocks.close });
});
describe("整号自动查询与阶段恢复", () => {
  it("通用角色自动条件直接使用record，不提供手工固定筛选", async () => {
    const record = rolePricingRecord(),
      signal = new AbortController().signal;
    mocks.search.mockResolvedValue(roleSearchResultFixture(record));
    const snapshot = await searchRolePricing(record, signal);
    expect(mocks.search).toHaveBeenCalledExactlyOnceWith(record);
    expect(snapshot.marketReference.status).toBe("range");
    expect(mocks.close).toHaveBeenCalledOnce();
    await searchRolePricing(record, signal, snapshot);
    expect(mocks.create).toHaveBeenCalledOnce();
  });
  it("已有完整鲜活快照不重复联网；旧报价或异角色必须重新搜索", async () => {
    const record = rolePricingRecord(),
      signal = new AbortController().signal,
      previous = rolePricingFixture(record);
    expect(await searchRolePricing(record, signal, previous)).toBe(previous);
    expect(mocks.create).not.toHaveBeenCalled();
    previous.searchedAt = "2000-01-01T00:00:00Z";
    mocks.search.mockResolvedValue(roleSearchResultFixture(record));
    await searchRolePricing(record, signal, previous);
    expect(mocks.search).toHaveBeenCalledOnce();
    const other = rolePricingRecord("other");
    mocks.search.mockResolvedValue(roleSearchResultFixture(other));
    await searchRolePricing(other, signal, previous);
    expect(mocks.search).toHaveBeenCalledTimes(2);
  });
  it("缺采配置保存明确未定价且不启动市场，完成标记不造成无限暂停", async () => {
    const record = rolePricingRecord();
    record.detail!.petCapture!.complete = false;
    const snapshot = await searchRolePricing(record, new AbortController().signal);
    expect(snapshot).toMatchObject({
      queried: false,
      searchComplete: true,
      marketReference: { status: "insufficient", range: null, median: null },
    });
    expect(snapshot.issues.join("；")).toContain("补采");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("网站失败仍释放自有源，取消不启动浏览器", async () => {
    mocks.search.mockRejectedValue(new Error("网站要求登录"));
    await expect(
      searchRolePricing(rolePricingRecord(), new AbortController().signal),
    ).rejects.toThrow("登录");
    expect(mocks.close).toHaveBeenCalledOnce();
    mocks.create.mockClear();
    await expect(
      searchRolePricing(rolePricingRecord(), AbortSignal.abort(new Error("取消"))),
    ).rejects.toThrow("取消");
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
