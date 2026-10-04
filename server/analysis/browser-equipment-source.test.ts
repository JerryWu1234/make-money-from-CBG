import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Page } from "playwright-core";
import {
  equipmentQuery,
  equipmentSourceFromPages,
  createEquipmentSource,
  type EquipmentSearchConfig,
} from "./browser-equipment-source";
import type { EquipmentPricingItem } from "./equipment-pricing";
import { itemFromAttributes } from "../crawler/compact";

const runtime = vi.hoisted(() => ({
  createHiddenPage: vi.fn(),
  getBrowser: vi.fn(),
  crawlDatabase: vi.fn(),
}));
vi.mock("../session", () => ({
  createHiddenPage: runtime.createHiddenPage,
  getBrowser: runtime.getBrowser,
}));
vi.mock("../crawler/controller", () => ({ crawlDatabase: runtime.crawlDatabase }));
vi.mock("../crawler/page", () => ({
  assertAvailable: vi.fn(),
  pace: async (signal: AbortSignal) => signal.throwIfAborted(),
}));

const config: EquipmentSearchConfig = {
  kinds: [
    [6, "剑"],
    [7, "双剑"],
    [73, "巨剑"],
    [5, "斧"],
    [83, "双斧"],
    [20, "腰带"],
  ],
  effects: [
    [3, "愤怒"],
    [5, "永不磨损"],
  ],
  skills: [
    [1036, "破血狂攻"],
    ["1041,2041", "乾坤斩"],
  ],
  gems: [[6, "黑宝石"]],
};
const item = (overrides: Partial<EquipmentPricingItem> = {}): EquipmentPricingItem => ({
  key: "道具/法宝:0",
  name: "测试腰带",
  level: 100,
  category: "人物装备 · 腰带",
  description: "等级：100\n防御：50\n特效：愤怒\n宝石：黑宝石\n锻炼等级：8\n修理失败：0",
  query: "",
  status: "no_match",
  referencePrice: null,
  candidates: [],
  issues: [],
  ...overrides,
});

describe("官方装备搜索条件", () => {
  it("从公开装备字段构造全服查询，保留修理失败0，不加入费用或区服", () => {
    const result = equipmentQuery(item(), config);
    expect(result).toMatchObject({
      jewelry: false,
      args: {
        level_min: 100,
        level_max: 100,
        kindid: "20",
        repair_fail: 0,
        special_effect: "3",
        special_mode: "and",
        gem_value: "6",
        gem_level: 8,
      },
    });
    for (const field of ["serverid", "server_type", "cross_buy_serverid", "price_min", "price_max"])
      expect(result.args).not.toHaveProperty(field);
  });

  it.each([
    ["双剑", "7"],
    ["巨剑", "73"],
    ["双斧", "83"],
  ])("不会把%s错配到更短武器名称", (category, kindid) => {
    expect(equipmentQuery(item({ category: "人物装备 · " + category }), config).args.kindid).toBe(
      kindid,
    );
  });

  it("同时筛选多个特效，保留官方复合特技ID", () => {
    const result = equipmentQuery(
      item({
        description: "等级：100\n特效：愤怒、永不磨损\n特技：乾坤斩",
      }),
      config,
    );
    expect(result.args.special_effect).toBe("3,5");
    expect(result.args.special_skill).toBe("1041,2041");
    expect(result.args.special_mode).toBe("and");
  });

  it("灵饰使用灵饰等级字段和精炼等级，配饰对应官方佩饰", () => {
    const jewelry = equipmentQuery(
      item({
        name: "测试配饰",
        category: "灵饰 · 配饰",
        level: 80,
        description: "等级：80\n速度：20\n精炼等级：6\n修理失败：0",
      }),
      {
        ...config,
        kinds: [
          [61, "戒指"],
          [62, "耳饰"],
          [63, "手镯"],
          [64, "佩饰"],
        ],
      },
    );
    expect(jewelry).toMatchObject({
      jewelry: true,
      args: {
        equip_level_min: 80,
        equip_level_max: 80,
        kindid: "64",
        jinglian_level: 6,
        repair_fail: 0,
      },
    });
    expect(jewelry.args).not.toHaveProperty("level_min");
  });

  it("等级缺失时不构造查价条件", () => {
    expect(() => equipmentQuery(item({ level: null }), config)).toThrow(/等级缺失/);
  });

  it("公开kindId有前导0也匹配页面的数值ID，优先于名称推测", () => {
    expect(
      equipmentQuery(item({ kindId: "025", category: "人物装备 · 双剑" }), {
        ...config,
        kinds: [...config.kinds, [25, "公开类型"]],
      }).args.kindid,
    ).toBe("25");
  });

  it("只有equip_type时不把物品模型编号当搜索分类ID", () => {
    const captured = itemFromAttributes(
      {
        data_equip_name: "测试装备",
        data_equip_type: "025",
        data_equip_level: "100",
        data_equip_desc: "等级：100\n防御：50",
      },
      0,
    );
    expect(captured.kindId).toBeUndefined();
    expect(
      equipmentQuery(item({ category: captured.category || "", kindId: captured.kindId }), {
        ...config,
        kinds: [[25, "公开类型"]],
      }).args,
    ).not.toHaveProperty("kindid");
  });

  it("公开kindId可识别泛型分类中的灵饰，保留61至64搜索类型", () => {
    const result = equipmentQuery(item({ category: "人物装备", kindId: "064" }), {
      ...config,
      kinds: [
        [61, "戒指"],
        [62, "耳饰"],
        [63, "手镯"],
        [64, "佩饰"],
      ],
    });
    expect(result).toMatchObject({
      jewelry: true,
      args: {
        kindid: "64",
        equip_level_min: 100,
        equip_level_max: 100,
      },
    });
  });
});

describe("装备查价拥有页面的生命周期", () => {
  const pages = () => {
    const search = { close: vi.fn(async () => {}) };
    const detail = { close: vi.fn(async () => {}), goto: vi.fn() };
    const control = new AbortController();
    const source = equipmentSourceFromPages(
      search as unknown as Page,
      detail as unknown as Page,
      control.signal,
    );
    return { search, detail, control, source };
  };

  it("关闭只作用于交给查价的两页，重复关闭或之后取消不重复处理", async () => {
    const { source, search, detail, control } = pages();
    await source.close();
    await source.close();
    control.abort();
    expect(search.close).toHaveBeenCalledOnce();
    expect(detail.close).toHaveBeenCalledOnce();
  });

  it("用户取消关闭两页，随后操作报告取消，不返回无匹配", async () => {
    const { source, search, detail, control } = pages();
    const reason = new Error("用户已暂停分析");
    control.abort(reason);
    await expect(source.findCandidates([item()], control.signal)).rejects.toBe(reason);
    await expect(
      source.readSource("https://xyq.cbg.163.com/equip?s=1&eid=test", control.signal),
    ).rejects.toBe(reason);
    expect(search.close).toHaveBeenCalledOnce();
    expect(detail.close).toHaveBeenCalledOnce();
    expect(detail.goto).not.toHaveBeenCalled();
  });

  it("一个页面关闭失败也尝试关闭另一页", async () => {
    const { source, search, detail } = pages();
    search.close.mockRejectedValueOnce(new Error("页面已经断开"));
    await source.close();
    expect(detail.close).toHaveBeenCalledOnce();
  });

  it("取消后再次关闭仍等待两页真正结束，不能提前报告清理完成", async () => {
    const { source, search, detail, control } = pages();
    let finishSearch!: () => void;
    let finishDetail!: () => void;
    search.close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSearch = resolve;
        }),
    );
    detail.close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishDetail = resolve;
        }),
    );
    control.abort(new Error("用户暂停"));
    let completed = false;
    const pending = source.close().then(() => {
      completed = true;
    });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(completed).toBe(false);
    } finally {
      finishSearch();
      finishDetail();
      await pending;
    }
    expect(completed).toBe(true);
  });

  it("不打开不安全网址，不访问任意外部站点", async () => {
    const { source, detail, control } = pages();
    try {
      await expect(
        source.readSource("https://example.com/equip?s=1&eid=test", control.signal),
      ).rejects.toThrow();
      expect(detail.goto).not.toHaveBeenCalled();
    } finally {
      await source.close();
    }
  });
});

describe("查价与采集共享浏览器锁", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const database = (changes = 1) => {
    const acquire = vi.fn().mockReturnValue({ changes });
    const release = vi.fn();
    runtime.crawlDatabase.mockReturnValue({
      prepare: vi.fn((sql: string) => ({ run: sql.startsWith("INSERT") ? acquire : release })),
    });
    return { acquire, release };
  };

  it("采集已经持锁时不连接Chrome、不创建装备页", async () => {
    const { release } = database(0);
    await expect(createEquipmentSource(new AbortController().signal)).rejects.toThrow(/采集/);
    expect(runtime.getBrowser).not.toHaveBeenCalled();
    expect(runtime.createHiddenPage).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("第二页创建失败时关闭第一页、释放本次锁并移除续租timer", async () => {
    const { acquire, release } = database();
    const searchPage = { close: vi.fn(async () => {}) };
    runtime.getBrowser.mockResolvedValue({});
    runtime.createHiddenPage
      .mockResolvedValueOnce(searchPage)
      .mockRejectedValueOnce(new Error("详情页创建失败"));
    await expect(createEquipmentSource(new AbortController().signal)).rejects.toThrow(
      /详情页创建失败/,
    );
    expect(searchPage.close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(acquire.mock.calls[0][0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("用户停止后清理自有页与锁，不留下续租timer", async () => {
    const { acquire, release } = database();
    const search = { close: vi.fn(async () => {}) },
      detail = { close: vi.fn(async () => {}) };
    runtime.getBrowser.mockResolvedValue({});
    runtime.createHiddenPage.mockResolvedValueOnce(search).mockResolvedValueOnce(detail);
    const control = new AbortController();
    const source = await createEquipmentSource(control.signal);
    control.abort(new Error("用户暂停"));
    await source.close();
    expect(search.close).toHaveBeenCalledOnce();
    expect(detail.close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(acquire.mock.calls[0][0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("续租失败中止查价，即便操作传入不同signal也不能继续", async () => {
    const { acquire, release } = database();
    const search = { close: vi.fn(async () => {}) };
    const detail = { close: vi.fn(async () => {}), goto: vi.fn() };
    runtime.getBrowser.mockResolvedValue({});
    runtime.createHiddenPage.mockResolvedValueOnce(search).mockResolvedValueOnce(detail);
    const source = await createEquipmentSource(new AbortController().signal);
    try {
      acquire.mockReturnValue({ changes: 0 });
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(source.findCandidates([item()], new AbortController().signal)).rejects.toThrow(
        /锁已失效/,
      );
      await expect(
        source.readSource(
          "https://xyq.cbg.163.com/equip?s=1&eid=test",
          new AbortController().signal,
        ),
      ).rejects.toThrow(/锁已失效/);
      expect(detail.goto).not.toHaveBeenCalled();
    } finally {
      await source.close();
    }
    expect(search.close).toHaveBeenCalledOnce();
    expect(detail.close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
