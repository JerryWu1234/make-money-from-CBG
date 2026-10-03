import { describe, expect, it } from "vite-plus/test";
import type { PetSnapshot } from "./types";
import { petCaptureSummary } from "./pets";

const pet = (): PetSnapshot => ({
  index: 1,
  name: "幽灵",
  fields: [
    { name: "类型", value: "幽灵" },
    { name: "等级", value: "0" },
    { name: "成长", value: "1.23" },
    ...["攻击资质", "防御资质", "体力资质", "法力资质", "速度资质", "躲闪资质"].map((name) => ({
      name,
      value: "1400",
    })),
  ],
  skills: [{ index: 0, name: "鬼魂术", kind: "skill" }],
  equipment: [{ index: 1, name: "宝宝项圈", kind: "equipment", description: "等级 80\n速度 +20" }],
  innerSkills: [{ index: 2, name: "玄武躯", kind: "innerSkill", level: "5" }],
});

describe("宝宝采集完整性凭据", () => {
  it("明确数量0才允许空宝宝列表，未知数量不能变成0", () => {
    expect(petCaptureSummary(0, [], "now").complete).toBe(true);
    expect(petCaptureSummary(null, [], "now")).toMatchObject({
      complete: false,
      issues: ["召唤兽总数未确认，不能按没有宝宝处理"],
    });
  });
  it("数量不符或读取阶段有异常时不能标完整", () => {
    expect(petCaptureSummary(2, [pet()], "now").issues).toContain(
      "召唤兽数量不一致：确认 2 只，读取 1 只",
    );
    expect(petCaptureSummary(1, [pet()], "now", ["技能图标未读取"])).toMatchObject({
      complete: false,
      issues: ["技能图标未读取"],
    });
  });
  it("等级0有效，但只读名称或缺一项资质不是完整宝宝", () => {
    expect(petCaptureSummary(1, [pet()], "now").complete).toBe(true);
    const missing = pet();
    missing.fields = missing.fields.filter((field) => field.name !== "法力资质");
    expect(petCaptureSummary(1, [missing], "now").issues).toContain(
      "第 1 只召唤兽法力资质未完整读取",
    );
    missing.fields = [{ name: "名称", value: "昵称" }];
    expect(petCaptureSummary(1, [missing], "now").complete).toBe(false);
  });
  it("坏数值、未命名技能和缺失内丹层数都有具体问题", () => {
    const missing = pet();
    missing.fields.find((field) => field.name === "成长")!.value = "0";
    missing.skills[0].name = "图标 1";
    missing.innerSkills[0].level = undefined;
    expect(petCaptureSummary(1, [missing], "now").issues).toEqual(
      expect.arrayContaining([
        "第 1 只召唤兽成长未完整读取",
        "第 1 只召唤兽技能或内丹名称未完整读取",
        "第 1 只召唤兽玄武躯的内丹层数未完整读取",
      ]),
    );
  });
  it("同名字段重复不能只取第一条后标完整", () => {
    const duplicate = pet();
    duplicate.fields.push({ name: "等级", value: "120" });
    expect(petCaptureSummary(1, [duplicate], "now").issues).toContain(
      "第 1 只召唤兽属性重复，需要核对",
    );
  });
  it("宝宝装备只读到名称不能标完整，等级和属性可来自结构字段", () => {
    const missing = pet();
    missing.equipment[0].description = undefined;
    expect(petCaptureSummary(1, [missing], "now").issues).toContain(
      "第 1 只召唤兽宝宝项圈的装备属性未完整读取",
    );
    missing.equipment[0].attributes = { 等级: "80", 速度: "+20" };
    expect(petCaptureSummary(1, [missing], "now").complete).toBe(true);
    missing.equipment[0].attributes = undefined;
    missing.equipment[0].description = "等级 105\n命中率 +11%\n镶嵌效果\n+12灵力";
    expect(petCaptureSummary(1, [missing], "now").complete).toBe(true);
  });
});
