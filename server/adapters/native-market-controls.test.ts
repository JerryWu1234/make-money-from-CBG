import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vite-plus/test";
import {
  nativeEquipmentActions,
  nativePetActions,
  nativePetGearActions,
} from "./native-market-actions";
import type { SemanticTarget } from "./contracts";
import type { PetPricingItem } from "../analysis/pet-pricing";

it("every planned official market control is accepted by the actual ISOLATED semantic allowlist", async () => {
  const world: Record<string, any> = {};
  runInNewContext(
    readFileSync(new URL("../../extension/cbg-access/market-rules.js", import.meta.url), "utf8"),
    world,
  );
  const rules = world.__CBGMarketRules;
  const config = {
    kinds: [],
    effects: [],
    skills: [],
    gems: [],
    suitTypes: { added_status: [[1, "巨力金刚"] as [number, string]] },
  };
  const actions: SemanticTarget[] = [
    ...nativePetActions({ name: "画魂" } as PetPricingItem, {
      serverid: "1",
      type: "2001",
      level_min: 95,
      level_max: 95,
      growth: 1280,
      is_baobao: 1,
      skill: "1",
      high_neidan: "9",
      low_neidan: "10",
      texing: "1",
      super_sum_star: 0,
      skill_num: 3,
      attack_aptitude: 1500,
      defence_aptitude: 1400,
      physical_aptitude: 5000,
      magic_aptitude: 2000,
      speed_aptitude_min: 1000,
      speed_aptitude_max: 1400,
      lingxing: 50,
    }),
    ...(await nativeEquipmentActions(
      {
        serverid: "1",
        level_min: 100,
        level_max: 100,
        front_status: "pass_fair_show",
        kindid: "20",
        special_effect: "3",
        special_skill: "1",
        gem_value: "6",
        attr_without_melt: 1,
        special_mode: "and",
        suit_effect: "1",
        repair_fail: 0,
        damage: 0,
        all_wakan: 1,
        gem_level: 8,
        init_defense: 0,
        init_damage: 0,
        init_damage_raw: 0,
        all_damage: 0,
        init_wakan: 0,
        init_hp: 0,
        init_dex: 0,
        hole_num: 3,
      },
      config,
      "equipment",
    )),
    ...(await nativeEquipmentActions(
      {
        serverid: "1",
        equip_level_min: 100,
        equip_level_max: 100,
        pass_fair_show: "1",
        kindid: "21",
        special_effect: 1,
        repair_fail: 0,
        jinglian_level: 8,
        suit_effect_level: 2,
        suit_effect: "1",
        damage: 0,
        added_attr_num: 3,
        added_attr_logic: "detail",
        "added_attr.1": 1,
      },
      config,
      "jewelry",
    )),
    ...(await nativeEquipmentActions(
      {
        serverid: "1",
        type_choice: "93",
        attr_type: "shanghai",
        addon_choices: "51",
        txt_attr_value: 500,
        txt_addon_skill_chance: 12,
        txt_addon_effect_chance: 10,
      },
      config,
      "yuanshen",
    )),
    ...(await nativeEquipmentActions(
      {
        serverid: "1",
        pass_fair_show: "1",
        equip_type: "61717",
        special_teji: "1",
        special_daoju: "2",
        init_attrs: '{"1":10}',
        base_attrs1: '{"1":10}',
        base_attrs2: '{"1":10}',
        total_attrs: '{"1":10}',
        minghun_effect: '{"1":10}',
        minghun_level_min: 1,
      },
      config,
      "jade",
    )),
    ...nativePetGearActions({
      serverid: "1",
      level_min: 95,
      level_max: 95,
      speed: 20,
      fangyu: 20,
      mofa: 20,
      shanghai: 20,
      hp: 20,
      hit_ratio: 20,
      addon_minjie_reduce: 20,
      addon_sum_min: 20,
      xiang_qian_level: 2,
      addon_status: "巨力金刚",
      repair_failed_times: 0,
      equip_pos: "1",
      xiangqian_stone_attr: "1",
      addon_minjie: "1",
    }),
  ];
  const unsupported = actions.filter((action) =>
    action.kind === "market-field"
      ? !rules.fieldIds.has(action.field)
      : action.kind === "market-choice"
        ? !rules.panels.has(action.panel)
        : false,
  );
  expect(unsupported).toEqual([]);
});
