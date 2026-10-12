import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { valuationRecord } from "../../tests/fixtures/analysis";
import { checkRole } from "./role-check";
const mocks = vi.hoisted(() => ({
  savedDetail: vi.fn(),
  create: vi.fn(),
  navigation: vi.fn(),
  discover: vi.fn(),
  search: vi.fn(),
  close: vi.fn(),
}));
vi.mock("../crawler/controller", () => ({ savedDetail: mocks.savedDetail }));
vi.mock("./browser-role-source", () => ({
  createRoleSource: mocks.create,
  readPublicRoleNavigation: mocks.navigation,
  currentRoleAuthentication: vi.fn(),
}));
const input = { productKey: "941:saved-role", mode: "discover" };
beforeEach(() => {
  vi.resetAllMocks();
  const record = valuationRecord();
  record.listing.key = input.productKey;
  mocks.savedDetail.mockReturnValue(record);
  mocks.create.mockResolvedValue({
    discover: mocks.discover,
    search: mocks.search,
    close: mocks.close,
  });
  mocks.discover.mockResolvedValue({ controls: [], menus: [] });
});
describe("项目拥有的角色检查接口", () => {
  it("字段发现完成和失败均关闭自己的来源", async () => {
    expect(await checkRole(input, new AbortController().signal)).toMatchObject({
      mode: "discover",
      form: { controls: [] },
    });
    expect(mocks.close).toHaveBeenCalledOnce();
    mocks.discover.mockRejectedValue(new Error("官网验证"));
    await expect(checkRole(input, new AbortController().signal)).rejects.toThrow("官网验证");
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });
  it("公开导航只读已有项目页，不创建新的浏览器来源", async () => {
    mocks.navigation.mockResolvedValue([
      {
        label: "重新查询",
        url: "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=observed-fixture",
      },
    ]);
    expect(
      await checkRole({ ...input, mode: "navigation" }, new AbortController().signal),
    ).toMatchObject({ mode: "navigation" });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each([undefined, "", "bad", {}, 1])("无效模式不连接浏览器 %j", async (mode) => {
    await expect(checkRole({ ...input, mode }, new AbortController().signal)).rejects.toThrow(
      "mode",
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("省略搜索数组时由来源发现表单并按保存角色自动生成", async () => {
    mocks.search.mockResolvedValue({
      selections: { controls: [{ id: "level_min", value: "109" }], menus: [] },
    });
    expect(
      await checkRole({ ...input, mode: "search" }, new AbortController().signal),
    ).toMatchObject({ mode: "search" });
    expect(mocks.search).toHaveBeenCalledWith(mocks.savedDetail.mock.results[0].value, undefined);
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it("显式指定筛选仍传给来源以核验公开控件", async () => {
    const selections = {
      controls: [{ id: "level_min", value: "109" }],
      menus: [{ id: "observed-school", value: "current-value" }],
    };
    mocks.search.mockResolvedValue({ selections });
    await checkRole({ ...input, mode: "search", ...selections }, new AbortController().signal);
    expect(mocks.search).toHaveBeenCalledWith(mocks.savedDetail.mock.results[0].value, selections);
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it.each([
    { controls: [] },
    { menus: [] },
    { controls: "invalid", menus: [] },
    { controls: [], menus: {} },
  ])("显式不完整选择数组在连接浏览器前拒绝%j", async (selections) => {
    await expect(
      checkRole({ ...input, mode: "search", ...selections }, new AbortController().signal),
    ).rejects.toThrow("controls 和 menus");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("自动搜索失败也关闭自有页面", async () => {
    mocks.search.mockRejectedValue(new Error("官网门派名称无法唯一映射"));
    await expect(
      checkRole({ ...input, mode: "search" }, new AbortController().signal),
    ).rejects.toThrow("门派");
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it("已取消请求不读取记录或连接", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(checkRole(input, controller.signal)).rejects.toThrow("cancelled");
    expect(mocks.savedDetail).not.toHaveBeenCalled();
  });
});
