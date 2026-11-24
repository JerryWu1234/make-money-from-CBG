import { expect, it } from "vite-plus/test";
import { itemFromAttributes } from "./compact";
import { itemNeedsTooltip } from "./item-read-policy";
import type { TabSnapshot } from "./types";
const tab = {
  name: "道具/法宝",
  text: "道具和法宝",
  fields: [],
  tables: [],
  elements: [],
  tooltips: [],
  items: [],
} as TabSnapshot;
it.each([
  ["等级：100#r伤害：420", true],
  ["等级：100", true],
  ["伤害：420", true],
  ["", true],
])(
  "does not infer full tooltip coverage from existing equipment stats: %s",
  (description, wanted) => {
    const attrs = {
      data_equip_name: "完整武器",
      data_equip_category: "武器",
      data_equip_desc: description,
    };
    expect(itemNeedsTooltip(itemFromAttributes(attrs, 0), attrs, tab)).toBe(wanted);
  },
);
it("keeps pet equipment stats separate from the role inventory and preserves skill evidence", () => {
  const pet = { data_equip_name: "宝宝项圈", data_equip_desc: "等级：80" };
  expect(
    itemNeedsTooltip(itemFromAttributes(pet, 0), pet, { ...tab, name: "召唤兽 1" }, true),
  ).toBe(true);
  const complete = { ...pet, data_equip_desc: "等级：80#r速度：20" };
  expect(
    itemNeedsTooltip(itemFromAttributes(complete, 0), complete, { ...tab, name: "召唤兽 1" }, true),
  ).toBe(true);
  const skill = { data_equip_name: "高级必杀", data_skill_type: "cifu" };
  expect(itemNeedsTooltip(itemFromAttributes(skill, 0), skill, tab, true)).toBe(false);
});
