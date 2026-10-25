import type { DetailItem, TabSnapshot } from "./types";

/** Fill an icon omission only when the saved school-skill text proves all seven pairs. */
export function completeSchoolSkillsFromText(tab: TabSnapshot): TabSnapshot {
  if (tab.name !== "技能" || !tab.items) return tab;
  const existing = tab.items.filter((item) => item.category === "师门技能");
  if (!existing.length || existing.length >= 7) return tab;
  const lines = tab.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const starts = lines.flatMap((line, index) => (line === "师门技能" ? [index] : []));
  const ends = lines.flatMap((line, index) => (line === "生活技能" ? [index] : []));
  if (starts.length !== 1 || ends.length !== 1 || ends[0] <= starts[0]) return tab;
  const content = lines.slice(starts[0] + 1, ends[0]);
  if (content.length !== 14) return tab;
  const levels = new Map<string, string>();
  for (let index = 0; index < content.length; index += 2) {
    const level = content[index],
      name = content[index + 1];
    if (!/^\d{1,3}$/.test(level) || !/^\p{Script=Han}{2,12}$/u.test(name) || levels.has(name))
      return tab;
    levels.set(name, level);
  }
  const observed = new Set<string>();
  for (const item of existing) {
    if (item.kind !== "skill" || observed.has(item.name) || levels.get(item.name) !== item.level)
      return tab;
    observed.add(item.name);
  }
  // Keep existing items and indices intact; no official ID is inferred from a name or level.
  let index = Math.max(-1, ...tab.items.map((item) => item.index)) + 1;
  const missing: DetailItem[] = [...levels].flatMap(([name, level]) =>
    observed.has(name)
      ? []
      : [{ index: index++, name, level, kind: "skill", category: "师门技能" }],
  );
  return { ...tab, items: [...tab.items, ...missing] };
}
