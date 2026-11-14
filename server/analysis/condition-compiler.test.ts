import { describe, expect, it, vi } from "vite-plus/test";
import {
  CONDITION_COMPILER_SCHEMA,
  compileConditionTexts,
  conditionCompilerPrompt,
  validateConditionCompilation,
  type ConditionCompilerAnalyze,
} from "./condition-compiler";
import { RULE_ENGINE_VERSION, type RuleExpression } from "./condition-rule-types";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), analyze: vi.fn() }));
vi.mock("../ai-connection", () => ({ prepareAnalysisClient: mocks.prepare }));
const literal = (value: number | string | boolean): RuleExpression => ({ op: "literal", value });
const field = (path: string): RuleExpression => ({ op: "field", path });
const compare = (
  op: "gt" | "gte" | "lte" | "eq",
  left: RuleExpression,
  right: RuleExpression,
): RuleExpression => ({ op, args: [left, right] });
const count: RuleExpression = {
  op: "count",
  collections: ["equipment", "jewelry", "petEquipment", "pets"],
};
const quantity = (threshold = 8): RuleExpression => compare("gt", count, literal(threshold));
const input = [{ id: "C1", text: "装备和宝宝加起来的数量大于8件" }];
const reply = (expression: unknown = quantity(), id = "C1") => ({
  id,
  status: "ready",
  expression,
  issues: [],
});
const response = (conditions: unknown[]) => JSON.stringify({ conditions });
const options = { provider: "codex" as const, model: "fixture-model" };

// Compiling is interpretation, never a product-level verdict. Reject malformed provider output
// before it can be persisted, and bind every returned AST to the exact submitted source text.
describe("自然语言条件编译", () => {
  it("严格schema只允许规则数据，不允许met/unmet或执行源码", () => {
    expect(CONDITION_COMPILER_SCHEMA.additionalProperties).toBe(false);
    expect(CONDITION_COMPILER_SCHEMA.properties.conditions.items.additionalProperties).toBe(false);
    expect(CONDITION_COMPILER_SCHEMA.properties.conditions.items.required).toEqual([
      "id",
      "status",
      "expression",
      "issues",
    ]);
    expect(CONDITION_COMPILER_SCHEMA.$defs.expression.anyOf).toHaveLength(5);
    const prompt = conditionCompilerPrompt(input);
    expect(prompt).toContain("人物装备");
    expect(prompt).toContain("petEquipment");
    expect(prompt).toContain("0级和野生召唤兽默认也计数");
    expect(prompt).toContain("不要判断任何商品满足与否");
    expect(prompt).toContain("不要把估值范围当作条件证据范围");
    expect(prompt).toContain("严格保留用户比较方向和边界");
    expect(prompt).toContain(JSON.stringify(input));
  });

  it("一次编译相同文字，分别绑定原id；解释从AST生成", async () => {
    const analyze = vi.fn<ConditionCompilerAnalyze>(async (prompt, schema) => {
      expect(prompt).toContain('"id":"C1"');
      expect(prompt).not.toContain('"id":"C2"');
      expect(schema).toBe(CONDITION_COMPILER_SCHEMA);
      return response([
        reply({
          op: "gt",
          args: [
            {
              op: "count",
              collections: ["equipment", "jewelry", "petEquipment", "pets"],
              where: null,
            },
            literal(8),
          ],
        }),
      ]);
    });
    const result = await compileConditionTexts(
      [...input, { id: "C2", text: "  " + input[0].text + "  " }],
      options,
      analyze,
    );
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(result.map((entry) => entry.id)).toEqual(["C1", "C2"]);
    expect(result[0].rule).toMatchObject({
      version: RULE_ENGINE_VERSION,
      sourceText: input[0].text,
      status: "ready",
      expression: quantity(),
    });
    expect(result[0].rule.explanation).toContain("人物装备＋灵饰＋宝宝装备");
    expect(result[0].rule.explanation).toContain("> 8");
    expect(result[0].rule).not.toBe(result[1].rule);
    expect(result[0].rule.expression).not.toBe(result[1].rule.expression);
  });

  it("支持变化阈值、筛选、属性、百分比和组合，不按固定句子或数量实现", () => {
    const rules: { text: string; expression: RuleExpression }[] = [
      { text: "合计数量大于12", expression: quantity(12) },
      {
        text: "至少3件100级以上人物装备",
        expression: compare(
          "gte",
          {
            op: "count",
            collections: ["equipment"],
            where: compare("gte", field("item.level"), literal(100)),
          },
          literal(3),
        ),
      },
      { text: "速度不低于800", expression: compare("gte", field("role.speed"), literal(800)) },
      {
        text: "挂牌价不高于裸号估值的90%",
        expression: compare("lte", field("listing.price"), {
          op: "multiply",
          args: [field("valuation.bare"), literal(0.9)],
        }),
      },
      {
        text: "至少一只有须弥真言的宝宝",
        expression: compare(
          "gt",
          {
            op: "count",
            collections: ["pets"],
            where: { op: "contains", args: [field("item.skills"), literal("须弥真言")] },
          },
          literal(0),
        ),
      },
      {
        text: "至少一件6段装备且人物等级175",
        expression: {
          op: "and",
          args: [
            compare(
              "gt",
              {
                op: "count",
                collections: ["equipment"],
                where: compare("gte", field("item.gemLevel"), literal(6)),
              },
              literal(0),
            ),
            compare("eq", field("role.level"), literal(175)),
          ],
        },
      },
      {
        text: "装备伤害合计超过1000",
        expression: compare(
          "gt",
          { op: "sum", collection: "equipment", field: "item.damage" },
          literal(1000),
        ),
      },
    ];
    const entries = rules.map((item, index) => ({ id: `C${index + 1}`, text: item.text }));
    const compiled = validateConditionCompilation(
      response(rules.map((item, index) => reply(item.expression, `C${index + 1}`))),
      entries,
    );
    expect(compiled.map((item) => item.rule.expression)).toEqual(
      rules.map((item) => item.expression),
    );
    expect(compiled.map((item) => item.rule.sourceText)).toEqual(rules.map((item) => item.text));
  });

  it("主观条件与歧义返回未就绪的解释，不编成总是真或遗漏子句", async () => {
    const entries = [
      { id: "C1", text: "配置很好" },
      { id: "C2", text: "角色数量超过8" },
    ];
    const analyze = vi.fn<ConditionCompilerAnalyze>(async () =>
      response([
        { id: "C1", status: "unsupported", expression: null, issues: ["请明确配置好的可核验标准"] },
        {
          id: "C2",
          status: "ambiguous",
          expression: null,
          issues: ["请明确统计装备、召唤兽还是其他对象"],
        },
      ]),
    );
    const compiled = await compileConditionTexts(entries, options, analyze);
    expect(compiled[0].rule).toMatchObject({
      status: "unsupported",
      explanation: "请明确配置好的可核验标准",
    });
    expect(compiled[1].rule).toMatchObject({ status: "ambiguous" });
    expect(compiled.every((item) => item.rule.expression === undefined)).toBe(true);
  });

  it.each([
    response([]),
    response([reply(), reply()]),
    response([reply(quantity(), "C2")]),
    response([{ ...reply(), status: "met" }]),
    response([{ ...reply(), explanation: "模型自行解释" }]),
    response([{ ...reply(), sourceText: "替换用户条件" }]),
    response([{ ...reply(), issues: ["不能判断统计口径"] }]),
    response([{ id: "C1", status: "unsupported", expression: quantity(), issues: ["字段未知"] }]),
    response([{ id: "C1", status: "ambiguous", expression: null, issues: [] }]),
    JSON.stringify({ conditions: [reply()], tool: "execute" }),
    "```json\n" + response([reply()]) + "\n```",
    "not-json",
  ])("拒绝协议坏输出 %s", (raw) => {
    expect(() => validateConditionCompilation(raw, input)).toThrow();
  });

  it.each([
    literal(true),
    compare("gt", literal(1), literal(0)),
    compare("gt", field("record.__proto__.isAdmin"), literal(0)),
    compare("gt", field("item.level"), literal(0)),
    compare(
      "gt",
      {
        op: "count",
        collections: ["equipment", "pets"],
        where: { op: "contains", args: [field("item.skills"), literal("须弥真言")] },
      },
      literal(0),
    ),
    { op: "eval", args: [literal("process.exit()")], code: "process.exit()" },
  ])("拒绝常量判定、任意字段和非法AST %j", (expression) => {
    expect(() => validateConditionCompilation(response([reply(expression)]), input)).toThrow();
  });

  it("限制表达式深度，避免深层输出占用执行器", () => {
    let expression = quantity();
    for (let i = 0; i < 15; i++) expression = { op: "not", args: [expression] };
    expect(() => validateConditionCompilation(response([reply(expression)]), input)).toThrow(
      "12层",
    );
  });

  it("取消和截断不会产生可保存规则", async () => {
    const controller = new AbortController();
    controller.abort(new Error("用户已取消"));
    const analyze = vi.fn<ConditionCompilerAnalyze>(async () => response([reply()]));
    await expect(
      compileConditionTexts(input, { ...options, signal: controller.signal }, analyze),
    ).rejects.toThrow("用户已取消");
    expect(analyze).not.toHaveBeenCalled();
    await expect(
      compileConditionTexts(input, options, async () => ({
        text: response([reply()]),
        truncated: true,
      })),
    ).rejects.toThrow("被截断");
    const inFlight = new AbortController();
    await expect(
      compileConditionTexts(input, { ...options, signal: inFlight.signal }, async () => {
        inFlight.abort(new Error("解析期间取消"));
        return response([reply()]);
      }),
    ).rejects.toThrow("解析期间取消");
  });

  it("默认复用项目客户端，仅一次轻量解析，不触发搜索或商品分析", async () => {
    mocks.analyze.mockReset().mockResolvedValue({ text: response([reply()]) });
    mocks.prepare.mockReset().mockResolvedValue({ model: "fixture-model", analyze: mocks.analyze });
    const compiled = await compileConditionTexts(input, options);
    expect(compiled).toHaveLength(1);
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith("codex", "fixture-model");
    expect(mocks.analyze).toHaveBeenCalledTimes(1);
    expect(mocks.analyze.mock.calls[0][3]).toEqual({ bareRoleReview: true });
  });

  it("输入校验和空列表不调用模型", async () => {
    const analyze = vi.fn<ConditionCompilerAnalyze>(async () => response([reply()]));
    expect(await compileConditionTexts([], options, analyze)).toEqual([]);
    for (const value of [
      [{ id: "C1", text: " " }],
      [{ id: "C1", text: "x".repeat(1001) }],
      [...input, input[0]],
      [{ id: "invalid", text: "条件" }],
      Array.from({ length: 60 }, (_, index) => ({ id: `C${index}`, text: "条件" })),
    ])
      await expect(compileConditionTexts(value, options, analyze)).rejects.toThrow();
    await expect(
      compileConditionTexts(input, { provider: "bad" as "codex" }, analyze),
    ).rejects.toThrow("解析服务");
    await expect(compileConditionTexts(input, { ...options, model: "" }, analyze)).rejects.toThrow(
      "解析模型",
    );
    expect(analyze).not.toHaveBeenCalled();
  });
});
