import { describe, expect, it } from "vite-plus/test";
import type { EquipmentPricingItem } from "./equipment-pricing";
import {
  classifyOrdinaryEquipment,
  DEFAULT_EQUIPMENT_BASELINE_PRICES,
  EQUIPMENT_BASELINE_POLICY_VERSION,
  makeEquipmentBaseline,
  validateEquipmentBaseline,
  type EquipmentBaselineSettings,
} from "./equipment-baseline";

type Slot = "weapon" | "body" | "head" | "neck" | "belt" | "shoe";
const descriptions: Record<Slot, string> = {
  weapon: "伤害190 命中220",
  body: "防御100",
  head: "防御35 魔法65",
  neck: "灵力77",
  belt: "防御35 气血140",
  shoe: "防御35 敏捷22",
};
const categories: Record<Slot, string> = {
  weapon: "人物装备 · 武器",
  body: "人物装备 · 衣服",
  head: "人物装备 · 头盔",
  neck: "人物装备 · 饰品",
  belt: "人物装备 · 腰带",
  shoe: "人物装备 · 鞋子",
};
const item = (slot: Slot = "belt", description = descriptions[slot]): EquipmentPricingItem => ({
  key: "道具/法宝:0",
  name: "测试装备",
  level: 60,
  category: categories[slot],
  description: "等级60\n" + description + "\n耐久度300\n装备条件：等级60",
  status: "no_match",
  query: "",
  referencePrice: null,
  candidates: [],
  issues: [],
});
const settings = (): EquipmentBaselineSettings => ({
  servers: [
    {
      serverId: "941",
      age: "older",
      rank: null,
      goldPrice: 100,
      goldUnit: 1_000_000,
      baselineUnitConfirmed: true,
    },
  ],
});
const atLevel = (level: number, slot: Slot = "belt") => {
  const value = item(slot);
  value.level = level;
  value.description = value.description.replaceAll("等级60", "等级" + level);
  return value;
};

describe("普通装备的保守分流", () => {
  it.each(["weapon", "body", "head", "neck", "belt", "shoe"] as Slot[])(
    "六部位%s必要主属性齐全才进入普通价格规则",
    (slot) => {
      expect(classifyOrdinaryEquipment(item(slot))).toBe("ring");
      const missing = item(slot, "耐久度300");
      expect(classifyOrdinaryEquipment(missing)).toBeNull();
    },
  );
  it.each([
    [60, "ring"],
    [70, "ring"],
    [80, "ring"],
    [90, "white"],
    [100, "white"],
  ] as const)("%s级普通装备分到%s", (level, kind) => {
    expect(classifyOrdinaryEquipment(atLevel(level))).toBe(kind);
  });
  it("保守线性门槛接受70武器国标命中255，项链89；更高值继续单独估价", () => {
    const weapon = atLevel(70, "weapon");
    weapon.description = "等级70\n伤害220 命中255\n耐久300";
    expect(classifyOrdinaryEquipment(weapon)).toBe("ring");
    weapon.description = weapon.description.replace("命中255", "命中256");
    expect(classifyOrdinaryEquipment(weapon)).toBeNull();
    const necklace = atLevel(70, "neck");
    necklace.description = "等级70\n灵力89\n耐久300";
    expect(classifyOrdinaryEquipment(necklace)).toBe("ring");
    necklace.description = necklace.description.replace("灵力89", "灵力90");
    expect(classifyOrdinaryEquipment(necklace)).toBeNull();
  });
  it.each([
    "特技：破碎无双",
    "特效：专注",
    "套装效果：附加状态炼气化神",
    "点化特效：健步如飞",
    "力量+1",
    "体质-1",
    "锻炼等级0",
    "镶嵌宝石黑宝石",
    "符石：敏捷+1",
    "熔炼效果：+1防御",
    "开运孔数0孔/3孔",
    "附加属性：气血1",
    "玩家123专用",
    "绑定",
    "不可交易",
    "强化打造",
    "法术特殊效果+1",
    "未知价格字段：1",
    "属性尚未读取…",
  ])("%s不能冒充普通环/白板", (extra) => {
    const value = item();
    value.description += "\n" + extra;
    expect(classifyOrdinaryEquipment(value)).toBeNull();
  });
  it("五行、制造者允许保留，制造者后的强化打造仍排除", () => {
    const value = item();
    value.description += "\n五行 金\n制造者：测试工匠";
    expect(classifyOrdinaryEquipment(value)).toBe("ring");
    value.description += " 强化打造";
    expect(classifyOrdinaryEquipment(value)).toBeNull();
  });
  it("重复或更高的基础属性、缺耐久、耐久0和修理失败不能进入普通规则", () => {
    for (const description of [
      "防御35 气血141",
      "防御35 防御35 气血140",
      "防御35 气血140\n修理失败1次",
    ]) {
      expect(classifyOrdinaryEquipment(item("belt", description))).toBeNull();
    }
    const value = item();
    value.description = value.description.replace("耐久度300", "耐久度0");
    expect(classifyOrdinaryEquipment(value)).toBeNull();
    value.description = value.description.replace("耐久度0", "");
    expect(classifyOrdinaryEquipment(value)).toBeNull();
    const intact = item();
    intact.description += "\n修理失败0次";
    expect(classifyOrdinaryEquipment(intact)).toBe("ring");
  });
  it("等级以真实装备等级判断，不能将30级伤害80的武器当作80级", () => {
    const value = atLevel(30, "weapon");
    value.description = "等级30\n伤害80 命中76\n耐久250";
    expect(classifyOrdinaryEquipment(value)).toBe("ignored");
    const special = atLevel(50, "belt");
    special.description = "等级50\n气血100 防御22\n耐久350\n套装效果：附加状态生命之泉";
    expect(classifyOrdinaryEquipment(special)).toBeNull();
  });
  it("0级普通装备保留unsupported状态并明确低值排除，不需要金价", () => {
    const value = atLevel(0, "weapon");
    value.status = "unsupported";
    value.description = "五行 水\n命中20 伤害15\n耐久100\n装备条件：等级0";
    const before = JSON.stringify(value);
    const baseline = makeEquipmentBaseline(value, "941", { servers: [] });
    expect(classifyOrdinaryEquipment(value)).toBe("ignored");
    expect(baseline).toMatchObject({
      kind: "ignored",
      amount: 0,
      gameCurrency: 0,
      source: { basis: "excluded" },
    });
    expect(baseline?.note).toContain("不表示其市场售价为0");
    expect(JSON.stringify(value)).toBe(before);
    expect(
      validateEquipmentBaseline({ ...value, baselineEstimate: baseline }, "941", { servers: [] }),
    ).toBe(true);
  });
  it("灵饰category误标时仍按kind或model排除，不用精炼存在与否判断", () => {
    for (const modelId of ["27003", "27102", "27202", "27302"]) {
      const value = item();
      value.modelId = modelId;
      expect(classifyOrdinaryEquipment(value)).toBeNull();
    }
    for (const kindId of ["61", "062", "63", "64"]) {
      const value = item();
      value.kindId = kindId;
      expect(classifyOrdinaryEquipment(value)).toBeNull();
    }
    const special = item();
    special.category = "上古玉魄";
    expect(classifyOrdinaryEquipment(special)).toBeNull();
  });
  it("普通泛型装备只能用明确成对主属性分类，单独防御不能猜成衣服", () => {
    const value = item();
    value.category = "人物装备";
    expect(classifyOrdinaryEquipment(value)).toBe("ring");
    value.description = "等级60\n防御35\n耐久300";
    expect(classifyOrdinaryEquipment(value)).toBeNull();
    value.category = "灵饰";
    expect(classifyOrdinaryEquipment(value)).toBeNull();
  });
  it("已报价、带候选、价钱非null或级别冲突不建立默认价", () => {
    expect(classifyOrdinaryEquipment({ ...item(), status: "priced" })).toBeNull();
    expect(classifyOrdinaryEquipment({ ...item(), referencePrice: 1 })).toBeNull();
    expect(classifyOrdinaryEquipment({ ...item(), candidates: [{} as never] })).toBeNull();
    expect(classifyOrdinaryEquipment({ ...item(), level: 70 })).toBeNull();
  });
});

describe("基准价金额、来源和冻结校验", () => {
  it("60/90/100默认暂不计价，不能用0补未知，仍保留分类与可填价提示", () => {
    for (const level of [60, 90, 100]) {
      expect(DEFAULT_EQUIPMENT_BASELINE_PRICES[String(level) as "60"].armor).toBeNull();
      const baseline = makeEquipmentBaseline(atLevel(level), "941", settings());
      expect(baseline).toMatchObject({
        gameCurrency: null,
        amount: null,
        source: { basis: "preset" },
      });
      expect(baseline?.note).toContain("缺少此等级普通装备的默认价");
    }
  });
  it.each([
    [70, "belt", 80_000, 8],
    [70, "weapon", 110_000, 11],
    [80, "belt", 400_000, 40],
    [80, "weapon", 480_000, 48],
  ] as const)("%s级%s按历史游戏币%s及本服金价换算为%s元", (level, slot, gameCurrency, amount) => {
    const baseline = makeEquipmentBaseline(atLevel(level, slot), "941", settings());
    expect(baseline).toMatchObject({
      policyVersion: EQUIPMENT_BASELINE_POLICY_VERSION,
      gameCurrency,
      amount,
      serverId: "941",
      goldPrice: 100,
      goldUnit: 1_000_000,
      source: {
        basis: "historical",
        url: "https://www.dvg.cn/wygl/90894.html",
        publishedAt: "2025-11-22",
      },
    });
    expect(baseline?.note).toContain("非当前行情");
  });
  it.each(["one", "three", null] as const)("三年外历史样本不适用于年代%s", (age) => {
    const config = settings();
    config.servers[0].age = age;
    const baseline = makeEquipmentBaseline(atLevel(70), "941", config);
    expect(baseline).toMatchObject({ amount: null, gameCurrency: null });
    expect(baseline?.note).toContain("不适用于当前区服年代");
  });
  it("用户改价标人工来源，不借历史文章背书；明确人工价可供不同年代使用", () => {
    const config = settings();
    config.servers[0].age = "one";
    config.equipmentBaselinePrices = structuredClone(DEFAULT_EQUIPMENT_BASELINE_PRICES);
    config.equipmentBaselinePrices["70"].armor = 90_000;
    const baseline = makeEquipmentBaseline(atLevel(70), "941", config);
    expect(baseline).toMatchObject({
      gameCurrency: 90_000,
      amount: 9,
      source: { basis: "preset" },
    });
    expect(baseline?.source).not.toHaveProperty("url");
    expect(baseline?.source).not.toHaveProperty("publishedAt");
  });
  it("金价/单位必须为有限正数且单位已确认，缺项维持null", () => {
    for (const [field, invalid] of [
      ["goldPrice", null],
      ["goldPrice", 0],
      ["goldPrice", NaN],
      ["goldUnit", 0],
      ["goldUnit", Infinity],
      ["baselineUnitConfirmed", false],
    ] as const) {
      const config = settings();
      Object.assign(config.servers[0], { [field]: invalid });
      const baseline = makeEquipmentBaseline(atLevel(80), "941", config);
      expect(baseline?.amount).toBeNull();
      expect(baseline?.note).toMatch(/金价|单位/);
    }
  });
  it("未指定本服、重复配置或无效人工价不能形成金额", () => {
    const config = settings();
    config.equipmentBaselinePrices = structuredClone(DEFAULT_EQUIPMENT_BASELINE_PRICES);
    config.equipmentBaselinePrices["80"].armor = -1;
    expect(makeEquipmentBaseline(atLevel(80), "941", config)?.amount).toBeNull();
    expect(makeEquipmentBaseline(atLevel(80), "942", settings())?.amount).toBeNull();
    const duplicated = settings();
    duplicated.servers.push({ ...duplicated.servers[0] });
    expect(makeEquipmentBaseline(atLevel(80), "941", duplicated)?.amount).toBeNull();
  });
  it("深等重算全部金额/来源/版本字段；改属性、服务器或当前设置后旧baseline失效", () => {
    const value = atLevel(70);
    const config = settings();
    const baseline = makeEquipmentBaseline(value, "941", config)!;
    expect(
      validateEquipmentBaseline(
        { ...value, baselineEstimate: structuredClone(baseline) },
        "941",
        config,
      ),
    ).toBe(true);
    const mutations = [
      { ...baseline, amount: baseline.amount! + 1 },
      { ...baseline, gameCurrency: 1 },
      { ...baseline, policyVersion: "old" },
      { ...baseline, source: { ...baseline.source, url: "https://example.com" } },
      { ...baseline, note: "当前实时行情" },
      { ...baseline, unknown: true },
    ];
    for (const changed of mutations)
      expect(
        validateEquipmentBaseline({ ...value, baselineEstimate: changed }, "941", config),
      ).toBe(false);
    const attached = { ...value, baselineEstimate: baseline };
    expect(validateEquipmentBaseline(attached, "942", config)).toBe(false);
    expect(
      validateEquipmentBaseline(
        { ...attached, description: attached.description + "\n特效：愤怒" },
        "941",
        config,
      ),
    ).toBe(false);
    config.servers[0].goldPrice = 200;
    expect(validateEquipmentBaseline(attached, "941", config)).toBe(false);
    expect(validateEquipmentBaseline(value, "941", settings())).toBe(false);
  });
});
