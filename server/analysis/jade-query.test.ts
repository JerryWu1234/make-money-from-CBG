import { describe, expect, it } from "vite-plus/test";
import { jadeQuery, type JadeSearchConfig } from "./jade-query";
import type { EquipmentPricingItem } from "./equipment-pricing";

// Public CBG_GAME_CONFIG.minghun_* labels and IDs; no sample prices are inferred here.
const config: JadeSearchConfig = {
  minghun_attr: {
    "101": "气血",
    "102": "防御",
    "103": "法防",
    "106": "抗封印",
    "108": "气血回复",
    "203": "法术伤害",
    "204": "狂暴",
    "205": "物理暴击",
    "206": "法术暴击",
    "207": "封印命中",
    "209": "穿刺",
    "211": "固伤暴击",
  },
  minghun_effect: { "1": "奇袭法术" },
  minghun_teji: { "61750": "野兽之力" },
  minghun_daoju: { "61741": "金香玉", "61745": "十香返生丸" },
};
const item = (changes: Partial<EquipmentPricingItem> = {}): EquipmentPricingItem => ({
  key: "道具/法宝:0",
  name: "上古玉魄·阳",
  category: "上古玉魄",
  level: null,
  modelId: "61718",
  description: "物理暴击等级 +13\n耐久度 294\n穿刺等级 +6\n穿刺等级 +6\n奇袭特技: [空]",
  query: "",
  status: "no_match",
  referencePrice: null,
  candidates: [],
  issues: [],
  ...changes,
});

describe("官方上古玉魄查询", () => {
  it("按真实玉魄入口构造阴阳类型，保留重复附加属性的两个槽位", () => {
    expect(jadeQuery(item(), config)).toEqual({
      act: "yupo_search",
      args: {
        equip_type: "61718",
        pass_fair_show: "1",
        init_attrs: '{"205":"13"}',
        base_attrs1: '{"209":"6"}',
        base_attrs2: '{"209":"6"}',
      },
    });
  });

  it("分开读取基础附加值与灵尘加成，按官方倍率查询效形与道具", () => {
    const result = jadeQuery(
      item({
        name: "上古玉魄·阴",
        modelId: "61717",
        description:
          "防御 +25\n奇袭法术 +0.5%\n耐久度 102\n灵尘等级 4\n抵抗封印等级 +13 [+48]\n气血 +67 [+168]\n奇袭道具: 金香玉\n奇袭道具: [空]",
      }),
      config,
    );
    expect(result.args).toEqual({
      equip_type: "61717",
      pass_fair_show: "1",
      init_attrs: '{"102":"25"}',
      base_attrs1: '{"106":"13"}',
      base_attrs2: '{"101":"67"}',
      minghun_level_min: "4",
      minghun_effect: '{"1":5}',
      special_daoju: "61741",
    });
  });

  it("不会加入普通装备等级、宝石、区服、价格或根据空槽捏造条件", () => {
    const result = jadeQuery(
      item({
        modelId: undefined,
        description:
          "狂暴等级 +9\n奇袭法术 +0.5%\n耐久度 22\n灵尘等级 4\n固伤暴击等级 +8 [+24]\n固伤暴击等级 +7 [+24]\n奇袭特技: [空]\n奇袭特技: [空]",
      }),
      config,
    );
    expect(result.args.base_attrs1).toBe('{"211":"8"}');
    expect(result.args.base_attrs2).toBe('{"211":"7"}');
    for (const key of [
      "level_min",
      "level_max",
      "kindid",
      "gem_value",
      "serverid",
      "server_type",
      "cross_buy_serverid",
      "price_min",
      "price_max",
      "special_teji",
    ])
      expect(result.args).not.toHaveProperty(key);
  });

  it("不会把未知的第一行或未知选项误当已识别初始属性", () => {
    const result = jadeQuery(
      item({ description: "未知新属性 +9\n穿刺等级 +6\n穿刺等级 +6\n奇袭特技: 未知新特技" }),
      config,
    );
    expect(result.args).not.toHaveProperty("init_attrs");
    expect(result.args).not.toHaveProperty("special_teji");
    expect(result.args.base_attrs1).toBe('{"209":"6"}');
    expect(result.args.base_attrs2).toBe('{"209":"6"}');
  });

  it("属性ID歧义时不猜编号，并遵循阴阳专属配置", () => {
    const result = jadeQuery(item(), {
      ...config,
      minghun_attr_yang: { "205": "物理暴击", "999": "物理暴击", "209": "穿刺" },
    });
    expect(result.args).not.toHaveProperty("init_attrs");
    expect(result.args.base_attrs1).toBe('{"209":"6"}');
  });

  it("拒绝不匹配的玉魄型号与普通装备", () => {
    expect(() => jadeQuery(item({ modelId: "61717" }), config)).toThrow("阴阳类型");
    expect(() => jadeQuery(item({ modelId: "12345" }), config)).toThrow("阴阳类型");
    expect(() => jadeQuery(item({ category: "人物装备" }), config)).toThrow("普通装备");
    expect(() => jadeQuery(item({ description: "" }), config)).toThrow("属性尚未采齐");
  });
});
