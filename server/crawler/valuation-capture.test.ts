import { describe, expect, it } from "vite-plus/test";
import { normalizeValuationSource } from "./valuation-capture";

const empty = () => ({
  riders: {},
  advancedMount: { isJinJie: 0 },
  hasArtifact: false,
  goldIdFlag: false,
});
const value = (source: Record<string, unknown>, name: string) =>
  normalizeValuationSource(source).fields.find((field) => field.name === name)?.value;
const component = (filled: number) => ({
  unlock: 1,
  wuxing: Array.from({ length: 4 }, (_, index) => ({
    status: 1,
    id: 8,
    wuxingshi_level: index < filled ? 1 : 0,
  })),
});
const suit = () => ({
  components: Array.from({ length: 3 }, () => component(4)),
  attributes: [
    { disable: 0, attr: "封印命中 +12" },
    { disable: 0, attr: "抵抗封印 +6" },
    { disable: 0, attr: "速度 +10" },
    { disable: 0, attr: "气血 +100" },
    { disable: 1, attr: "固定伤害 +999" },
  ],
});
describe("真实角色结构的估值资料", () => {
  it("完整已学技能清单没有强壮神速时明确为0，未知清单不能归零；化圣层数直接取角色数据", () => {
    const source = { ...empty(), allSkills: { 201: 140 }, holyLevel: 9 };
    expect(value(source, "强壮")).toBe("0");
    expect(value(source, "神速")).toBe("0");
    expect(value(source, "化圣层数")).toBe("9");
    expect(value(empty(), "强壮")).toBeUndefined();
    expect(value({ ...source, allSkills: { 230: 42, 237: 40 } }, "强壮")).toBe("42");
  });
  it("77787777的两个进阶方案只计一只坐骑，取主属性而非任意最高比例", () => {
    const source = {
      ...empty(),
      advancedMount: {
        isJinJie: 1,
        iGrow: 100,
        iExGrow: 13500,
        aAttrSchemes: [
          { cMainAttr: "iRd_Spe", mpRatio: { iRd_Spe: 63, iRd_Cor: 90 } },
          { cMainAttr: "iRd_Cor", mpRatio: { iRd_Cor: 60 } },
        ],
      },
    };
    expect(value(source, "坐骑总数")).toBe("1");
    expect(value(source, "坐骑1成长")).toBe("2.3500");
    expect(value(source, "坐骑1主属性百分比")).toBe("63");
    expect(value(source, "坐骑1方案1主属性")).toBe("敏捷");
    expect(normalizeValuationSource(source).issues).toEqual([]);
  });
  it("14185300的两只未进阶坐骑分别保存成长", () => {
    const source = {
      ...empty(),
      riders: { 1: { exgrow: 22538, mattrib: "耐力" }, 2: { exgrow: 12483, mattrib: "" } },
    };
    expect(value(source, "坐骑总数")).toBe("2");
    expect(value(source, "坐骑1成长")).toBe("2.2538");
    expect(value(source, "坐骑2成长")).toBe("1.2483");
    expect(value(source, "坐骑2进阶状态")).toBe("未进阶");
  });
  it("12槽结构中只有4颗灵犀玉时明确为未满槽，不能按图标计价", () => {
    const source = {
      ...empty(),
      hasArtifact: true,
      artifact: { id: 6205, suit: [{ components: [component(4), component(0), component(0)] }] },
    };
    expect(value(source, "神器套数")).toBe("1");
    expect(value(source, "神器1已填槽数")).toBe("4");
    expect(value(source, "神器1满槽")).toBe("否");
    expect(normalizeValuationSource(source).issues).toEqual([]);
  });
  it("神器按有效属性加权，保留多套，不计候选或禁用属性", () => {
    const source = {
      ...empty(),
      hasArtifact: true,
      artifact: { id: 6205, suit: [suit(), suit()] },
    };
    expect(value(source, "神器套数")).toBe("2");
    expect(value(source, "神器1类型")).toBe("十二水");
    expect(value(source, "神器1总分")).toBe("38");
    expect(normalizeValuationSource(source).issues).toEqual([]);
  });
  it("槽位状态缺失不能视为未满槽或不存在", () => {
    const set = suit();
    delete (set.components[0].wuxing[0] as { wuxingshi_level?: number }).wuxingshi_level;
    const source = { ...empty(), hasArtifact: true, artifact: { id: 6205, suit: [set] } };
    expect(value(source, "神器1满槽")).toBeUndefined();
    expect(normalizeValuationSource(source).issues).toContain("神器1槽位状态或五行未完整读取");
    expect(normalizeValuationSource({ ...empty(), hasArtifact: undefined }).issues).toContain(
      "神器是否存在未完整读取",
    );
  });
  it("普通靓号不等于土豪金，财产直接保存网页数量", () => {
    const source = {
      ...empty(),
      goldIdFlag: true,
      idEffects: [1, 4],
      assets: { iCash: 40147, iSaving: 0, iLearnCash: 10272019, xianyu: 20 },
    };
    expect(value(source, "靓号特效")).toBe("无土豪金");
    expect(value({ ...source, idEffects: [5] }, "靓号特效")).toBe("土豪金");
    expect(value(source, "储备金")).toBe("10272019");
  });
});
