import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { checkPet } from "./pet-check";

const mocks = vi.hoisted(() => ({
  savedDetail: vi.fn(),
  petInventory: vi.fn(),
  createPetSource: vi.fn(),
  findCandidates: vi.fn(),
  discover: vi.fn(),
  close: vi.fn(),
}));
vi.mock("../crawler/controller", () => ({ savedDetail: mocks.savedDetail }));
vi.mock("./pet-pricing", () => ({ petInventory: mocks.petInventory }));
vi.mock("./browser-pet-source", () => ({ createPetSource: mocks.createPetSource }));
const input = { productKey: "1:role", petKey: "召唤兽/孩子:2" };
const pet = { key: input.petKey, name: "画魂", level: 119, status: "no_match", issues: [] };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.savedDetail.mockReturnValue({
    listing: { key: input.productKey },
    status: "complete",
    detail: {},
  });
  mocks.petInventory.mockReturnValue({
    captureComplete: true,
    issues: [],
    items: [{ ...pet, key: "other" }, pet],
  });
  mocks.findCandidates.mockResolvedValue({ queries: ["全服画魂"], items: [] });
  mocks.close.mockResolvedValue(undefined);
  mocks.createPetSource.mockResolvedValue({
    findCandidates: mocks.findCandidates,
    discover: mocks.discover,
    close: mocks.close,
  });
});
describe("同会话单只宝宝查价", () => {
  it("公开字段发现不要求petKey或可计价库存，也不执行候选查询", async () => {
    const form = {
      controls: [{ id: "observed-grade", visible: true }],
      menus: [],
      buttons: [],
      scripts: [],
    };
    mocks.discover.mockResolvedValue(form);
    mocks.petInventory.mockReturnValue({ captureComplete: false, issues: ["缺资料"], items: [] });
    await expect(
      checkPet({ productKey: input.productKey, mode: "discover" }, new AbortController().signal),
    ).resolves.toMatchObject({ mode: "discover", target: { productKey: input.productKey }, form });
    expect(mocks.discover).toHaveBeenCalledOnce();
    expect(mocks.petInventory).not.toHaveBeenCalled();
    expect(mocks.findCandidates).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it("公开字段读取失败或取消仍关闭工作页，未知mode不发起查询", async () => {
    mocks.discover.mockRejectedValue(new Error("显示登录面板"));
    await expect(
      checkPet({ productKey: input.productKey, mode: "discover" }, new AbortController().signal),
    ).rejects.toThrow("登录面板");
    expect(mocks.close).toHaveBeenCalledOnce();
    mocks.createPetSource.mockClear();
    await expect(
      checkPet({ ...input, mode: "unknown" }, new AbortController().signal),
    ).rejects.toThrow("mode");
    await expect(
      checkPet(
        { productKey: input.productKey, mode: "discover" },
        AbortSignal.abort(new Error("取消")),
      ),
    ).rejects.toThrow("取消");
    expect(mocks.createPetSource).not.toHaveBeenCalled();
  });
  it("只查询指定宝宝，保留原始结果并关闭工作页", async () => {
    await expect(checkPet(input, new AbortController().signal)).resolves.toMatchObject({
      target: { ...input, name: "画魂", level: 119 },
      queries: ["全服画魂"],
    });
    expect(mocks.findCandidates.mock.calls[0][0]).toEqual([pet]);
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it("查询失败仍清理工作页，保留错误供用户重试", async () => {
    mocks.findCandidates.mockRejectedValue(new Error("登录已过期"));
    await expect(checkPet(input, new AbortController().signal)).rejects.toThrow("登录已过期");
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it("未采齐、选择不存在或已取消都不会发起浏览器查询", async () => {
    mocks.petInventory.mockReturnValueOnce({
      captureComplete: false,
      issues: ["缺属性"],
      items: [pet],
    });
    await expect(checkPet(input, new AbortController().signal)).rejects.toThrow("缺属性");
    await expect(
      checkPet({ ...input, petKey: "missing" }, new AbortController().signal),
    ).rejects.toThrow("指定宝宝");
    await expect(checkPet(input, AbortSignal.abort(new Error("取消")))).rejects.toThrow("取消");
    expect(mocks.createPetSource).not.toHaveBeenCalled();
  });
});
