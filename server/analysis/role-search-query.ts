import type { SavedRoleRecord } from "../crawler/types";
import type { RoleSearchForm, RoleSearchSelections } from "./browser-role-source";
import { roleCore } from "./role-market";

export const ROLE_SEARCH_QUERY_POLICY = "observed-role-core-window-v1";
export type RoleQueryPlan = RoleSearchSelections & {
  policy: typeof ROLE_SEARCH_QUERY_POLICY;
  omitted: { field: string; reason: string }[];
};
const normalized = (value: string) => value.replace(/\s|[：:]/g, "");
const numeric = (value: number | null): value is number =>
  value !== null && Number.isSafeInteger(value) && value >= 0 && value <= 10000;

/** Public numeric inputs are lower bounds; fresh detail matching enforces the upper window. */
export function buildRoleSearchQuery(record: SavedRoleRecord, form: RoleSearchForm): RoleQueryPlan {
  const core = roleCore(record);
  if (!numeric(core.level) || core.level === 0)
    throw new Error("角色等级缺失或无效，不能生成整号查询");
  if (!core.school?.trim()) throw new Error("角色门派缺失，不能生成整号查询");
  const plan: RoleQueryPlan = {
    controls: [],
    menus: [],
    policy: ROLE_SEARCH_QUERY_POLICY,
    omitted: [],
  };
  const observedControl = (id: string) => {
    const controls = form.controls.filter(
      (control) => control.id === id && ["text", "number"].includes(control.type),
    );
    return controls.length === 1 ? controls[0] : undefined;
  };
  for (const id of ["level_min", "level_max"]) {
    if (!observedControl(id)) throw new Error("官网角色等级控件未唯一确认：" + id);
    plan.controls.push({ id, value: String(core.level) });
  }
  const schoolMenus = form.menus.filter((menu) => normalized(menu.label) === "门派");
  const schoolControls = form.controls.filter(
    (control) => control.type === "select" && normalized(control.label) === "门派",
  );
  const matches = [
    ...schoolMenus.flatMap((menu) =>
      menu.choices
        .filter((choice) => normalized(choice.label) === normalized(core.school!))
        .map((choice) => ({ kind: "menus" as const, id: menu.id, value: choice.value })),
    ),
    ...schoolControls.flatMap((control) =>
      (control.options || [])
        .filter((choice) => normalized(choice.label) === normalized(core.school!))
        .map((choice) => ({ kind: "controls" as const, id: control.id, value: choice.value })),
    ),
  ];
  if (matches.length !== 1 || !matches[0].value)
    throw new Error("官网门派名称无法唯一映射：" + core.school);
  plan[matches[0].kind].push({ id: matches[0].id, value: matches[0].value });
  const lowerBound = (field: string, id: string, value: number | null, tolerance: number) => {
    if (!numeric(value)) {
      plan.omitted.push({ field, reason: "角色没有完整有效数值，未生成筛选" });
      return;
    }
    if (!observedControl(id)) {
      plan.omitted.push({ field, reason: "官网公开控件未唯一发现：" + id });
      return;
    }
    plan.controls.push({ id, value: String(Math.max(0, value - tolerance)) });
  };
  for (const [field, id] of [
    ["攻击修炼", "expt_gongji"],
    ["防御修炼", "expt_fangyu"],
    ["法术修炼", "expt_fashu"],
    ["抗法修炼", "expt_kangfa"],
    ["攻击控制力", "bb_expt_gongji"],
    ["防御控制力", "bb_expt_fangyu"],
    ["法术控制力", "bb_expt_fashu"],
    ["抗法控制力", "bb_expt_kangfa"],
  ])
    lowerBound(field, id, core.training[field], 3);
  for (const [field, id, tolerance] of [
    ["强壮", "skill_qiang_zhuang", 10],
    ["神速", "skill_shensu", 10],
    ["强身术", "skill_qiang_shen", 20],
  ] as const)
    lowerBound(field, id, core.skills[field], tolerance);
  // The observed form's visible state select alone does not expose all fly/ascension toggles.
  // Do not manufacture their IDs/values; compareRoleConfiguration checks the fresh state exactly.
  plan.omitted.push({
    field: "飞升/渡劫/化圣",
    reason: "当前公开表单未确认完整状态控件，使用候选详情严格核验",
  });
  return plan;
}
