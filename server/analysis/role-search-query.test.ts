import { describe, expect, it } from "vite-plus/test";
import { valuationRecord } from "../../tests/fixtures/analysis";
import type { RoleSearchForm } from "./browser-role-source";
import { buildRoleSearchQuery, ROLE_SEARCH_QUERY_POLICY } from "./role-search-query";

const numericIds = [
  "level_min",
  "level_max",
  "expt_gongji",
  "expt_fangyu",
  "expt_fashu",
  "expt_kangfa",
  "bb_expt_gongji",
  "bb_expt_fangyu",
  "bb_expt_fashu",
  "bb_expt_kangfa",
  "skill_qiang_zhuang",
  "skill_shensu",
  "skill_qiang_shen",
];
function observedForm(school = "神木林", value = "current-config-value"): RoleSearchForm {
  return {
    url: "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=show_search_role_form",
    action: "https://xyq.cbg.163.com/cgi-bin/equipquery.py",
    method: "post",
    act: "overall_search_role",
    controls: numericIds.map((id) => ({
      id,
      name: "",
      type: "text",
      label: "已观察字段",
      value: "",
    })),
    menus: [
      {
        id: "school_change_list",
        label: "历史门派：",
        choices: [{ value: "history-only", label: school, selected: false }],
      },
      {
        id: "observed-school",
        label: "门 派：",
        choices: [
          { value: "", label: "不限", selected: false },
          { value: "different-school-id", label: "其他门派", selected: false },
          { value, label: school, selected: false },
        ],
      },
    ],
  };
}
function target(level = 109, school = "神木林") {
  const record = valuationRecord("query-generator-fixture");
  const person = record.detail!.tabs.find((tab) => tab.name === "人物/修炼")!;
  person.fields.find((field) => field.name === "级别")!.value = String(level);
  person.fields.push({ name: "门派", value: school });
  return record;
}
const controls = (plan: ReturnType<typeof buildRoleSearchQuery>) =>
  Object.fromEntries(plan.controls.map((field) => [field.id, field.value]));

describe("从角色资料和公开表单生成整号搜索", () => {
  it.each([
    [70, "大唐官府", "new-datang-id"],
    [109, "神木林", "reordered-shenmu-id"],
    [175, "女儿村", "new-nver-id"],
  ])("%s级%s按当前门派名称匹配真实值 %s", (level, school, value) => {
    const form = observedForm(school, value);
    form.menus[1].choices.reverse();
    const plan = buildRoleSearchQuery(target(level, school), form);
    expect(plan.policy).toBe(ROLE_SEARCH_QUERY_POLICY);
    expect(controls(plan)).toMatchObject({ level_min: String(level), level_max: String(level) });
    expect(plan.menus).toEqual([{ id: "observed-school", value }]);
    expect(plan.menus).not.toContainEqual({ id: "school_change_list", value: "history-only" });
  });
  it("门派改为公开select后仍按标签映射，不绑定菜单ID和值", () => {
    const form = observedForm("五庄观");
    form.menus = [];
    form.controls.push({
      id: "new-school-select",
      name: "",
      type: "select",
      label: "门派：",
      value: "",
      options: [
        { value: "", label: "不限" },
        { value: "arbitrary-observed-id", label: "五庄观" },
      ],
    });
    const plan = buildRoleSearchQuery(target(129, "五庄观"), form);
    expect(plan.menus).toEqual([]);
    expect(controls(plan)["new-school-select"]).toBe("arbitrary-observed-id");
  });
  it("修炼和辅助技能使用已观察下限，候选详情保持相近范围核验", () => {
    const record = target();
    const skills = record.detail!.tabs.find((tab) => tab.name === "技能")!;
    skills.items!.find((item) => item.name === "强壮")!.level = "26";
    skills.items!.find((item) => item.name === "神速")!.level = "35";
    skills.items!.push({ index: 9, kind: "skill", name: "强身术", level: "120" });
    const plan = buildRoleSearchQuery(record, observedForm());
    expect(controls(plan)).toMatchObject({
      expt_gongji: "17",
      expt_fangyu: "14",
      expt_fashu: "0",
      expt_kangfa: "7",
      bb_expt_gongji: "17",
      bb_expt_fangyu: "17",
      bb_expt_fashu: "17",
      bb_expt_kangfa: "17",
      skill_qiang_zhuang: "16",
      skill_shensu: "25",
      skill_qiang_shen: "100",
    });
    expect(plan.controls.some((field) => field.id.startsWith("max_expt"))).toBe(false);
    expect(plan.omitted).toEqual([
      { field: "飞升/渡劫/化圣", reason: expect.stringContaining("详情严格核验") },
    ]);
  });
  it("缺失数值不变成0，已确认的0仍可表达；未知控件不猜ID", () => {
    const record = target();
    const person = record.detail!.tabs.find((tab) => tab.name === "人物/修炼")!;
    person.fields = person.fields.filter((field) => field.name !== "攻击修炼");
    const form = observedForm();
    form.controls = form.controls.filter((field) => field.id !== "expt_fangyu");
    const plan = buildRoleSearchQuery(record, form);
    expect(controls(plan)).not.toHaveProperty("expt_gongji");
    expect(controls(plan)).not.toHaveProperty("expt_fangyu");
    expect(controls(plan)).not.toHaveProperty("skill_qiang_shen");
    expect(controls(plan).expt_fashu).toBe("0");
    expect(controls(plan).skill_qiang_zhuang).toBe("0");
    expect(plan.omitted).toEqual(
      expect.arrayContaining([
        { field: "攻击修炼", reason: expect.stringContaining("角色没有完整有效数值") },
        { field: "防御修炼", reason: expect.stringContaining("官网公开控件未唯一发现") },
        { field: "强身术", reason: expect.stringContaining("角色没有完整有效数值") },
      ]),
    );
  });
  it.each(["", "unknown"])("缺失或未匹配门派%s明确报错", (school) => {
    expect(() => buildRoleSearchQuery(target(109, school), observedForm())).toThrow("门派");
  });
  it("重复的门派名称映射不得任选一个", () => {
    const form = observedForm();
    form.menus[1].choices.push({ value: "conflicting-value", label: "神木林", selected: false });
    expect(() => buildRoleSearchQuery(target(), form)).toThrow("无法唯一映射");
  });
  it("缺失或重复等级控件不生成不完整查询", () => {
    const form = observedForm();
    form.controls = form.controls.filter((field) => field.id !== "level_max");
    expect(() => buildRoleSearchQuery(target(), form)).toThrow("level_max");
    form.controls.push(form.controls[0]);
    expect(() => buildRoleSearchQuery(target(), form)).toThrow("level_min");
  });
  it.each(["", "0", "-1", "109.5", "未知", "10001"])("无有效角色等级%s时拒绝", (level) => {
    const record = target();
    record.detail!.tabs[0].fields.find((field) => field.name === "级别")!.value = level;
    expect(() => buildRoleSearchQuery(record, observedForm())).toThrow("等级缺失或无效");
  });
});
