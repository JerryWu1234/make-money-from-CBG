import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { conditionNodes, type Condition, type ConditionGroup } from "./conditions";
import {
  RULE_ENGINE_VERSION,
  normalizeCompiledRule,
  type CompiledConditionRule,
} from "./condition-rule-types";
import type { ConditionTextInput } from "./condition-compiler";
import { prepareConditionRules } from "./condition-rule-cache";
import { evaluateSavedConditions } from "./condition-evaluation";
import { analysisRecord } from "../../tests/fixtures/analysis";
import { createProfile, loadProfile, saveProfile } from "./profile";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tree(...texts: string[]): ConditionGroup {
  return {
    id: "G1",
    evaluation: "sequence",
    operator: "and",
    children: texts.map((text, index) => ({
      id: `C${index + 1}`,
      text,
      ...(index ? { join: "and" as const } : {}),
    })),
  };
}
function rule(text: string, status: CompiledConditionRule["status"] = "ready") {
  return normalizeCompiledRule(
    {
      version: RULE_ENGINE_VERSION,
      sourceText: text,
      status,
      ...(status === "ready"
        ? {
            expression: {
              op: "gte",
              args: [
                { op: "field", path: "role.level" },
                { op: "literal", value: 100 },
              ],
            },
          }
        : {}),
      explanation: "角色等级至少100级",
      issues: status === "ready" ? [] : ["缺少明确标准"],
    },
    text,
  );
}
const compile = (input: readonly ConditionTextInput[]) =>
  Promise.resolve(input.map((item) => ({ id: item.id, rule: rule(item.text) })));
function fixture(conditions = tree("等级至少100级")) {
  const folder = mkdtempSync(join(tmpdir(), "cbg-condition-cache-"));
  const file = join(folder, "prompt.md");
  writeFileSync(file, "自动条件测试");
  const db = new DatabaseSync(":memory:");
  cleanups.push(
    () => rmSync(folder, { recursive: true, force: true }),
    () => db.close(),
  );
  const before = loadProfile(db, file);
  const save = (next: ConditionGroup) => {
    const current = loadProfile(db, file);
    return saveProfile(
      db,
      {
        template: current.template,
        baseHash: current.hash,
        baseConfigurationHash: current.configurationHash,
        settings: { ...current.settings, conditions: next },
      },
      file,
    );
  };
  save(conditions);
  return { db, file, before, save, options: { provider: "codex" as const, profileFile: file } };
}
function leaves(profile: ReturnType<typeof loadProfile>) {
  return conditionNodes(profile.settings.conditions!).filter(
    (node): node is Condition => !("children" in node),
  );
}

it("直接保存原文，不调用模型也不要求手动解析", () => {
  const x = fixture();
  expect(leaves(loadProfile(x.db, x.file))[0].rule).toBeUndefined();
  expect(
    x.db.prepare("SELECT 1 FROM sqlite_master WHERE name='analysis_condition_rules'").get(),
  ).toBeUndefined();
  expect(readFileSync(x.file, "utf8")).toBe("自动条件测试");
});

it("开始分析自动准备并复用缓存，原始设置不变且不会产生保存冲突", async () => {
  const x = fixture();
  const before = loadProfile(x.db, x.file);
  const saved = x.db.prepare("SELECT settings_json FROM analysis_settings").get()!.settings_json;
  const compiler = vi.fn(compile);
  const profile = await prepareConditionRules(
    x.db,
    { ...x.options, model: "selected-model" },
    compiler,
  );
  expect(compiler).toHaveBeenCalledWith([{ id: "C1", text: "等级至少100级" }], {
    provider: "codex",
    model: "selected-model",
  });
  expect(leaves(profile)[0].rule?.status).toBe("ready");
  expect(profile.configurationHash).toBe(before.configurationHash);
  expect(profile.hash).not.toBe(before.hash);
  expect(x.db.prepare("SELECT settings_json FROM analysis_settings").get()!.settings_json).toBe(
    saved,
  );
  await prepareConditionRules(x.db, x.options, compiler);
  expect(compiler).toHaveBeenCalledTimes(1);
  expect(() =>
    saveProfile(
      x.db,
      {
        template: before.template,
        baseHash: before.hash,
        baseConfigurationHash: before.configurationHash,
        settings: { ...before.settings, budget: 1000 },
      },
      x.file,
    ),
  ).not.toThrow();
});

it("同一原文变更编号或且或后仍复用，文本改变后重新准备", async () => {
  const x = fixture();
  const compiler = vi.fn(compile);
  await prepareConditionRules(x.db, x.options, compiler);
  const same = tree("等级至少100级", "等级至少100级");
  same.children[0].id = "C8";
  same.children[1].join = "or";
  x.save(same);
  const reused = await prepareConditionRules(x.db, x.options, compiler);
  expect(compiler).toHaveBeenCalledTimes(1);
  expect(leaves(reused).every((node) => node.rule?.status === "ready")).toBe(true);
  x.save(tree("等级至少120级"));
  await prepareConditionRules(x.db, x.options, compiler);
  expect(compiler).toHaveBeenCalledTimes(2);
});

it.each(["ambiguous", "unsupported"] as const)(
  "%s 原文保存并缓存，不能被当作满足",
  async (status) => {
    const x = fixture(tree("装备很好"));
    const compiler = vi.fn(async (input: readonly ConditionTextInput[]) =>
      input.map((item) => ({ id: item.id, rule: rule(item.text, status) })),
    );
    const profile = await prepareConditionRules(x.db, x.options, compiler);
    expect(leaves(profile)[0].rule).toMatchObject({ status, issues: ["缺少明确标准"] });
    expect(
      evaluateSavedConditions(profile.settings.conditions!, analysisRecord(), {
        asking: 100,
        bare: 100,
      }).results[0].status,
    ).toBe("unknown");
    await prepareConditionRules(x.db, x.options, compiler);
    expect(compiler).toHaveBeenCalledTimes(1);
  },
);

it("已有合法规则可直接复用，旧版规则自动丢弃后重新准备", async () => {
  const conditions = tree("等级至少100级");
  (conditions.children[0] as Condition).rule = rule("等级至少100级");
  const x = fixture(conditions);
  const compiler = vi.fn(compile);
  await prepareConditionRules(x.db, x.options, compiler);
  expect(compiler).not.toHaveBeenCalled();
  const saved = JSON.parse(
    String(x.db.prepare("SELECT settings_json FROM analysis_settings").get()!.settings_json),
  );
  saved.conditions.children[0].rule.version = "obsolete-rules";
  x.db.prepare("UPDATE analysis_settings SET settings_json=?").run(JSON.stringify(saved));
  await prepareConditionRules(x.db, x.options, compiler);
  expect(compiler).toHaveBeenCalledTimes(1);
});

it("编译期间修改条件时按最新设置准备，不回写或执行旧条件", async () => {
  const x = fixture();
  const compiler = vi.fn(async (input: readonly ConditionTextInput[]) => {
    if (input[0].text === "等级至少100级") x.save(tree("等级至少120级"));
    return compile(input);
  });
  const profile = await prepareConditionRules(x.db, x.options, compiler);
  expect(compiler).toHaveBeenCalledTimes(2);
  expect(leaves(profile)[0]).toMatchObject({
    text: "等级至少120级",
    rule: { sourceText: "等级至少120级" },
  });
  const saved = JSON.parse(
    String(x.db.prepare("SELECT settings_json FROM analysis_settings").get()!.settings_json),
  );
  expect(saved.conditions.children[0]).toEqual({ id: "C1", text: "等级至少120级" });
});

it("并行开始共享已完成的准备，网络失败不保存半成品", async () => {
  const x = fixture();
  const failure = vi.fn(async () => {
    throw new Error("provider offline");
  });
  await expect(prepareConditionRules(x.db, x.options, failure)).rejects.toThrow("provider offline");
  expect(leaves(loadProfile(x.db, x.file))[0].rule).toBeUndefined();
  const compiler = vi.fn(compile);
  const [first, second] = await Promise.all([
    prepareConditionRules(x.db, x.options, compiler),
    prepareConditionRules(x.db, x.options, compiler),
  ]);
  expect(first.hash).toBe(second.hash);
  expect(compiler).toHaveBeenCalledTimes(1);
});

it("损坏缓存或不同版本的缓存不使用，按当前版本重新准备", async () => {
  const x = fixture();
  await prepareConditionRules(x.db, x.options, compile);
  x.db.prepare("UPDATE analysis_condition_rules SET rule_json='{}'").run();
  const compiler = vi.fn(compile);
  const profile = await prepareConditionRules(x.db, x.options, compiler);
  expect(leaves(profile)[0].rule?.version).toBe(RULE_ENGINE_VERSION);
  expect(compiler).toHaveBeenCalledTimes(1);
  x.db.prepare("UPDATE analysis_condition_rules SET version='obsolete-rules'").run();
  await prepareConditionRules(x.db, x.options, compiler);
  expect(compiler).toHaveBeenCalledTimes(2);
});

it("派生规则只改变运行快照，原文和且或才改变配置版本", () => {
  const conditions = tree("等级至少100级");
  const raw = createProfile("template", { conditions });
  (conditions.children[0] as Condition).rule = rule("等级至少100级");
  const compiled = createProfile("template", { conditions });
  expect(compiled.configurationHash).toBe(raw.configurationHash);
  expect(compiled.hash).not.toBe(raw.hash);
  (conditions.children[0] as Condition).text = "等级至少120级";
  delete (conditions.children[0] as Condition).rule;
  expect(createProfile("template", { conditions }).configurationHash).not.toBe(
    raw.configurationHash,
  );
});
