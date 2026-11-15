import type { MarketCategory, SemanticTarget } from "./contracts";
import {
  equipmentSuitControl,
  type EquipmentSearchConfig,
} from "../analysis/browser-equipment-source";
import { petGrowthInput } from "../analysis/browser-pet-source";
import type { PetPricingItem } from "../analysis/pet-pricing";
import { petGearUIQuery } from "../analysis/browser-pet-gear-source";
import type { PetGearPricingItem } from "../analysis/pet-gear-inventory";

/** Plans official controls from the same argument mapping as the browser source. */
export async function nativeEquipmentActions(
  args: Record<string, string | number>,
  config: EquipmentSearchConfig,
  type: Exclude<MarketCategory, "pet" | "pet-gear">,
) {
  const actions: SemanticTarget[] = [];
  const fill = async (field: string, value: string | number) => {
    actions.push({ kind: "market-field", field, value: String(value) });
  };
  const select = fill;
  const click = async (_id: string) => {
    actions.push({
      kind: _id === "btn_reset_user_server" ? "market-reset-server" : "market-reset",
    });
  };
  const menu = async (panel: string, value: string | number) => {
    for (const part of String(value).split(","))
      actions.push({ kind: "market-choice", panel, values: [part] });
  };
  const slider = async (_id: string, minimum: number, maximum: number) => {
    actions.push({ kind: "market-level", category: type, minimum, maximum });
  };
  const control = async (field: string) => ({
    setChecked: async (value: boolean, _options?: unknown) => fill(field, String(value)),
    check: async (_options?: unknown) => fill(field, "true"),
  });
  const handled = new Set<string>();
  const use = (key: string) => {
    handled.add(key);
    return args[key];
  };
  await click("reset_all");
  await click("btn_reset_user_server");

  await fill("ovarall_sel_server", use("serverid"));
  if (type === "equipment") {
    await slider("level_slider", Number(use("level_min")), Number(use("level_max")));
    await menu("fair_show_panel", use("front_status"));
    for (const [key, id] of [
      ["kindid", "kind_check_panel"],
      ["special_effect", "special_effect_panel"],
      ["special_skill", "special_skill_panel"],
      ["gem_value", "gem_panel"],
    ] as const)
      if (args[key] !== undefined) await menu(id, use(key));
    for (const key of [
      "repair_fail",
      "damage",
      "all_wakan",
      "gem_level",
      "init_defense",
      "init_damage",
      "init_damage_raw",
      "all_damage",
      "init_wakan",
      "init_hp",
      "init_dex",
      "hole_num",
    ])
      if (args[key] !== undefined) await fill("txt_" + key, use(key));
    if (args.attr_without_melt !== undefined) {
      await (
        await control("chk_attr_with_melt")
      ).setChecked(!Number(use("attr_without_melt")), { timeout: 5000 });
    }
    if (args.special_mode !== undefined) {
      await menu("check_mode_panel", use("special_mode"));
    }
    if (args.suit_effect !== undefined) {
      const value = String(use("suit_effect"));
      const selected = equipmentSuitControl(value, config);
      await (await control("radio_" + selected.type)).check({ timeout: 5000 });
      if (selected.type === "short_cut") await select("sel_short_cut", value);
      else await fill("txt_" + selected.type, selected.name);
    }
  } else if (type === "jewelry") {
    await slider(
      "equip_level_slider",
      Number(use("equip_level_min")),
      Number(use("equip_level_max")),
    );
    await menu("fair_show_panel", use("pass_fair_show"));
    if (args.kindid !== undefined) await menu("kind_panel", use("kindid"));
    if (args.special_effect !== undefined) {
      if (Number(use("special_effect")) !== 1) throw new Error("官网灵饰特效控件只支持简易");
      await (await control("chk_has_eazy_effect")).setChecked(true, { timeout: 5000 });
    }
    await fill("txt_repair_fail", args.repair_fail === undefined ? "" : use("repair_fail"));
    for (const key of ["jinglian_level", "suit_effect_level"])
      if (args[key] !== undefined) await fill("txt_" + key, use(key));
    if (args.suit_effect !== undefined) await select("sel_suit_effect", use("suit_effect"));
    const primary = [
      "damage",
      "defense",
      "magic_damage",
      "magic_defense",
      "fengyin",
      "anti_fengyin",
      "speed",
    ].filter((key) => args[key] !== undefined);
    if (primary.length > 1) throw new Error("官网灵饰基础属性不能表达多个主属性");
    if (primary.length) {
      await select("sel_basic_attr_type", primary[0]);
      await fill("txt_basic_attr_value", use(primary[0]));
    }
    if (args.added_attr_num !== undefined)
      await menu("added_attr_num_panel", use("added_attr_num"));
    if (args.added_attr_logic !== undefined) {
      if (use("added_attr_logic") !== "detail")
        throw new Error("官网灵饰附加属性模式无法表达当前条件");
      await (await control("added_attr_logic_detail")).check({ timeout: 5000 });
      const attrs = Object.entries(args)
        .filter(([key]) => key.startsWith("added_attr."))
        .flatMap(([key, count]) => {
          handled.add(key);
          return Array.from({ length: Number(count) }, () => key.slice("added_attr.".length));
        });
      if (attrs.length > 3) throw new Error("官网灵饰附加属性超过三个槽位");
      for (const [index, value] of attrs.entries())
        await select("sel_add_attr" + (index + 1), value);
    }
  } else if (type === "yuanshen") {
    await menu("equip_type_check_panel", use("type_choice"));
    await select("attr_type", use("attr_type"));
    if (args.addon_choices !== undefined)
      await menu("equip_attr_check_panel", use("addon_choices"));
    for (const id of ["txt_attr_value", "txt_addon_skill_chance", "txt_addon_effect_chance"])
      if (args[id] !== undefined) await fill(id, use(id));
  } else {
    await menu("fair_show_panel", use("pass_fair_show"));
    await (await control("chk_include_ext_mh_lv")).setChecked(false, { timeout: 5000 });
    for (const [key, id] of [
      ["equip_type", "yupo_type_panel"],
      ["special_teji", "special_teji"],
      ["special_daoju", "special_daoju"],
    ] as const)
      if (args[key] !== undefined) await menu(id, use(key));
    for (const key of [
      "init_attrs",
      "base_attrs1",
      "base_attrs2",
      "total_attrs",
      "minghun_effect",
    ]) {
      if (args[key] === undefined) continue;
      const entries = Object.entries(
        JSON.parse(String(use(key))) as Record<string, string | number>,
      );
      if (entries.length !== 1) throw new Error("官网玉魄控件不能表达多个属性：" + key);
      await select("sel_" + key, entries[0][0]);
      await fill(
        "txt_" + key,
        key === "minghun_effect" ? Number(entries[0][1]) / 10 : entries[0][1],
      );
    }
    if (args.minghun_level_min !== undefined)
      await fill("txt_minghun_level_min", use("minghun_level_min"));
  }
  const unsupported = Object.keys(args).filter((key) => !handled.has(key));
  if (unsupported.length) throw new Error("原生官网控件尚不支持字段：" + unsupported.join(","));
  return actions;
}

export function nativePetActions(
  item: PetPricingItem,
  args: Record<string, string | number>,
): SemanticTarget[] {
  const actions: SemanticTarget[] = [
    { kind: "market-reset" },
    { kind: "market-reset-server" },
    { kind: "market-field", field: "ovarall_sel_server", value: String(args.serverid) },
    { kind: "market-field", field: "pet_select_box", value: item.name },
  ];
  const handled = new Set(["serverid", "type"]);
  for (const key of [
    "level_min",
    "level_max",
    "skill_num",
    "attack_aptitude",
    "defence_aptitude",
    "physical_aptitude",
    "magic_aptitude",
    "speed_aptitude_min",
    "speed_aptitude_max",
    "lingxing",
  ]) {
    if (args[key] !== undefined) {
      handled.add(key);
      actions.push({ kind: "market-field", field: "txt_" + key, value: String(args[key]) });
    }
  }
  if (args.growth !== undefined) {
    handled.add("growth");
    actions.push({ kind: "market-field", field: "txt_growth", value: petGrowthInput(args.growth) });
  }
  if (args.is_baobao !== undefined) handled.add("is_baobao");
  actions.push({
    kind: "market-field",
    field: "chk_is_baobao",
    value: String(args.is_baobao === 1),
  });
  for (const [key, panel] of [
    ["skill", "pet_skill_wrap"],
    ["high_neidan", "high_neidan_panel"],
    ["low_neidan", "low_neidan_panel"],
    ["texing", "texing_panel"],
    ["super_sum_star", "super_sum_star"],
  ]) {
    if (args[key] === undefined) continue;
    handled.add(key);
    if (key === "skill") actions.push({ kind: "market-expand", panel: "pet-skills" });
    for (const value of String(args[key]).split(","))
      actions.push({ kind: "market-choice", panel, values: [value] });
  }
  const missing = Object.keys(args).filter((key) => !handled.has(key));
  if (missing.length) throw new Error("原生宝宝控件尚不支持字段：" + missing.join(","));
  return actions;
}

export function nativePetGearPlan(item: PetGearPricingItem, serverId: string, similar: boolean) {
  const query = petGearUIQuery(item, similar);
  const args: Record<string, string | number> = {
    level_min: query.level,
    level_max: query.level,
    serverid: serverId,
    ...query.inputs,
  };
  const actions: SemanticTarget[] = [
    { kind: "market-reset" },
    { kind: "market-reset-server" },
    { kind: "market-field", field: "ovarall_sel_server", value: serverId },
    { kind: "market-level", category: "pet-gear", minimum: query.level, maximum: query.level },
  ];
  for (const [field, value] of Object.entries(query.inputs))
    actions.push({ kind: "market-field", field, value });
  for (const addon of query.addons) {
    args[addon] = "1";
    actions.push({ kind: "market-choice", panel: "addon_skill_box", values: [addon] });
  }
  return { args, actions, query };
}

export function nativePetGearActions(args: Record<string, string | number>): SemanticTarget[] {
  const actions: SemanticTarget[] = [{ kind: "market-reset" }, { kind: "market-reset-server" }];
  const direct = new Set([
    "speed",
    "fangyu",
    "mofa",
    "shanghai",
    "hp",
    "hit_ratio",
    "addon_minjie_reduce",
    "addon_sum_min",
    "xiang_qian_level",
    "addon_status",
    "repair_failed_times",
  ]);
  if (args.level_min === undefined || args.level_max === undefined)
    throw new Error("宝宝装备对照缺少已观察等级范围");
  actions.push({
    kind: "market-level",
    category: "pet-gear",
    minimum: Number(args.level_min),
    maximum: Number(args.level_max),
  });
  for (const [key, value] of Object.entries(args)) {
    if (["level_min", "level_max"].includes(key)) continue;
    if (key === "serverid")
      actions.push({ kind: "market-field", field: "ovarall_sel_server", value: String(value) });
    else if (direct.has(key))
      actions.push({ kind: "market-field", field: key, value: String(value) });
    else if (key === "equip_pos" || key === "xiangqian_stone_attr")
      actions.push({
        kind: "market-choice",
        panel: key === "equip_pos" ? "EquipPosBox" : "xiangqian_stone_attr_panel",
        values: [String(value)],
      });
    else if (
      /^addon_(?:fali|liliang|lingli|minjie|naili|tizhi)$/.test(key) &&
      String(value) === "1"
    )
      actions.push({ kind: "market-choice", panel: "addon_skill_box", values: [key] });
    else throw new Error("宝宝装备对照有未支持的官网控件：" + key);
  }
  return actions;
}
