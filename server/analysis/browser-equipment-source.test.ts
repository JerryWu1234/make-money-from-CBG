import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Page, Request } from "playwright-core";
import {
  equipmentQuery,
  assertEquipmentUIArguments,
  readEquipmentSearchForm,
  equipmentQueryPlan,
  equipmentCursorMatches,
  equipmentListingMismatch,
  equipmentSourceFromPages,
  yuanshenQuery,
  YUANSHEN_SEARCH_URL,
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
  description: "等级：100\n防御：50\n气血：250\n特效：愤怒\n宝石：黑宝石\n锻炼等级：8\n修理失败：0",
  query: "",
  status: "no_match",
  referencePrice: null,
  candidates: [],
  issues: [],
  ...overrides,
});

it("元身映射使用观察到的控件值和单一主属性，不构造普通等级滑条", () => {
  expect(
    yuanshenQuery(
      item({
        name: "巨剑·元身",
        category: "元身",
        level: null,
        description: "伤害：500\n命中：600\n附加属性：力量+20\n附加特技概率：12%",
      }),
      {
        ...config,
        kinds: [
          [17, "剑"],
          [93, "巨剑"],
        ],
        namedKinds: [
          ["mingzhong", "命中"],
          ["shanghai", "伤害"],
        ],
        addedAttrs: [[51, "力量"]],
      },
      "1",
    ),
  ).toEqual({
    serverid: "1",
    type_choice: "93",
    attr_type: "shanghai",
    txt_attr_value: 500,
    addon_choices: "51",
    txt_addon_skill_chance: "12",
  });
});

describe("单服查询身份约束", () => {
  it.each(["", "0", "1,2", "未知"])(
    "目标服%s无效时在创建页面前拒绝，不回退全服",
    async (serverId) => {
      await expect(createEquipmentSource(new AbortController().signal, serverId)).rejects.toThrow(
        "服务器 ID",
      );
      expect(() => equipmentQuery(item(), config, serverId)).toThrow("服务器 ID");
    },
  );
});

describe("按各物品表单的等级边界生成查询", () => {
  it.each([0, 10, 20, 30, 40, 50, 65, 170])("普通装备%i级不能生成越界滑条查询", (level) => {
    expect(() => equipmentQuery(item({ level }), config, "1")).toThrow("装备检索");
  });
  it.each([60, 70, 160])("普通装备%i级仍可查询", (level) => {
    expect(equipmentQuery(item({ level }), config, "1").args).toMatchObject({
      level_min: level,
      level_max: level,
    });
  });
  it.each([60, 80, 160])("灵饰%i级使用灵饰表单", (level) => {
    const query = equipmentQuery(item({ category: "灵饰 · 戒指", level }), config, "1");
    expect(query).toMatchObject({
      jewelry: true,
      args: { equip_level_min: level, equip_level_max: level },
    });
    expect(query.args).not.toHaveProperty("level_min");
  });
  it.each([0, 50, 70, 90, 170])("灵饰%i级不套普通10级步长", (level) => {
    expect(() => equipmentQuery(item({ category: "灵饰 · 戒指", level }), config, "1")).toThrow(
      "灵饰检索",
    );
  });
});

describe("灵饰核心套装使用官方独立字符串映射", () => {
  const ring = item({
    name: "芙蓉戒",
    category: "人物装备 · 戒指",
    level: 80,
    description:
      "等级80\n防御21\n精炼等级5\n附加属性：\n法术伤害结果8[+15]\n法术伤害8[+20]\n法术暴击等级10[+20]\n特效：健步如飞（2级）\n速度+2",
  });
  const jewelryConfig = {
    ...config,
    kinds: [[61, "戒指"]] as Array<[number, string]>,
    jewelrySuitEffects: ["血气方刚", "通真达灵", "心无旁骛", "健步如飞"],
  };
  // Failure cases: numeric >= filters exclude authorized lower-base samples; old
  // enhancement stages reapply gems/refinement; jewelry effects must remain selected.
  it("单条件宽搜保留灵饰核心特效，不填主属性下限或精炼", () => {
    const plan = equipmentQueryPlan(ring, jewelryConfig, "1");
    expect(plan).toHaveLength(1);
    expect(plan[0].args).toEqual({
      equip_level_min: 80,
      equip_level_max: 80,
      pass_fair_show: "1",
      serverid: "1",
      kindid: "61",
      suit_effect: "4",
      suit_effect_level: 2,
    });
  });
  it.each([undefined, ["健步如飞", "健步如飞"], ["其他套装"]])(
    "官网映射缺失或同名多义不猜ID：%j",
    (jewelrySuitEffects) => {
      const { args } = equipmentQuery(ring, { ...jewelryConfig, jewelrySuitEffects }, "1");
      expect(args).not.toHaveProperty("suit_effect");
      expect(args).not.toHaveProperty("suit_effect_level");
    },
  );
  it("单件多个核心特效不假定只有其中一项", () => {
    const { args } = equipmentQuery(
      { ...ring, description: ring.description + "\n特效：血气方刚（2级）" },
      jewelryConfig,
      "1",
    );
    expect(args).not.toHaveProperty("suit_effect");
  });
  it("简易与带等级核心套装独立筛选，相近阶段也保留简易", () => {
    const target = { ...ring, description: ring.description + "\n特效：简易" };
    for (const { args } of equipmentQueryPlan(target, jewelryConfig, "1"))
      expect(args).toMatchObject({ special_effect: 1, suit_effect: "4", suit_effect_level: 2 });
    for (const extra of ["特效：血气方刚（2级）", "特效：未知新效果"])
      expect(
        equipmentQuery(
          { ...target, description: target.description + "\n" + extra },
          jewelryConfig,
          "1",
        ).args,
      ).not.toHaveProperty("suit_effect");
  });
});

describe("官方装备搜索条件", () => {
  it("核验并保留实际提交条件，列表顺序和玉魄属性数值表示差异不改变条件", () => {
    const expected = {
      level_min: 100,
      level_max: 100,
      serverid: "1",
      special_skill: "1041,2041",
      init_attrs: '{"102":20,"101":30}',
    };
    expect(() =>
      assertEquipmentUIArguments(expected, {
        ...expected,
        level_min: "100",
        special_skill: "2041,1041",
        init_attrs: '{"101":"30","102":"20"}',
      }),
    ).not.toThrow();
    const missing = { ...expected } as Record<string, string | number>;
    delete missing.level_min;
    expect(() => assertEquipmentUIArguments(expected, missing)).toThrow("level_min");
    expect(() => assertEquipmentUIArguments(expected, { ...expected, level_max: 160 })).toThrow(
      "level_max",
    );
  });
  it.each(["price_max", "star", "server_type"])(
    "拒绝实际表单恢复的未计划筛选 %s，不用范围缩小后的报价补价",
    (key) => {
      const expected = { level_min: 100, level_max: 100, serverid: "1" };
      expect(() => assertEquipmentUIArguments(expected, { ...expected, [key]: 1 })).toThrow(key);
      expect(() => assertEquipmentUIArguments(expected, { ...expected, [key]: "" })).not.toThrow();
    },
  );
  it("允许官网装备表单自带的 sum_attr_without_melt 默认值", () => {
    const expected = { level_min: 100, level_max: 100, serverid: "1" };
    expect(() =>
      assertEquipmentUIArguments(expected, { ...expected, sum_attr_without_melt: 1 }),
    ).not.toThrow();
  });
  it("允许官网灵饰表单登录后的 cross_buy_serverid 默认值", () => {
    const expected = { equip_level_min: 100, equip_level_max: 100, serverid: "1" };
    expect(() =>
      assertEquipmentUIArguments(expected, { ...expected, cross_buy_serverid: "482" }),
    ).not.toThrow();
  });
  it("灵饰分类缺失时用已分段主属性确认类型，不发送数值下限", () => {
    const jewelry = item({
      name: "莲音玦",
      category: "灵饰",
      level: 100,
      description:
        "等级 100\n速度 +16\n耐久度 277\n精炼等级 5\n附加属性：\n防御 +21 [+40]\n防御 +25 [+40]",
    });
    const jewelryConfig: EquipmentSearchConfig = {
      ...config,
      kinds: [
        [61, "戒指"],
        [62, "耳饰"],
        [63, "手镯"],
        [64, "佩饰"],
      ],
    };
    const query = equipmentQuery(jewelry, jewelryConfig, "1");
    expect(query.args.kindid).toBe("64");
    expect(query.args).not.toHaveProperty("speed");
  });
  it("人物装备提交身份范围和实际特效特技套装，不带数值下限或孔数", () => {
    const target = item({
      description: item().description + "\n开运孔数3\n套装：变身术之噬天虎\n特技：破血狂攻",
    });
    const plan = equipmentQueryPlan(
      target,
      {
        ...config,
        suitTypes: { transform_skill: [[1060, "噬天虎"]] },
      },
      "1",
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].args).toEqual({
      level_min: 100,
      level_max: 100,
      front_status: "pass_fair_show",
      serverid: "1",
      attr_without_melt: 1,
      kindid: "20",
      special_effect: "3",
      special_skill: "1036",
      special_mode: "and",
      suit_effect: "1060",
    });
  });
  it.each([
    ["双剑", "7"],
    ["巨剑", "73"],
    ["双斧", "83"],
  ])("不会把%s错配到更短武器名称", (category, kindid) => {
    expect(
      equipmentQuery(item({ category: "人物装备 · " + category }), config, "1").args.kindid,
    ).toBe(kindid);
  });

  it("同时筛选多个特效，保留官方复合特技ID", () => {
    const result = equipmentQuery(
      item({
        description: "等级：100\n特效：愤怒 永不磨损\n特技：乾坤斩",
      }),
      config,
      "1",
    );
    expect(result.args.special_effect).toBe("3,5");
    expect(result.args.special_skill).toBe("1041,2041");
    expect(result.args.special_mode).toBe("and");
  });

  it.each([
    ["附加状态变身", "4001"],
    ["变身术之鬼将", "1060"],
    ["追加法术龙卷雨击", "3018"],
    ["变化咒之蛟龙", "2060"],
  ])("普通装备按完整套装%s使用唯一官网映射", (suit, expected) => {
    const result = equipmentQuery(
      item({ description: item().description + "\n套装效果：" + suit }),
      {
        ...config,
        suits: [[4001, "变身"]],
        suitTypes: {
          added_status: [[4001, "变身"]],
          transform_skill: [[1060, "鬼将"]],
          append_skill: [[3018, "龙卷雨击"]],
          transform_charm: [[2060, "蛟龙"]],
        },
      },
      "1",
    );
    expect(result.args.suit_effect).toBe(expected);
  });

  it.each([
    { suits: [[1060, "鬼将"]] },
    { suitTypes: { transform_skill: [[1060, "鬼将"]] } },
    {
      suitTypes: {
        added_status: [
          [4001, "变身"],
          [4002, "变身"],
        ],
      },
    },
  ] satisfies Array<Partial<EquipmentSearchConfig>>)(
    "套装完整名称映射缺失或不唯一时阻止提交替代条件：%j",
    (mapping) => {
      expect(() =>
        equipmentQuery(
          item({ description: item().description + "\n套装效果：附加状态变身" }),
          { ...config, ...mapping },
          "1",
        ),
      ).toThrow(/套装.*唯一.*官网/);
    },
  );

  it("目标无套装不增加套装条件，特技只按实际完整名称匹配", () => {
    const observed = {
      ...config,
      suitTypes: { added_status: [[4001, "变身"]] } as EquipmentSearchConfig["suitTypes"],
      skills: [
        [1036, "破血狂攻"],
        [2036, "高级破血狂攻"],
      ] as EquipmentSearchConfig["skills"],
    };
    const query = equipmentQuery(
      item({ description: item().description + "\n特技：破血狂攻" }),
      observed,
      "1",
    );
    expect(query.args).not.toHaveProperty("suit_effect");
    expect(query.args.special_skill).toBe("1036");
    expect(() =>
      equipmentQuery(item({ description: item().description + "\n特技：破血" }), observed, "1"),
    ).toThrow(/特技.*唯一.*官网/);
  });

  it.each([
    [
      "变身术之黑熊",
      "transform_skill",
      [
        [1016, "黑熊"],
        [1027, "黑熊精"],
      ],
    ],
    [
      "变化咒之黑熊",
      "transform_charm",
      [
        [2010, "黑熊"],
        [2021, "黑熊精"],
      ],
    ],
    [
      "追加法术烈火",
      "append_skill",
      [
        [3039, "烈火"],
        [3043, "地狱烈火"],
      ],
    ],
  ] as const)("官网文本输入%s会产生额外ID且无同ID快捷选项时不提交", (suit, type, choices) => {
    const observed = {
      ...config,
      suitTypes: { [type]: choices.map(([id, name]) => [id, name]) },
    } as EquipmentSearchConfig;
    const target = item({ description: item().description + "\n套装效果：" + suit });
    expect(() => equipmentQuery(target, observed, "1")).toThrow(/文本控件.*无法精确/);
    observed.suits = [[choices[0][0], suit]];
    expect(equipmentQuery(target, observed, "1").args.suit_effect).toBe(String(choices[0][0]));
  });

  it("灵饰使用灵饰等级和类型范围，配饰对应官方佩饰", () => {
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
      "1",
    );
    expect(jewelry).toMatchObject({
      jewelry: true,
      args: {
        equip_level_min: 80,
        equip_level_max: 80,
        kindid: "64",
        serverid: "1",
      },
    });
    expect(jewelry.args).not.toHaveProperty("level_min");
  });

  it("等级缺失时不构造查价条件", () => {
    expect(() => equipmentQuery(item({ level: null }), config, "1")).toThrow(/等级缺失/);
  });

  it("公开kindId有前导0也匹配页面的数值ID，优先于名称推测", () => {
    expect(
      equipmentQuery(
        item({ kindId: "025", category: "人物装备 · 双剑" }),
        {
          ...config,
          kinds: [...config.kinds, [25, "公开类型"]],
        },
        "1",
      ).args.kindid,
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
      equipmentQuery(
        item({ category: captured.category || "", kindId: captured.kindId }),
        {
          ...config,
          kinds: [[25, "公开类型"]],
        },
        "1",
      ).args,
    ).not.toHaveProperty("kindid");
  });

  it("公开kindId可识别泛型分类中的灵饰，保留61至64搜索类型", () => {
    const result = equipmentQuery(
      item({ category: "人物装备", kindId: "064" }),
      {
        ...config,
        kinds: [
          [61, "戒指"],
          [62, "耳饰"],
          [63, "手镯"],
          [64, "佩饰"],
        ],
      },
      "1",
    );
    expect(result).toMatchObject({
      jewelry: true,
      args: {
        kindid: "64",
        equip_level_min: 100,
        equip_level_max: 100,
      },
    });
  });

  it.each([
    "防御296\n锻炼等级8\n镶嵌宝石 月亮石",
    "伤害300\n锻炼等级10\n镶嵌宝石 太阳石",
    "敏捷4\n防御37\n熔炼效果：+3防御",
  ])("基础值由详情核验方向，不向官网发送≥目标数值：%s", (description) => {
    const { args } = equipmentQuery(item({ description: "等级100\n" + description }), config, "1");
    expect(Object.keys(args).some((key) => key.startsWith("init_"))).toBe(false);
    for (const key of ["damage", "all_wakan", "gem_value", "gem_level", "repair_fail", "hole_num"])
      expect(args).not.toHaveProperty(key);
  });
  it("官网名称配置唯一明确武器分类时补kind，不靠自制名字表", () => {
    expect(
      equipmentQuery(
        item({ category: "人物装备", name: "鱼肠" }),
        {
          ...config,
          namedKinds: [[6, "剑"]],
        },
        "1",
      ).args.kindid,
    ).toBe("6");
    expect(
      equipmentQuery(
        item({ category: "人物装备", name: "月光" }),
        {
          ...config,
          namedKinds: [
            [6, "剑"],
            [13, "双环"],
          ],
        },
        "1",
      ).args,
    ).not.toHaveProperty("kindid");
  });

  it("灵饰不提交主附属性下限、精炼或条数条件", () => {
    const { args } = equipmentQuery(
      item({
        category: "灵饰 · 耳饰",
        kindId: "62",
        level: 80,
        description:
          "#r等级80#r法术伤害16#r精炼等级7#r#G法术伤害8[+28]#r#G法术伤害9[+28]#r#G速度8[+21]",
      }),
      { ...config, kinds: [[62, "耳饰"]] },
      "1",
    );
    expect(args).toEqual({
      equip_level_min: 80,
      equip_level_max: 80,
      pass_fair_show: "1",
      serverid: "1",
      kindid: "62",
    });
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
      equipmentListingMismatch(target, { description: "等级 70\n锻炼等级0\n" + description }, args),
    ).toContain(field === "特效" ? "特效" : "高于目标");
  });

  it("列表宝石还原证据不足时留给详情核验，不按含宝石值提前排除", () => {
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

  it("玉魄列表的占位等级0不当成普通装备等级冲突，型号仍由详情核验", () => {
    const jade = item({
      name: "上古玉魄·阳",
      category: "上古玉魄",
      level: null,
      modelId: "61718",
      description: "法术伤害结果 +9\n耐久度 147",
    });
    expect(equipmentListingMismatch(jade, { level: "0" }, {})).toBeNull();
    expect(equipmentListingMismatch(target, { level: "0" }, args)).toContain("等级");
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

  it("灵饰部分列表允许较低附加值，高于目标的已知词条排除", () => {
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
      "1",
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

  it.each([401, 403, 429])("详情HTTP %i作为访问门禁上抛，不进入普通详情重试", async (status) => {
    const { source, detail, control } = pages();
    detail.goto.mockResolvedValueOnce({ status: () => status } as never);
    try {
      await expect(
        source.readSource("https://xyq.cbg.163.com/equip?s=1&eid=blocked", control.signal),
      ).rejects.toThrow("HTTP " + status);
      expect(detail.goto).toHaveBeenCalledOnce();
    } finally {
      await source.close();
    }
  });
  it("当前及保存候选的服务器不符时不导航，不回退其他服", async () => {
    const { source, detail, control } = pages();
    try {
      await expect(
        source.readSource("https://xyq.cbg.163.com/equip?s=2&eid=other", control.signal),
      ).rejects.toThrow("目标服务器");
      await expect(
        source.readSource("https://xyq.cbg.163.com/equip/2/other", control.signal),
      ).rejects.toThrow("目标服务器");
      expect(detail.goto).not.toHaveBeenCalled();
    } finally {
      await source.close();
    }
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
    search: { close: vi.fn(async () => {}), goto: vi.fn(async () => {}) },
    detail: { close: vi.fn(async () => {}), goto: vi.fn() },
  });
  it.each([
    { category: "元身" },
    { category: "人物装备 · 元身" },
    { category: "人物装备 · 剑", modelId: "4221" },
    { category: "人物装备", modelId: "63232" },
  ])("元身发现进入独立入口，不导航普通装备表单：%j", async (changes) => {
    const original = pages();
    const search = {
      ...original.search,
      isClosed: () => false,
      waitForFunction: vi.fn(async () => {}),
      evaluate: vi.fn(async () => ({ controls: [], menus: [] })),
    };
    const detail = original.detail;
    runtime.createHiddenPage.mockResolvedValueOnce(search).mockResolvedValueOnce(detail);
    const signal = new AbortController().signal;
    const source = await createEquipmentSource(signal, "1");
    const target = item({ ...changes, name: "元身测试", level: 160 });
    try {
      await source.discover(target, signal);
      expect(search.goto).toHaveBeenCalledWith(YUANSHEN_SEARCH_URL, expect.any(Object));
      expect(search.goto).toHaveBeenCalledTimes(1);
      expect(detail.goto).not.toHaveBeenCalled();
    } finally {
      await source.close();
    }
  });
  it.each([
    { level: 50, category: "人物装备 · 腰带" },
    { level: 70, category: "灵饰 · 戒指" },
  ])("越界装备在导航前标记unsupported，避免使后续资产pending：%j", async (changes) => {
    const { search, detail } = pages();
    runtime.createHiddenPage.mockResolvedValueOnce(search).mockResolvedValueOnce(detail);
    const signal = new AbortController().signal;
    const source = await createEquipmentSource(signal, "1");
    const target = item(changes);
    try {
      await expect(source.discover(target, signal)).rejects.toThrow("检索");
      const result = await source.findCandidates([target], signal);
      expect(result.queries).toEqual([]);
      expect(result.items).toEqual([
        {
          key: target.key,
          candidates: [],
          searchState: "unsupported",
          note: expect.stringContaining("检索"),
        },
      ]);
      expect(search.goto).not.toHaveBeenCalled();
      expect(detail.goto).not.toHaveBeenCalled();
    } finally {
      await source.close();
    }
  });
  it("采集持锁时仍可查装备，只创建和关闭自有页", async () => {
    const { search, detail } = pages();
    runtime.createHiddenPage.mockResolvedValueOnce(search).mockResolvedValueOnce(detail);
    const source = await createEquipmentSource(new AbortController().signal, "1");
    await source.close();
    await source.close();
    expect(runtime.getBrowser).toHaveBeenCalledExactlyOnceWith(true);
    expect(runtime.createHiddenPage).toHaveBeenCalledTimes(2);
    expect(search.close).toHaveBeenCalledOnce();
    expect(detail.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("预先取消时不连接或创建页面", async () => {
    const control = new AbortController();
    control.abort(new Error("停止"));
    await expect(createEquipmentSource(control.signal, "1")).rejects.toThrow("停止");
    expect(runtime.getBrowser).not.toHaveBeenCalled();
    expect(runtime.createHiddenPage).not.toHaveBeenCalled();
  });
  it("第二页创建失败时关闭已创建的第一页", async () => {
    const { search } = pages();
    runtime.createHiddenPage
      .mockResolvedValueOnce(search)
      .mockRejectedValueOnce(new Error("详情页创建失败"));
    await expect(createEquipmentSource(new AbortController().signal, "1")).rejects.toThrow(
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
    await expect(createEquipmentSource(control.signal, "1")).rejects.toThrow("停止");
    expect(search.close).toHaveBeenCalledOnce();
    expect(detail.close).toHaveBeenCalledOnce();
  });
  it("暂停自动关闭两页，禁止后续查询", async () => {
    const { search, detail } = pages();
    runtime.createHiddenPage.mockResolvedValueOnce(search).mockResolvedValueOnce(detail);
    const control = new AbortController();
    const source = await createEquipmentSource(control.signal, "1");
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

describe("实际装备的分阶段相近检索", () => {
  const actualConfig: EquipmentSearchConfig = {
    ...config,
    kinds: [
      ...config.kinds,
      [15, "男头"],
      [16, "女头"],
      [17, "女衣"],
      [61, "戒指"],
      [62, "耳饰"],
      [63, "手镯"],
      [64, "佩饰"],
    ],
    gems: [
      [2, "太阳石"],
      [3, "舍利子"],
      [4, "光芒石"],
      [5, "月亮石"],
      [6, "黑宝石"],
    ],
  };
  it("实际人物装备只生成一条宽搜，宝石与修理不同不增加搜索阶段", () => {
    const target = item({
      name: "黑魔冠",
      category: "人物装备 · 头盔",
      level: 80,
      modelId: "2509",
      description: "等级80\n魔法95 防御142\n锻炼等级8 镶嵌宝石 月亮石\n装备角色：男",
    });
    expect(equipmentQueryPlan(target, actualConfig, "1")).toEqual([
      {
        mode: "base-attributes",
        args: {
          level_min: 80,
          level_max: 80,
          front_status: "pass_fair_show",
          serverid: "1",
          attr_without_melt: 1,
          kindid: "15",
        },
      },
    ]);
  });
  it("单条件宽搜仍保留核心特技与特效", () => {
    const plan = equipmentQueryPlan(
      item({ description: "等级100\n特技：破血狂攻\n特效：愤怒" }),
      actualConfig,
      "1",
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].args).toMatchObject({
      special_skill: "1036",
      special_effect: "3",
      special_mode: "and",
    });
  });
  it("头衣按实际穿戴性别匹配官网种类，未知性别不猜编号", () => {
    for (const [category, sex, expected] of [
      ["头盔", "男", "15"],
      ["头盔", "女", "16"],
      ["衣服", "男", "18"],
      ["衣服", "女", "17"],
    ])
      expect(
        equipmentQuery(
          item({ category: "人物装备 · " + category, description: "等级100\n装备角色：" + sex }),
          actualConfig,
          "1",
        ).args.kindid,
      ).toBe(expected);
    expect(
      equipmentQuery(
        item({ category: "人物装备 · 头盔", description: "等级100\n防御50\n气血250" }),
        actualConfig,
        "1",
      ).args,
    ).not.toHaveProperty("kindid");
  });
  it("游标必须与完整参数计划一致且位置有效，失配或旧版从头重新核验", () => {
    const cursor = {
      version: 1 as const,
      planHash: "expected",
      modeIndex: 1,
      pageNumber: 4,
      rowIndex: 20,
      pageRowsHash: "rows",
      seen: ["1:item"],
      failed: [{ url: "https://xyq.cbg.163.com/equip?s=1&eid=retry", modeIndex: 0 }],
    };
    expect(equipmentCursorMatches(cursor, "expected", 4)).toBe(true);
    expect(equipmentCursorMatches(cursor, "changed-settings", 4)).toBe(false);
    expect(equipmentCursorMatches({ ...cursor, pageNumber: 0 }, "expected", 4)).toBe(false);
    expect(equipmentCursorMatches({ ...cursor, rowIndex: -1 }, "expected", 4)).toBe(false);
  });
});

it("前件用完时间预算时后件候选和游标原样返回且标记未处理，不重新导航", async () => {
  vi.useFakeTimers();
  const search = { close: vi.fn(async () => {}), goto: vi.fn() };
  const detail = { close: vi.fn(async () => {}), goto: vi.fn() };
  const control = new AbortController();
  const source = equipmentSourceFromPages(
    search as unknown as Page,
    detail as unknown as Page,
    control.signal,
    "1",
  );
  const cursor = {
    version: 1 as const,
    planHash: "saved",
    modeIndex: 1,
    pageNumber: 4,
    rowIndex: 5,
    pageRowsHash: "rows",
    seen: ["1:previous"],
    failed: [],
  };
  const candidates = [100, 120].map((price, index) => ({
    url: "https://xyq.cbg.163.com/equip?s=1&eid=saved-" + index,
    title: "测试腰带",
    price,
    priceType: "listing" as const,
    quote: "挂牌价：¥" + price,
    verified: true,
    reason: "保存报价",
    matchType: "similar" as const,
    fetchedAt: new Date().toISOString(),
    sourceHash: "hash",
  }));
  try {
    vi.advanceTimersByTime(180001);
    const result = await source.findCandidates(
      [item({ searchCursor: cursor, candidates })],
      control.signal,
    );
    expect(result.items[0]).toMatchObject({
      skipped: true,
      searchState: "pending",
      searchCursor: cursor,
      candidates,
    });
    expect(search.goto).not.toHaveBeenCalled();
    expect(detail.goto).not.toHaveBeenCalled();
  } finally {
    await source.close();
    vi.useRealTimers();
  }
});

describe("装备最终市场请求范围审计", () => {
  const pages = (overrides: Record<string, string> = {}, emitRequest = true) => {
    const listeners = new Set<(request: Request) => void>();
    const fields: Record<string, string | number> = { level_min: 100, level_max: 100 };
    const selected = new Map<string, Set<number>>();
    const menus: Record<string, Array<[string | number, string]>> = {
      server_type_panel: [
        [3, "3年以上服"],
        [2, "1到3年服"],
        [1, "1年内服"],
      ],
      fair_show_panel: [
        ["pass_fair_show", "已上架"],
        ["fair_show", "公示期"],
      ],
      kind_check_panel: config.kinds,
      special_effect_panel: config.effects,
      special_skill_panel: config.skills,
      gem_panel: config.gems,
    };
    const menuFields: Record<string, string> = {
      server_type_panel: "server_type",
      fair_show_panel: "front_status",
      kind_check_panel: "kindid",
      special_effect_panel: "special_effect",
      special_skill_panel: "special_skill",
      gem_panel: "gem_value",
    };
    const emit = () => {
      if (!emitRequest) return;
      const params = new URLSearchParams({
        ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, String(value)])),
        act: "recommd_by_role",
        search_type: "overall_search_equip",
        page: "1",
        ...overrides,
      });
      const request = {
        url: () => "https://xyq.cbg.163.com/cgi-bin/recommend.py?" + params,
        postData: () => null,
      } as unknown as Request;
      for (const listener of listeners) listener(request);
    };
    const locate = (selector: string, index?: number): unknown => ({
      count: async () => 1,
      isVisible: async () => true,
      scrollIntoViewIfNeeded: async () => {},
      locator: () => ({ innerText: async () => "100级" }),
      fill: async (value: string) => {
        fields[selector.slice(1).replace(/^txt_/, "")] = value;
      },
      selectOption: async (value: string) => {
        if (selector === "#ovarall_sel_server") fields.serverid = value;
      },
      check: async () => {},
      setChecked: async (value: boolean) => {
        if (selector === "#chk_attr_with_melt") fields.attr_without_melt = Number(!value);
      },
      nth: (index: number) => locate(selector, index),
      click: vi.fn(async () => {
        if (selector === "#reset_all") {
          for (const key of Object.keys(fields)) delete fields[key];
          fields.level_min = 100;
          fields.level_max = 100;
          selected.clear();
        }
        if (selector === "#btn_equip_search") emit();
        const id = selector.slice(1).split(" ")[0];
        if (index !== undefined && menus[id]) {
          const values = selected.get(id) || new Set<number>();
          if (values.has(index)) values.delete(index);
          else values.add(index);
          selected.set(id, values);
          fields[menuFields[id]] = [...values].map((i) => menus[id][i][0]).join(",");
        }
      }),
    });
    const search = {
      goto: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      on: vi.fn((event: string, listener: (request: Request) => void) => {
        if (event === "request") listeners.add(listener);
      }),
      off: vi.fn((event: string, listener: (request: Request) => void) => {
        if (event === "request") listeners.delete(listener);
      }),
      waitForFunction: vi.fn(async () => {}),
      locator: vi.fn(locate),
      evaluate: vi.fn(async (fn: Function, argument?: unknown) => {
        if (fn.name === "marketServerArea") return "6";
        if (fn.name === "selectedMarketServer") return { areaId: "6", serverid: fields.serverid };
        if (fn.name === "readEquipmentMenu")
          return (menus[String(argument)] || []).map(([value]) => ({
            value: String(value),
            selected:
              selected
                .get(String(argument))
                ?.has((menus[String(argument)] || []).findIndex(([id]) => id === value)) || false,
            disabled: false,
          }));
        if (fn.name === "readEquipmentSlider") return { grid: 20, step: 10, range: [60, 160] };
        if (fn.name === "readEquipmentSubmittedFilters") return { ...fields };
        if (fn.name === "readEquipmentSearchDiagnostics")
          return {
            publicPath: "/cgi-bin/equipquery.py",
            readyState: "complete",
            overallSearch: false,
            ajaxWithRecommend: true,
            equipKinds: 0,
            jewelryKinds: 0,
            jadeConfig: false,
            searchArguments: false,
            loginRequired: false,
            serverAuthenticated: true,
            captchaRequired: false,
            busy: false,
            resultPresent: false,
            resultPage: null,
            resultOk: false,
            loadingVisible: false,
          };
        if (fn.name === "readPageSnapshot")
          return {
            url: "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=show_overall_search_equip",
            title: "全服装备搜索",
            ready: true,
            hasLogout: true,
            hasLogin: false,
            hasQr: false,
            hasRoles: false,
            hasDialog: false,
            serverName: "",
            serverAuthenticated: true,
          };
        if (argument && typeof argument === "object" && "jewelry" in argument) return config;
        if (typeof argument === "number")
          return {
            rows: [
              { url: "https://xyq.cbg.163.com/equip?s=33&eid=a", name: "其他装备" },
              { url: "https://xyq.cbg.163.com/equip?s=123&eid=b", name: "其他装备" },
              { url: "https://xyq.cbg.163.com/equip?s=123&eid=c", name: "其他装备" },
            ],
            empty: false,
            hasNext: false,
          };
      }),
    };
    const detail = { close: vi.fn(async () => {}), goto: vi.fn() };
    const control = new AbortController();
    const source = equipmentSourceFromPages(
      search as unknown as Page,
      detail as unknown as Page,
      control.signal,
      "1",
    );
    return { search, detail, source, control, listeners };
  };
  it("官网未明确类型时保留读取失败，不以缺少类型的宽搜价格计价", async () => {
    const { source, detail, control } = pages();
    try {
      const result = await source.findCandidates(
        [item({ category: "人物装备", description: "等级100\n防御50" })],
        control.signal,
      );
      expect(result.queries).toEqual([]);
      expect(result.items[0]).toMatchObject({ searchState: "read_failed", candidates: [] });
      expect(result.items[0].note).toContain("装备类型无法对应官网筛选");
      expect(detail.goto).not.toHaveBeenCalled();
    } finally {
      await source.close();
    }
  });
  it("响应携带本项官网筛选解析的目标kind，不改原库存或采用列表候选kind", async () => {
    const { source, control } = pages();
    const target = item({ description: "等级100\n防御50\n气血250\n锻炼等级0" });
    try {
      const result = await source.findCandidates([target], control.signal);
      expect(result.items[0]).toMatchObject({ kindId: "20" });
      expect(target.kindId).toBeUndefined();
      expect(result.searchItems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ args: expect.objectContaining({ kindid: "20" }) }),
        ]),
      );
    } finally {
      await source.close();
    }
  });
  it("后件启动组件超时仍保留前件结果与实际查询，后续件保留游标", async () => {
    const { source, search, control } = pages();
    search.waitForFunction
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("page.waitForFunction: Timeout 15000ms exceeded."));
    const laterCursor = {
      version: 1 as const,
      planHash: "saved",
      modeIndex: 2,
      pageNumber: 4,
      rowIndex: 8,
      pageRowsHash: "rows",
      seen: ["1:saved"],
      failed: [],
    };
    try {
      const result = await source.findCandidates(
        [
          item({ key: "first", description: "等级100\n防御50\n气血250" }),
          item({ key: "failed", description: "等级100\n防御50\n气血250" }),
          item({ key: "later", searchCursor: laterCursor }),
        ],
        control.signal,
      );
      expect(result.queries).toHaveLength(1);
      expect(result.items).toMatchObject([
        { key: "first", searchState: "completed" },
        { key: "failed", searchState: "read_failed", query: "" },
        { key: "later", searchState: "pending", skipped: true, searchCursor: laterCursor },
      ]);
      expect(result.items[1]).not.toHaveProperty("skipped");
      expect(result.searchItems).toMatchObject([
        { key: "first", scopeEvidence: [{ rowCount: 3 }] },
        {
          key: "failed",
          failure: {
            stage: "bootstrap",
            diagnostics: {
              publicPath: "/cgi-bin/equipquery.py",
              overallSearch: false,
              ajaxWithRecommend: true,
              equipKinds: 0,
              serverAuthenticated: true,
            },
          },
        },
      ]);
      expect(result.items[1].note).toContain("bootstrap");
      expect(search.goto).toHaveBeenCalledTimes(2);
    } finally {
      await source.close();
    }
  });
  it("列表等待失败保留本件请求与可恢复游标，不丢整轮", async () => {
    const { source, search, control } = pages();
    search.waitForFunction
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("page.waitForFunction: Timeout 20000ms exceeded."));
    try {
      const result = await source.findCandidates(
        [item({ description: "等级100\n防御50\n气血250" })],
        control.signal,
      );
      expect(result.queries).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        searchState: "read_failed",
        searchCursor: {
          modeIndex: 0,
          pageNumber: 1,
          rowIndex: 0,
        },
      });
      expect(result.searchItems).toMatchObject([{ failure: { stage: "query_wait" } }]);
    } finally {
      await source.close();
    }
  });
  it("导航失败只记录公开路径，首次未检索不伪造查询", async () => {
    const { source, search, control } = pages();
    search.goto.mockRejectedValueOnce(
      new Error(
        "page.goto: Timeout https://xyq.cbg.163.com/cgi-bin/equipquery.py?token=private-token",
      ),
    );
    try {
      const result = await source.findCandidates([item()], control.signal);
      expect(result.queries).toEqual([]);
      expect(result.items[0]).toMatchObject({ searchState: "read_failed", query: "" });
      expect(result.searchItems).toMatchObject([{ failure: { stage: "navigate" } }]);
      expect(JSON.stringify(result)).not.toContain("private-token");
    } finally {
      await source.close();
    }
  });
  it.each([
    "藏宝阁登录已失效",
    "藏宝阁要求安全验证",
    "访问过于频繁",
    "请输入验证码",
    "访问权限不足",
    "HTTP 403 Forbidden",
    "security policy rejected",
    "候选商品不属于目标服务器，未采用报价",
  ])("认证或限流错误继续上抛，不当普通结构失败：%s", async (message) => {
    const { source, search, control } = pages();
    search.waitForFunction.mockRejectedValueOnce(new Error(message));
    try {
      await expect(source.findCandidates([item()], control.signal)).rejects.toThrow(message);
    } finally {
      await source.close();
    }
  });
  it("记录helper后实际目标单服请求和每页服务器分布，关闭时移除监听", async () => {
    const { source, search, detail, control, listeners } = pages();
    try {
      const result = await source.findCandidates(
        [item({ description: "等级100\n防御50\n气血250" })],
        control.signal,
      );
      expect(result.searchItems).toEqual([
        expect.objectContaining({
          scopeEvidence: ["base-attributes"].map((mode) => ({
            mode,
            request: {
              endpoint: "https://xyq.cbg.163.com/cgi-bin/recommend.py",
              act: "recommd_by_role",
              searchType: "overall_search_equip",
              serverType: "",
              page: 1,
              restrictions: { serverid: "1" },
            },
            rowCount: 3,
            candidateServers: { "33": 1, "123": 2 },
          })),
        }),
      ]);
      expect(search.on).toHaveBeenCalledOnce();
      expect(detail.goto).not.toHaveBeenCalled();
      expect(listeners.size).toBe(1);
    } finally {
      await source.close();
    }
    expect(search.off).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
  });
  const restrictedScopes: Array<Record<string, string>> = [
    { serverid: "33" },
    { area_id: "1" },
    { server_type: "2,3" },
    { page: "2" },
  ];
  it.each(restrictedScopes)("helper后实际参数不满足范围时拒绝：%j", async (overrides) => {
    const { source, detail, control } = pages(overrides);
    try {
      await expect(
        source.findCandidates([item({ description: "等级100\n防御50\n气血250" })], control.signal),
      ).rejects.toThrow(/单服|请求|限制/);
      expect(detail.goto).not.toHaveBeenCalled();
    } finally {
      await source.close();
    }
  });
  it("只更新内存参数但没有最终市场请求时拒绝", async () => {
    const { source, detail, control } = pages({}, false);
    try {
      await expect(
        source.findCandidates([item({ description: "等级100\n防御50\n气血250" })], control.signal),
      ).rejects.toThrow("实际网络请求");
      expect(detail.goto).not.toHaveBeenCalled();
    } finally {
      await source.close();
    }
  });
});

describe("公开装备字段发现", () => {
  afterEach(() => vi.unstubAllGlobals());
  const setup = (loginPanel = false, captcha = false) => {
    class Input {
      constructor(
        public id: string,
        public name: string,
        public type: string,
        public value: string,
      ) {}
      checked = false;
      parentElement = null;
      checkVisibility() {
        return this.type !== "hidden" && this.type !== "password";
      }
      closest() {
        return { querySelector: () => ({ textContent: "装备等级" }) };
      }
    }
    class Select extends Input {
      options = [{ value: "61", text: "戒指", selected: true }];
    }
    const controls = [
      new Input("public-level", "level", "text", "80"),
      new Select("public-kind", "kindid", "select", "61"),
      new Input("hidden-token", "token", "hidden", "private-auth-secret"),
      new Input("account-urs", "account_urs", "text", "private-account-name"),
    ];
    const button = {
      id: "btn_lingshi_search",
      tagName: "A",
      innerText: "全服搜索",
      checkVisibility: () => true,
      getAttribute: () => null,
    };
    const choice = {
      retrieve: () => 61,
      getAttribute: () => null,
      innerText: "戒指",
      checkVisibility: () => true,
      classList: { contains: () => true },
    };
    const menu = {
      id: "kind_panel",
      innerText: "戒指",
      checkVisibility: () => true,
      querySelector: () => choice,
      querySelectorAll: () => [choice],
      closest: () => ({ querySelector: () => ({ textContent: "类型" }) }),
    };
    const root = {
      querySelectorAll: (selector: string) =>
        selector === "input[id],select[id]"
          ? controls
          : selector.startsWith("a[id]")
            ? [button]
            : selector === "ul[id],ol[id],div[id]"
              ? [menu]
              : [],
    };
    vi.stubGlobal("HTMLInputElement", Input);
    vi.stubGlobal("HTMLSelectElement", Select);
    vi.stubGlobal("window", {
      IsLogin: 0,
      LoginInfo: { login: 0, urs: "private-account-name" },
      CaptchaCheck: { need_captcha: captcha },
    });
    vi.stubGlobal("location", {
      origin: "https://xyq.cbg.163.com",
      pathname: "/cgi-bin/xyq_overall_search.py",
      href: "https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py?act=show_overall_search_lingshi&token=private-auth-secret",
    });
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.stubGlobal("document", {
      readyState: "complete",
      body: { innerText: "公开装备筛选" },
      querySelector: () => null,
      querySelectorAll: (selector: string) => {
        if (loginPanel && selector === "#qrcode,#loginContainer,input[type=password]")
          return [{ checkVisibility: () => true }];
        if (selector.startsWith(".searchForm,.js_search_form")) return [root];
        if (selector === "script[src]")
          return [
            {
              src: "https://cbg-xyq.res.netease.com/js/overall_lingshi.js?token=private-auth-secret",
            },
            { src: "https://external.example/overall_search.js" },
          ];
        return [];
      },
    });
    const page = {
      isClosed: () => false,
      evaluate: async (fn: Function) => fn(),
    } as unknown as Page;
    return page;
  };
  it("初始IsLogin0仍可发现公开表单，隐藏认证及账号字段不返回，不采用价格", async () => {
    const form = await readEquipmentSearchForm(setup());
    expect(form).toMatchObject({
      IsLogin: false,
      login: false,
      controls: [
        { id: "public-level", value: "80", visible: true },
        { id: "public-kind", options: [{ value: "61", label: "戒指" }] },
      ],
      menus: [{ id: "kind_panel", choices: [{ value: "61", label: "戒指", selected: true }] }],
      buttons: [{ id: "btn_lingshi_search", label: "全服搜索", visible: true }],
      scripts: ["https://cbg-xyq.res.netease.com/js/overall_lingshi.js"],
    });
    expect(JSON.stringify(form)).not.toMatch(
      /private-auth-secret|private-account-name|hidden-token|account-urs/,
    );
    expect(form).not.toHaveProperty("price");
  });
  it("显示登录面板或安全验证时不把页面当公共表单", async () => {
    await expect(readEquipmentSearchForm(setup(true))).rejects.toThrow("登录面板");
    await expect(readEquipmentSearchForm(setup(false, true))).rejects.toThrow("安全验证");
  });
});

it("官网类型确定为武器后，辅助气血0不能替代无法还原的初伤", () => {
  const query = equipmentQuery(
    item({
      category: "人物装备",
      description: "等级100\n伤害581\n命中750\n气血0\n锻炼等级10\n宝石：太阳石 红玛瑙",
    }),
    { ...config, namedKinds: [[6, "剑"]] },
    "1",
  );
  expect(query.args.kindid).toBe("6");
  expect(query.args).not.toHaveProperty("init_hp");
  expect(query.coreSkipReason).toContain("初始伤害");
});
it("官网类型已确认的衣服使用可还原初防，不因非核心气血未知而跳过", () => {
  const query = equipmentQuery(
    item({
      category: "人物装备",
      description: "等级100\n防御168\n气血348\n锻炼等级8\n宝石：光芒石 黑宝石",
    }),
    { ...config, namedKinds: [[18, "男衣"]] },
    "1",
  );
  expect(query.args).not.toHaveProperty("init_defense");
  expect(query.coreSkipReason).toBeNull();
});
