import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import { parseRoleTrainingMinimum, RoleTrainingFilter } from "./RoleTrainingFilter";

it.each([
  ["", null],
  ["  ", null],
  ["0", 0],
  [" 012 ", 12],
  [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
])("四修下限 %s 保留空值/零和安全整数语义", (draft, expected) => {
  expect(parseRoleTrainingMinimum(String(draft))).toBe(expected);
});

it.each(["-1", "-0", "1.5", "1e2", "+2", "0x10", "NaN", "Infinity", "9007199254740992", "1 2"])(
  "非法四修下限%s不能转换成可保存设置",
  (draft) => expect(() => parseRoleTrainingMinimum(draft)).toThrow("非负整数"),
);

it("独立筛选说明当前四修、包含等于及未知保留，读取完成前不允许默认值覆盖", () => {
  const markup = renderToStaticMarkup(<RoleTrainingFilter />);
  expect(markup).toContain('aria-label="采集前置筛选"');
  expect(markup).toContain("人物四修总和 ≥");
  expect(markup).toContain("攻修、防修、法修、抗法");
  expect(markup).toContain("当前等级相加（如21/25取21）");
  expect(markup).toContain("等于下限也通过");
  expect(markup).toContain("缺项或无法确认时仍按原采集流程处理");
  expect(markup).toContain("当前采集运行保持原设置");
  expect(markup).toContain("正在读取采集前置筛选");
  expect(markup).toMatch(/<input[^>]*disabled=""/);
  expect(markup).toMatch(/<button[^>]*disabled=""/);
});
