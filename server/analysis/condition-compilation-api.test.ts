import { expect, it, vi } from "vite-plus/test";
import { defaultConditions } from "./conditions";
import { RULE_ENGINE_VERSION, type CompiledConditionRule } from "./condition-rule-types";

const mocks = vi.hoisted(() => ({
  compile: vi.fn(),
  database: vi.fn(() => {
    throw new Error("编译不可访问商品数据库");
  }),
}));
vi.mock("./condition-compiler", () => ({ compileConditionTexts: mocks.compile }));
vi.mock("../crawler/controller", () => ({
  crawlDatabase: mocks.database,
  crawlStatus: () => null,
}));
import { compileAnalysisConditions } from "./controller";

it("编译只接收文字条件，不读写商品、保存配置或改变价格条件", async () => {
  const tree = defaultConditions();
  tree.children.push({ id: "C2", text: "装备和宝宝合计超过8", join: "and" });
  const rule: CompiledConditionRule = {
    version: RULE_ENGINE_VERSION,
    sourceText: "装备和宝宝合计超过8",
    status: "ready",
    expression: {
      op: "gt",
      args: [
        { op: "count", collections: ["equipment", "jewelry", "petEquipment", "pets"] },
        { op: "literal", value: 8 },
      ],
    },
    explanation: "将由程序生成",
    issues: [],
  };
  mocks.compile.mockResolvedValueOnce([{ id: "C2", rule }]);
  const result = await compileAnalysisConditions(
    { conditions: tree, provider: "codex", model: "fixture" },
    new AbortController().signal,
  );
  expect(mocks.compile).toHaveBeenLastCalledWith(
    [{ id: "C2", text: "装备和宝宝合计超过8" }],
    expect.objectContaining({ provider: "codex", model: "fixture" }),
  );
  expect(result.conditions?.children[0]).toEqual(tree.children[0]);
  expect(result.conditions?.children[1]).toMatchObject({
    id: "C2",
    text: "装备和宝宝合计超过8",
    join: "and",
    rule: { status: "ready" },
  });
  expect(mocks.database).not.toHaveBeenCalled();
});

it("已取消的请求不会返回可保存的旧规则", async () => {
  const tree = defaultConditions();
  tree.children.push({ id: "C2", text: "判断不了", join: "and" });
  const controller = new AbortController();
  mocks.compile.mockImplementationOnce(async () => {
    controller.abort(new Error("用户已改文字"));
    return [];
  });
  await expect(compileAnalysisConditions({ conditions: tree }, controller.signal)).rejects.toThrow(
    "用户已改文字",
  );
  expect(mocks.database).not.toHaveBeenCalled();
});

it("没有文字条件不调用模型，无效服务和条件在模型调用前被拒绝", async () => {
  const before = mocks.compile.mock.calls.length;
  await expect(
    compileAnalysisConditions({ conditions: defaultConditions() }, new AbortController().signal),
  ).resolves.toEqual({ conditions: defaultConditions() });
  await expect(
    compileAnalysisConditions(
      { conditions: defaultConditions(), provider: "invalid" },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  await expect(
    compileAnalysisConditions({ conditions: null }, new AbortController().signal),
  ).rejects.toThrow();
  expect(mocks.compile).toHaveBeenCalledTimes(before);
});
