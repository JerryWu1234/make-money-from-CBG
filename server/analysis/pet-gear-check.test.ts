import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { checkPetGear, petGearInventory } from "./pet-gear-check";
import type { SavedRoleRecord } from "../crawler/types";

const mocks = vi.hoisted(() => ({
  savedDetail: vi.fn(),
  petInventory: vi.fn(),
  createPetGearSource: vi.fn(),
  discover: vi.fn(),
  close: vi.fn(),
}));
vi.mock("../crawler/controller", () => ({ savedDetail: mocks.savedDetail }));
vi.mock("./pet-pricing", () => ({ petInventory: mocks.petInventory }));
vi.mock("./browser-pet-gear-source", () => ({ createPetGearSource: mocks.createPetGearSource }));

const input = { productKey: "1:role", mode: "discover" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.savedDetail.mockReturnValue({
    listing: { key: input.productKey },
    status: "complete",
    detail: { tabs: [] },
  });
  mocks.petInventory.mockReturnValue({
    captureComplete: true,
    issues: [],
    items: [
      {
        key: "pet:1",
        name: "画魂",
        equipment: [{ name: "装备甲", description: "等级 115\n气血 +80" }],
      },
      {
        key: "pet:2",
        name: "幽灵",
        equipment: [{ name: "装备环", description: "等级：65\n速度 +25" }],
      },
    ],
  });
  mocks.discover.mockResolvedValue({ controls: [], menus: [], buttons: [], scripts: [] });
  mocks.close.mockResolvedValue(undefined);
  mocks.createPetGearSource.mockResolvedValue({ discover: mocks.discover, close: mocks.close });
});

describe("通用宝宝装备公开控件检查", () => {
  it("为每只宝宝建立独立装备 key 与实际等级，缺等级保持未知", () => {
    const record = mocks.savedDetail() as SavedRoleRecord;
    const inventory = petGearInventory(record);
    expect(inventory.items).toMatchObject([
      { key: "pet:1:gear:0", petKey: "pet:1", name: "装备甲", level: 115 },
      { key: "pet:2:gear:0", petKey: "pet:2", name: "装备环", level: 65 },
    ]);
    mocks.petInventory.mockReturnValue({
      captureComplete: false,
      issues: ["宝宝装备漏采"],
      items: [
        {
          key: "pet:3",
          name: "画魂",
          equipment: [{ name: "饰品", description: "外观", accessory: true }],
        },
      ],
    });
    expect(petGearInventory(record)).toMatchObject({
      captureComplete: false,
      issues: ["宝宝装备漏采"],
      items: [{ level: null, accessory: true }],
    });
  });

  it("发现公开控件保留库存和重复计价边界，查询后关闭来源", async () => {
    await expect(checkPetGear(input, new AbortController().signal)).resolves.toMatchObject({
      mode: "discover",
      target: { productKey: input.productKey },
      inventory: { captureComplete: true, items: [{ level: 115 }, { level: 65 }] },
      accounting: expect.stringContaining("不重复相加"),
    });
    expect(mocks.discover).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("同gear key的完整属性变化会更新实际输入hash", () => {
    const record = mocks.savedDetail() as SavedRoleRecord;
    const before = petGearInventory(record);
    const captured = mocks.petInventory();
    captured.items[0].equipment[0].description = "等级 115\n气血 +180\n耐久度 200";
    const after = petGearInventory(record);
    expect(after.items[0].key).toBe(before.items[0].key);
    expect(after.inputHash).not.toBe(before.inputHash);
  });

  it("读取失败或取消都不保留工作来源，不调用新连接", async () => {
    mocks.discover.mockRejectedValue(new Error("官网登录面板"));
    await expect(checkPetGear(input, new AbortController().signal)).rejects.toThrow("登录面板");
    expect(mocks.close).toHaveBeenCalledOnce();
    mocks.createPetGearSource.mockClear();
    await expect(checkPetGear(input, AbortSignal.abort(new Error("取消")))).rejects.toThrow("取消");
    expect(mocks.createPetGearSource).not.toHaveBeenCalled();
  });

  it.each([
    { ...input, productKey: "" },
    { ...input, mode: "search" },
  ])("拒绝无效输入 %j", async (value) => {
    await expect(checkPetGear(value, new AbortController().signal)).rejects.toThrow();
    expect(mocks.savedDetail).not.toHaveBeenCalled();
    expect(mocks.createPetGearSource).not.toHaveBeenCalled();
  });

  it("拒绝错误的保存记录身份及未采完整详情", async () => {
    mocks.savedDetail.mockReturnValue({
      listing: { key: "other" },
      status: "complete",
      detail: {},
    });
    await expect(checkPetGear(input, new AbortController().signal)).rejects.toThrow("不一致");
    mocks.savedDetail.mockReturnValue({
      listing: { key: input.productKey },
      status: "pending",
      detail: null,
    });
    await expect(checkPetGear(input, new AbortController().signal)).rejects.toThrow("未采集完整");
    expect(mocks.createPetGearSource).not.toHaveBeenCalled();
  });
});
