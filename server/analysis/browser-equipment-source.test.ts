import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Page } from "playwright-core";
import {
  equipmentQuery,
  equipmentListingMismatch,
  equipmentSourceFromPages,
  createEquipmentSource,
  type EquipmentSearchConfig,
} from "./browser-equipment-source";
import type { EquipmentPricingItem } from "./equipment-pricing";
import { CrawlStore } from "../crawler/store";
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
    [19, "鞋子"],
    [21, "饰品"],
    [18, "男衣"],
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
  addedAttrs: [
    [4, "法伤"],
    [3, "速度"],
    [13, "防御"],
    [14, "法防"],
    [12, "气血"],
  ],
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
  const suitConfig: EquipmentSearchConfig = {
    ...config,
    suits: [
      [4013, "炼气化神"],
      [4005, "逆鳞"],
    ],
    suitTypes: {
      added_status: [
        [4013, "炼气化神"],
        [4005, "逆鳞"],
      ],
      append_skill: [[3018, "龙卷雨击"]],
      transform_skill: [[1060, "噬天虎"]],
      transform_charm: [[2035, "蛟龙"]],
    },
  };
  it.each([
    ["附加状态炼气化神", "4013"],
    ["追加法术龙卷雨击", "3018"],
    ["追加技能：龙卷雨击", "3018"],
    ["变身术之噬天虎", "1060"],
    ["变化咒之蛟龙", "2035"],
    ["炼气化神", "4013"],
  ])("套装%s按官网对应类别准确取ID，相近查询允许套装差异", (suit, id) => {
    const target = item({ description: "等级100\n灵力56\n套装效果：" + suit });
    expect(equipmentQuery(target, suitConfig).args.suit_effect).toBe(id);
    expect(equipmentQuery(target, suitConfig, "similar").args).not.toHaveProperty("suit_effect");
  });

  it("有类别的同名套装只使用对应表，未指明类别或表内多ID不取首项", () => {
    const sameName: EquipmentSearchConfig = {
      ...suitConfig,
      suits: [[4013, "炼气化神"]],
      suitTypes: {
        added_status: [[4013, "炼气化神"]],
        append_skill: [[3018, "炼气化神"]],
      },
    };
    expect(
      equipmentQuery(item({ description: "等级100\n套装效果：附加状态炼气化神" }), sameName).args
        .suit_effect,
    ).toBe("4013");
    expect(
      equipmentQuery(item({ description: "等级100\n套装效果：追加法术炼气化神" }), sameName).args
        .suit_effect,
    ).toBe("3018");
    expect(
      equipmentQuery(item({ description: "等级100\n套装效果：炼气化神" }), sameName).args,
    ).not.toHaveProperty("suit_effect");
    sameName.suitTypes!.added_status!.push([4005, "炼气化神"]);
    expect(
      equipmentQuery(item({ description: "等级100\n套装效果：附加状态炼气化神" }), sameName).args,
    ).not.toHaveProperty("suit_effect");
  });

  it("套装配置缺失、名称未识别或多个套装条目时保留详情核验，不猜编号", () => {
    expect(
      equipmentQuery(item({ description: "等级100\n套装效果：附加状态炼气化神" }), config).args,
    ).not.toHaveProperty("suit_effect");
    for (const suit of [
      "附加状态未知名称",
      "附加状态炼气化神、逆鳞",
      "附加状态炼气化神\n套装效果：附加状态逆鳞",
    ])
      expect(
        equipmentQuery(item({ description: "等级100\n套装效果：" + suit }), suitConfig).args,
      ).not.toHaveProperty("suit_effect");
    expect(
      equipmentQuery(
        item({ category: "灵饰 · 耳饰", description: "等级100\n套装效果：附加状态炼气化神" }),
        suitConfig,
      ).args,
    ).not.toHaveProperty("suit_effect");
  });
  it("同配查询保持原下限，相近查询允许20%数值差和宝石/修理差异，保持同级同类型核心效果", () => {
    const target = item({
      category: "腰带",
      description: "等级70\n气血176 防御37\n耐久0\n修理失败3次",
      level: 70,
    });
    expect(equipmentQuery(target, config).args).toMatchObject({
      init_hp: 176,
      init_defense: 37,
      repair_fail: 3,
    });
    expect(equipmentQuery(target, config, "similar").args).toMatchObject({
      init_hp: 141,
      init_defense: 30,
      server_type: "3",
      level_min: 70,
      level_max: 70,
      kindid: "20",
    });
    expect(
      equipmentQuery(
        item({ description: "等级100\n伤害354 灵力89\n锻炼等级8\n镶嵌宝石：黑宝石\n特效：愤怒" }),
        config,
        "similar",
      ).args,
    ).toMatchObject({
      damage: 284,
      all_wakan: 72,
      special_effect: "3",
    });
    const args = equipmentQuery(target, config, "similar").args;
    for (const key of ["repair_fail", "gem_level", "gem_value"])
      expect(args).not.toHaveProperty(key);
  });
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
        server_type: "3",
      },
    });
    for (const field of ["serverid", "cross_buy_serverid", "price_min", "price_max"])
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
        description: "等级：100\n特效：愤怒 永不磨损\n特技：乾坤斩",
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
        server_type: "3",
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

  it("70级无宝石兽王腰带使用初血176、初防37下限，排除熔炼加值", () => {
    const { args } = equipmentQuery(
      item({
        name: "兽王腰带",
        level: 70,
        kindId: "20",
        description: "等级：70\n防御：37\n气血：176\n耐久：83\n修理失败：0",
      }),
      config,
    );
    expect(args).toMatchObject({
      level_min: 70,
      level_max: 70,
      kindid: "20",
      init_hp: 176,
      init_defense: 37,
      attr_without_melt: 1,
    });
    for (const field of ["hp", "defense", "dex", "init_dex", "attr_with_melt"])
      expect(args).not.toHaveProperty(field);
  });

  it("锻炼明确为0也允许初值，熔炼单列不混加到主属性", () => {
    const { args } = equipmentQuery(
      item({
        category: "人物装备 · 鞋子",
        kindId: "19",
        description:
          "等级：70\n气血：176\n防御：37\n敏捷：4\n锻炼等级：0\n熔炼效果：\n+3防御\n+10气血\n+2敏捷",
      }),
      config,
    );
    expect(args).toMatchObject({
      init_hp: 176,
      init_defense: 37,
      init_dex: 4,
      attr_without_melt: 1,
    });
    expect(args).not.toHaveProperty("attr_with_melt");
  });

  it.each([
    ["有宝石但锻炼字段缺失", "宝石：黑宝石"],
    ["有宝石且锻炼为0", "宝石：黑宝石\n锻炼等级：0"],
    ["锻炼大于0但宝石名缺失", "锻炼等级：8"],
    ["锻炼字段混合多值", "锻炼等级：0\n锻炼等级：8"],
    ["锻炼字段不明确", "锻炼等级：未知"],
    ["锻炼字段不是整数格式", "锻炼等级：0.0"],
  ])("%s时不发送可能含宝石效果的初值", (_label, gemDescription) => {
    const { args } = equipmentQuery(
      item({
        category: "人物装备 · 鞋子",
        kindId: "19",
        description: "等级：70\n气血：176\n防御：37\n敏捷：4\n" + gemDescription,
      }),
      config,
    );
    for (const field of ["init_hp", "init_defense", "init_dex", "attr_without_melt"])
      expect(args).not.toHaveProperty(field);
  });

  it.each([0, 10000])("官网范围端点%d完整保留，包括0不会因真假判断丢失", (value) => {
    const { args } = equipmentQuery(
      item({
        category: "人物装备 · 鞋子",
        kindId: "19",
        description: `等级：70\n气血：${value}\n防御：${value}\n敏捷：${value}`,
      }),
      config,
    );
    expect(args).toMatchObject({
      init_hp: value,
      init_defense: value,
      init_dex: value,
      attr_without_melt: 1,
    });
  });

  it.each(["10001", "-1", "37.5", "未知"])("主属性%s不在官网整数范围时不发送初值", (value) => {
    const { args } = equipmentQuery(
      item({
        category: "人物装备 · 鞋子",
        kindId: "19",
        description: `等级：70\n气血：${value}\n防御：${value}\n敏捷：${value}`,
      }),
      config,
    );
    for (const field of ["init_hp", "init_defense", "init_dex", "attr_without_melt"])
      expect(args).not.toHaveProperty(field);
  });

  it("多个防御值不擅自合并，其余明确的气血仍可过滤", () => {
    const { args } = equipmentQuery(
      item({
        description: "等级：70\n防御：37\n防御：40\n气血：176",
      }),
      config,
    );
    expect(args).not.toHaveProperty("init_defense");
    expect(args).toMatchObject({ init_hp: 176, attr_without_melt: 1 });
  });

  it("泛型装备只在官网kind标签明确为鞋子时发送初敏", () => {
    const { args } = equipmentQuery(
      item({ category: "人物装备", kindId: "019", description: "等级：70\n敏捷：4" }),
      config,
    );
    expect(args).toMatchObject({ kindid: "19", init_dex: 4, attr_without_melt: 1 });
  });

  it.each([
    ["饰品", "21"],
    ["剑", "6"],
    ["男衣", "18"],
    ["未知类型", undefined],
  ])("%s的敏捷不当作鞋子初敏", (category, kindId) => {
    const { args } = equipmentQuery(
      item({ category: "人物装备 · " + category, kindId, description: "等级：70\n敏捷：4" }),
      config,
    );
    expect(args).not.toHaveProperty("init_dex");
    expect(args).not.toHaveProperty("attr_without_melt");
  });

  it("已解析kind是饰品时，即使采集分类写鞋子也不发送初敏", () => {
    const { args } = equipmentQuery(
      item({ category: "人物装备 · 鞋子", kindId: "21", description: "等级：70\n敏捷：4" }),
      config,
    );
    expect(args.kindid).toBe("21");
    expect(args).not.toHaveProperty("init_dex");
  });

  it("官网配置没有识别kind时不根据19这个编号猜初敏", () => {
    const { args } = equipmentQuery(
      item({ category: "人物装备", kindId: "19", description: "等级：70\n敏捷：4" }),
      { ...config, kinds: [] },
    );
    expect(args).not.toHaveProperty("kindid");
    expect(args).not.toHaveProperty("init_dex");
  });

  it("鞋子多个敏捷值不擅自合并，其余明确初防仍可过滤", () => {
    const { args } = equipmentQuery(
      item({
        category: "人物装备 · 鞋子",
        kindId: "19",
        description: "等级：70\n敏捷：4\n敏捷：6\n防御：37",
      }),
      config,
    );
    expect(args).not.toHaveProperty("init_dex");
    expect(args).toMatchObject({ init_defense: 37, attr_without_melt: 1 });
  });

  it("灵饰保持原有精炼筛选，不套用普通装备初属性字段", () => {
    const { jewelry, args } = equipmentQuery(
      item({
        category: "灵饰 · 佩饰",
        kindId: "64",
        description: "等级：100\n防御：37\n气血：176\n敏捷：4\n精炼等级：0",
      }),
      { ...config, kinds: [[64, "佩饰"]] },
    );
    expect(jewelry).toBe(true);
    expect(args).toMatchObject({ equip_level_min: 100, kindid: "64", jinglian_level: 0 });
    for (const field of ["init_hp", "init_defense", "init_dex", "attr_without_melt"])
      expect(args).not.toHaveProperty(field);
  });

  it("官网名称配置唯一明确武器分类时补kind，不靠自制名字表", () => {
    expect(
      equipmentQuery(item({ category: "人物装备", name: "鱼肠" }), {
        ...config,
        namedKinds: [[6, "剑"]],
      }).args.kindid,
    ).toBe("6");
    expect(
      equipmentQuery(item({ category: "人物装备", name: "月光" }), {
        ...config,
        namedKinds: [
          [6, "剑"],
          [13, "双环"],
        ],
      }).args,
    ).not.toHaveProperty("kindid");
  });

  it("灵饰主法伤和双附加法伤分开，按官网配置生成明细词条计数", () => {
    const { args } = equipmentQuery(
      item({
        category: "灵饰 · 耳饰",
        kindId: "62",
        level: 80,
        description:
          "#r等级 80#r法术伤害 +16#r精炼等级 7#r#G法术伤害 +8[+28]#r#G法术伤害 +9[+28]#r#G速度 +8[+21]",
      }),
      { ...config, kinds: [[62, "耳饰"]] },
    );
    expect(args).toMatchObject({
      kindid: "62",
      magic_damage: 16,
      jinglian_level: 7,
      added_attr_logic: "detail",
      added_attr_num: "3",
      "added_attr.4": 2,
      "added_attr.3": 1,
    });
    expect(args).not.toHaveProperty("synthesized_attr_total");
    expect(args).not.toHaveProperty("added_attr_repeat_num");
  });

  it("灵饰无码旧描述不把主法伤与附加法伤混成三法伤筛选", () => {
    const { args } = equipmentQuery(
      item({
        category: "灵饰 · 耳饰",
        kindId: "62",
        description: "等级 80\n法术伤害 +16\n精炼等级 7\n法术伤害 +8\n法术伤害 +9\n速度 +8",
      }),
      { ...config, kinds: [[62, "耳饰"]] },
    );
    expect(args).not.toHaveProperty("magic_damage");
    expect(args).not.toHaveProperty("added_attr_logic");
  });

  it("灵饰完整三同名附加词条逐条计数，不覆盖重复项", () => {
    const { args } = equipmentQuery(
      item({
        category: "灵饰 · 耳饰",
        description:
          "等级 80\n法术防御 +16\n精炼等级 0\n附加属性：\n法术伤害 +8\n法术伤害 +9\n法术伤害 +10",
      }),
      { ...config, kinds: [[62, "耳饰"]] },
    );
    expect(args).toMatchObject({
      magic_defense: 16,
      jinglian_level: 0,
      "added_attr.4": 3,
      added_attr_num: "3",
    });
  });

  it("灵饰词条缺官方映射时不发送不完整的组合，主属性0和精炼越界不发送", () => {
    const { args } = equipmentQuery(
      item({
        category: "灵饰 · 耳饰",
        description: "等级 80\n法术伤害 0\n精炼等级 17\n附加属性：\n法术伤害 +8\n速度 +9",
      }),
      { ...config, kinds: [[62, "耳饰"]], addedAttrs: [[4, "法伤"]] },
    );
    for (const key of ["magic_damage", "jinglian_level", "added_attr_logic", "added_attr.4"])
      expect(args).not.toHaveProperty(key);
  });
});

describe("官网列表前置排除", () => {
  const target = item({ description: "等级 70\n气血 +176 防御 +37\n耐久度 435", level: 70 });
  const args = { kindid: "20" };

  it.each([
    ["气血 +475 防御 +43", "气血"],
    ["气血 +176 防御 +45", "防御"],
    ["气血 +176 防御 +37\n特效：简易", "特效"],
  ])("列表已明确%s时不再打开详情", (description, field) => {
    expect(
      equipmentListingMismatch(target, { description: "等级 70\n" + description }, args),
    ).toContain(field);
  });

  it("列表20%内数值差和宝石差异留给详情作为相近候选，不提前排除", () => {
    expect(
      equipmentListingMismatch(
        target,
        { description: "等级70\n气血176 防御40\n锻炼等级7 镶嵌宝石光芒石" },
        args,
      ),
    ).toBeNull();
  });

  it("明确kind或等级冲突直接排除，缺少资料仍留给详情核验", () => {
    expect(equipmentListingMismatch(target, { kindId: "19" }, args)).toContain("分类");
    expect(equipmentListingMismatch(target, { kindId: "020", level: "80" }, args)).toContain(
      "等级",
    );
    expect(equipmentListingMismatch(target, {}, args)).toBeNull();
    expect(equipmentListingMismatch(target, { description: "等级 70\n防御 +37" }, args)).toBeNull();
  });

  it("耐久差异不排除，数值格式等价时仍打开详情", () => {
    expect(
      equipmentListingMismatch(
        target,
        { description: "等级：70<br>防御：37<br>气血：176<br>耐久度：5" },
        args,
      ),
    ).toBeNull();
  });

  it("灵饰部分列表允许相近附加值，超过20%的已知词条仍排除", () => {
    const jewelry = item({
      description: "等级 80\n法术伤害 +16\n法术伤害 +8\n法术伤害 +9",
      level: 80,
    });
    expect(
      equipmentListingMismatch(jewelry, { description: "等级 80\n法术伤害 +8" }, {}),
    ).toBeNull();
    expect(
      equipmentListingMismatch(jewelry, { description: "等级 80\n法术伤害 +30" }, {}),
    ).toContain("法术伤害");
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

describe("装备查价使用独立后台页", () => {
  let crawl: CrawlStore;
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    crawl = new CrawlStore(":memory:");
    expect(crawl.acquire("collecting")).toBe(true);
    runtime.crawlDatabase.mockReturnValue(crawl.db);
    runtime.getBrowser.mockResolvedValue({});
  });
  afterEach(() => {
    expect(crawl.db.prepare("SELECT owner FROM crawl_lock").get()?.owner).toBe("collecting");
    crawl.close();
    vi.useRealTimers();
  });
  const pages = () => ({
    search: { close: vi.fn(async () => {}) },
    detail: { close: vi.fn(async () => {}), goto: vi.fn() },
  });
  it("采集持锁时仍可查装备，只创建和关闭自有页", async () => {
    const { search, detail } = pages();
    runtime.createHiddenPage.mockResolvedValueOnce(search).mockResolvedValueOnce(detail);
    const source = await createEquipmentSource(new AbortController().signal);
    await source.close();
    await source.close();
    expect(runtime.getBrowser).toHaveBeenCalledWith();
    expect(runtime.createHiddenPage).toHaveBeenCalledTimes(2);
    expect(search.close).toHaveBeenCalledOnce();
    expect(detail.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("预先取消时不连接或创建页面", async () => {
    const control = new AbortController();
    control.abort(new Error("停止"));
    await expect(createEquipmentSource(control.signal)).rejects.toThrow("停止");
    expect(runtime.getBrowser).not.toHaveBeenCalled();
    expect(runtime.createHiddenPage).not.toHaveBeenCalled();
  });
  it("第二页创建失败时关闭已创建的第一页", async () => {
    const { search } = pages();
    runtime.createHiddenPage
      .mockResolvedValueOnce(search)
      .mockRejectedValueOnce(new Error("详情页创建失败"));
    await expect(createEquipmentSource(new AbortController().signal)).rejects.toThrow(
      "详情页创建失败",
    );
    expect(search.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("创建途中取消时清理两页", async () => {
    const { search, detail } = pages();
    const control = new AbortController();
    runtime.createHiddenPage.mockResolvedValueOnce(search).mockImplementationOnce(async () => {
      control.abort(new Error("停止"));
      return detail;
    });
    await expect(createEquipmentSource(control.signal)).rejects.toThrow("停止");
    expect(search.close).toHaveBeenCalledOnce();
    expect(detail.close).toHaveBeenCalledOnce();
  });
  it("暂停自动关闭两页，禁止后续查询", async () => {
    const { search, detail } = pages();
    runtime.createHiddenPage.mockResolvedValueOnce(search).mockResolvedValueOnce(detail);
    const control = new AbortController();
    const source = await createEquipmentSource(control.signal);
    control.abort(new Error("用户暂停"));
    await source.close();
    await expect(source.findCandidates([item()], new AbortController().signal)).rejects.toThrow(
      "用户暂停",
    );
    await expect(
      source.readSource("https://xyq.cbg.163.com/equip?s=1&eid=test", new AbortController().signal),
    ).rejects.toThrow("用户暂停");
    expect(detail.goto).not.toHaveBeenCalled();
    expect(search.close).toHaveBeenCalledOnce();
    expect(detail.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
