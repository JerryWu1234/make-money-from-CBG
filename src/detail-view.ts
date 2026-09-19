import type { TabSnapshot } from "../server/crawler/types";

const headerFields = new Set([
  "服务器",
  "编号",
  "状态",
  "类型",
  "价格",
  "是否接受还价",
  "出售剩余时间",
]);
export function detailFields(tab: TabSnapshot) {
  const parsed = tab.text.split("\n").flatMap((line) => {
    const segments = line
      .split("\t")
      .map((value) => value.trim())
      .filter(Boolean);
    return segments.flatMap((segment, index) => {
      const match = segment.match(/^([^：:]{1,24})[：:]\s*(.*)$/);
      if (!match) return [];
      const value =
        match[2] ||
        (segments[index + 1] && !/[：:]/.test(segments[index + 1]) ? segments[index + 1] : "");
      return value ? [{ name: match[1].trim(), value }] : [];
    });
  });
  const fields = new Map<string, { name: string; value: string }>();
  for (const field of [...parsed, ...tab.fields.filter((field) => !headerFields.has(field.name))]) {
    if (field.name && field.value) {
      const key = `${field.name}:${field.value}`;
      if (!fields.has(key)) fields.set(key, field);
    }
  }
  return [...fields.values()];
}
