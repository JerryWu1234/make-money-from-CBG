import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createPetGearSource,
  PET_GEAR_SEARCH_URL,
  petGearUIQuery,
  petGearSearchPlanHash,
} from "./browser-pet-gear-source";
import type { PetGearPricingItem } from "./pet-gear-inventory";

const mocks = vi.hoisted(() => ({
  getBrowser: vi.fn(),
  createHiddenPage: vi.fn(),
  readPetSearchForm: vi.fn(),
  evaluate: vi.fn(),
  waitForFunction: vi.fn(),
  goto: vi.fn(),
  close: vi.fn(),
  captureBrowserStep: vi.fn(),
}));
vi.mock("../browser-evidence", () => ({ captureBrowserStep: mocks.captureBrowserStep }));
vi.mock("../session", () => ({
  getBrowser: mocks.getBrowser,
  createHiddenPage: mocks.createHiddenPage,
}));
vi.mock("./browser-pet-source", () => ({ readPetSearchForm: mocks.readPetSearchForm }));
vi.mock("../crawler/page", () => ({
  pace: async (signal: AbortSignal) => signal.throwIfAborted(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getBrowser.mockResolvedValue({});
  mocks.createHiddenPage.mockResolvedValue({
    goto: mocks.goto,
    close: mocks.close,
    evaluate: mocks.evaluate,
    waitForFunction: mocks.waitForFunction,
    isClosed: () => false,
  });
  mocks.readPetSearchForm.mockResolvedValue({ controls: [], menus: [], buttons: [], scripts: [] });
  mocks.evaluate.mockResolvedValue({ forms: [], sliders: [] });
  mocks.close.mockResolvedValue(undefined);
});

describe("宝宝装备同会话公开入口", () => {
  it("同一宝宝装备的查询游标不能跨目标服复用", () => {
    const item = {
      name: "金腕",
      description: "等级95\n速度+20\n耐久100",
      accessory: false,
    } as PetGearPricingItem;
    expect(petGearSearchPlanHash(item, "1")).not.toBe(petGearSearchPlanHash(item, "33"));
  });
  it("从任意保存装备生成真实控件输入；百分比/灵石/双加/套装全部保留", () => {
    const item = {
      name: "金腕",
      description:
        "等级95\n命中率+13%\n耐久113\n耐力+14 魔力+13\n套装效果：附加状态高级神佑复生\n镶嵌效果\n+28灵力 镶嵌等级：7",
      accessory: false,
    } as PetGearPricingItem;
    expect(petGearUIQuery(item)).toMatchObject({
      level: 95,
      inputs: {
        hit_ratio: "13",
        addon_sum_min: "27",
        xiang_qian_level: "7",
        addon_status: "高级神佑复生",
      },
      addons: ["addon_naili", "addon_fali"],
      stone: "灵力",
    });
    expect(petGearUIQuery(item, true)).toMatchObject({
      level: 95,
      inputs: { hit_ratio: "11", addon_sum_min: "22", xiang_qian_level: "6" },
    });
    expect(petGearUIQuery({ ...item, description: "等级25\n速度+20\n耐久100" })).toMatchObject({
      level: 25,
      inputs: { speed: "20" },
      addons: [],
      stone: null,
    });
    expect(
      petGearUIQuery({
        ...item,
        description: "等级115\n伤害+65\n力量+10 敏捷-5\n耐久200",
      }),
    ).toMatchObject({
      level: 115,
      inputs: { shanghai: "65", addon_minjie_reduce: "5", addon_sum_min: "5" },
      addons: ["addon_liliang"],
    });
  });
  it.each([" ", "\t", "　"])("套装前缀后的%s不污染官网完整技能名称", (space) => {
    const item = {
      name: "金腕",
      description: "等级95\n命中率+13%\n耐久113\n套装效果：附加状态" + space + "高级神佑复生",
      accessory: false,
    } as PetGearPricingItem;
    expect(petGearUIQuery(item).inputs.addon_status).toBe("高级神佑复生");
    expect(petGearUIQuery(item, true).inputs.addon_status).toBe("高级神佑复生");
  });
  it("没有名称的附加状态明确拒绝查询", () => {
    const item = {
      name: "金腕",
      description: "等级95\n命中率+13%\n耐久113\n套装效果：附加状态",
      accessory: false,
    } as PetGearPricingItem;
    expect(() => petGearUIQuery(item)).toThrow("宝宝装备附加状态名称缺失");
  });
  it("通过共享浏览器会话连接，在自有工作页读取已观察入口", async () => {
    const source = await createPetGearSource(new AbortController().signal, "1");
    await source.discover();
    expect(mocks.captureBrowserStep.mock.calls.map((call) => call[1].stage)).toEqual([
      "pet_gear.search.opened",
      "pet_gear.form.read",
    ]);
    expect(mocks.getBrowser).toHaveBeenCalledExactlyOnceWith(true);
    expect(mocks.goto).toHaveBeenCalledWith(
      PET_GEAR_SEARCH_URL,
      expect.objectContaining({ waitUntil: "domcontentloaded" }),
    );
    expect(mocks.readPetSearchForm).toHaveBeenCalledWith(
      await mocks.createHiddenPage.mock.results[0].value,
      PET_GEAR_SEARCH_URL,
    );
    await source.close();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("创建后取消或在创建过程中取消均关闭自有页", async () => {
    const controller = new AbortController();
    await createPetGearSource(controller.signal, "1");
    controller.abort(new Error("取消"));
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    const duringCreate = new AbortController();
    mocks.close.mockClear();
    mocks.createHiddenPage.mockImplementationOnce(async () => {
      duringCreate.abort(new Error("创建时取消"));
      return { goto: mocks.goto, close: mocks.close, isClosed: () => false };
    });
    await expect(createPetGearSource(duringCreate.signal, "1")).rejects.toThrow("创建时取消");
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("连接失败时不创建工作页或重复发起连接", async () => {
    mocks.getBrowser.mockRejectedValue(new Error("浏览器未连接"));
    await expect(createPetGearSource(new AbortController().signal, "1")).rejects.toThrow("未连接");
    expect(mocks.getBrowser).toHaveBeenCalledExactlyOnceWith(true);
    expect(mocks.createHiddenPage).not.toHaveBeenCalled();
  });
});

it("缺失目标服时宝宝装备source不创建页面", async () => {
  await expect(
    createPetGearSource(new AbortController().signal, undefined as unknown as string),
  ).rejects.toThrow("目标服务器");
  expect(mocks.getBrowser).not.toHaveBeenCalled();
});

it("宝宝装备开页失败记录实际页面与原始错误，不吞掉导航错误", async () => {
  const failure = new Error("fixture navigation failure");
  mocks.goto.mockRejectedValueOnce(failure);
  const signal = new AbortController().signal;
  const source = await createPetGearSource(signal, "1");
  try {
    await expect(source.discover()).rejects.toBe(failure);
    expect(mocks.captureBrowserStep.mock.calls.map((call) => call[1])).toEqual([
      { flow: "analysis", stage: "pet_gear.search.opened.failed", error: failure },
      { flow: "analysis", stage: "pet_gear.discover.failed", error: failure },
    ]);
  } finally {
    await source.close();
  }
});
