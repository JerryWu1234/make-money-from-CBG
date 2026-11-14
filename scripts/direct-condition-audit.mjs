#!/usr/bin/env node
// A real-model audit over immutable local snapshots. It never opens the product DB.
// Live calls require an independently authorized login for this worktree's own runtime.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite-plus";
import { acquireConditionAuditRuntime } from "./condition-rules-audit-runtime.mjs";
import { codexHomeDirectory } from "./codex-runtime.mjs";
import {
  DIRECT_AUDIT_CONDITIONS,
  expectedDirectAuditResults,
  expectedDirectAuditChecks,
} from "./direct-condition-audit-oracle.mjs";

const flags = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i]?.startsWith("--") || !process.argv[i + 1])
    throw new Error("参数须为 --名称 值");
  flags.set(process.argv[i].slice(2), process.argv[i + 1]);
}
for (const key of flags.keys())
  if (!["snapshot", "output", "replay", "model"].includes(key)) throw new Error("未知参数：" + key);
for (const key of ["snapshot", "output"])
  if (!isAbsolute(flags.get(key) || "")) throw new Error(key + "须为绝对路径");
const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
const snapshot = JSON.parse(await readFile(flags.get("snapshot"), "utf8"));
const replay = flags.has("replay") ? JSON.parse(await readFile(flags.get("replay"), "utf8")) : null;
const cache = mkdtempSync(join(tmpdir(), "cbg-direct-audit-"));
const server = await createServer({
  configFile: false,
  root,
  cacheDir: cache,
  appType: "custom",
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});
const output = {
  generatedAt: new Date().toISOString(),
  model: flags.get("model") || "gpt-6-luna",
  reasoningMode: "condition-review-high",
  evaluationMode: replay
    ? replay.fixture
      ? "local-fixture-replay"
      : "saved-model-response-replay"
    : "real-model",
  readonly: true,
  sourceArchives: snapshot.available,
  samples: [],
  failures: [],
};
let runtime, ai;
const save = async () => {
  await mkdir(dirname(flags.get("output")), { recursive: true });
  await writeFile(flags.get("output"), JSON.stringify(output, null, 2) + "\n", { mode: 0o600 });
};
try {
  const { directConditionPrompt, DIRECT_CONDITION_RESULTS_SCHEMA, validateDirectConditionResults } =
    await server.ssrLoadModule("/server/analysis/direct-condition-review.ts");
  let client;
  if (!replay) {
    if (!existsSync(join(codexHomeDirectory(root), "auth.json")))
      throw new Error("此工作树没有独立授权的Codex登录，请使用--replay本地回归或先完成独立登录");
    runtime = await acquireConditionAuditRuntime(root);
    ai = await server.ssrLoadModule("/server/ai-connection.ts");
    client = await ai.prepareAnalysisClient("codex", output.model);
  }
  for (const sample of snapshot.samples) {
    const record = {
      listing: sample.listing,
      detail: sample.detail,
      status: "complete",
      error: null,
    };
    const tree = {
      id: "G1",
      operator: "and",
      evaluation: "sequence",
      children: DIRECT_AUDIT_CONDITIONS.map((condition, index) => ({
        ...condition,
        ...(index ? { join: "and" } : {}),
      })),
    };
    const prices = { asking: Number(record.listing.price), bare: null };
    const entry = {
      key: record.listing.key,
      name: record.listing.name,
      expected: expectedDirectAuditResults(sample.oracle),
      expectedChecks: expectedDirectAuditChecks(sample.oracle),
      oracle: sample.oracle,
      raw: null,
      usage: null,
      review: null,
      combinations: [],
      checks: [],
    };
    try {
      if (replay) {
        const cached = replay.samples.find((value) => value.key === record.listing.key);
        if (!cached?.raw) throw new Error("重放缺少原始模型响应");
        entry.raw = cached.raw;
      } else {
        const prompt = directConditionPrompt(tree, record, prices);
        const response = await client.analyze(
          prompt,
          {
            type: "object",
            additionalProperties: false,
            required: ["condition_results"],
            properties: { condition_results: DIRECT_CONDITION_RESULTS_SCHEMA },
          },
          AbortSignal.timeout(180_000),
          { bareRoleReview: true, conditionReview: true },
        );
        if (response.truncated) throw new Error("模型响应截断");
        entry.raw = response.text;
        entry.usage = response.usage ?? null;
      }
      // Save the original output before strict validation, including failing outputs.
      output.samples.push(entry);
      await save();
      const review = validateDirectConditionResults(entry.raw, tree, record, prices);
      entry.review = review;
      for (const [id, expected] of Object.entries(entry.expectedChecks)) {
        const actual = review.results.find((result) => result.id === id);
        const problems = [];
        if (actual?.matched !== expected.matched) problems.push("matched");
        if (expected.boundType === "exact") {
          if (actual?.calculation?.result !== expected.actual) problems.push("actual");
          if (actual?.comparison?.operator !== expected.operator) problems.push("operator");
          if (actual?.comparison?.target !== expected.target) problems.push("target");
          if (["C1", "C2", "C3", "C4", "C5"].includes(id)) {
            const selected = (actual?.calculation?.inputs || []).map(
              (index) => actual?.observations?.[index],
            );
            const expectedTerms = ["C1", "C5"].includes(id)
              ? sample.oracle.equipment.map((item) => item.gemLevel)
              : ["攻击修炼", "法术修炼", "防御修炼", "抗法修炼"].map(
                  (name) => sample.oracle.training[name].current,
                );
            const observedTerms = selected.map((item) => item?.numericValue);
            const emptyInventoryCount =
              ["C1", "C5"].includes(id) &&
              expectedTerms.length === 0 &&
              actual?.calculation?.operation === "count" &&
              actual.calculation.inputs.length === 0;
            if (
              !emptyInventoryCount &&
              (actual?.calculation?.operation !== "sum" ||
                JSON.stringify([...expectedTerms].sort((a, b) => a - b)) !==
                  JSON.stringify([...observedTerms].sort((a, b) => Number(a) - Number(b))))
            )
              problems.push("component-sum");
          }
        } else if (expected.boundType === "lower-bound") {
          // An incomplete sum may establish a lower bound, but cannot be shown as
          // a verified exact total. The explanation must disclose the missing terms.
          if (actual?.calculation !== null || actual?.comparison !== null)
            problems.push("lower-bound-presented-as-exact");
          if (
            !/至少|下界|已知/.test(actual?.reason || "") ||
            !/缺|未知|未|不完整|无法/.test(actual?.reason || "") ||
            !String(actual?.reason).includes(String(expected.knownMinimum))
          )
            problems.push("lower-bound-disclosure");
        } else if (actual?.calculation !== null || actual?.comparison !== null)
          problems.push("unknown-presented-as-exact");
        const check = {
          id,
          expected,
          actual: {
            matched: actual?.matched,
            value: actual?.calculation?.result ?? null,
            comparison: actual?.comparison ?? null,
            reason: actual?.reason,
          },
          passed: !problems.length,
          problems,
        };
        entry.checks.push(check);
        if (problems.length) output.failures.push({ key: entry.key, ...check });
      }
      for (const [name, joins] of [
        ["全部且", ["and", "and", "and", "and", "and"]],
        ["全部或", ["or", "or", "or", "or", "or"]],
        ["或且或且或", ["or", "and", "or", "and", "or"]],
      ]) {
        const changed = {
          ...tree,
          children: tree.children.map((node, index) => ({
            ...node,
            ...(index ? { join: joins[index - 1] } : {}),
          })),
        };
        const combined = validateDirectConditionResults(
          entry.raw,
          changed,
          record,
          prices,
        ).results.find((result) => result.id === "G1")?.status;
        const truth = DIRECT_AUDIT_CONDITIONS.map((condition) => entry.expected[condition.id]);
        const expected = truth
          .slice(1)
          .reduce(
            (acc, value, index) =>
              joins[index] === "and"
                ? acc === false || value === false
                  ? false
                  : acc === true && value === true
                    ? true
                    : null
                : acc === true || value === true
                  ? true
                  : acc === false && value === false
                    ? false
                    : null,
            truth[0],
          );
        const expectedStatus = expected === null ? "unknown" : expected ? "met" : "unmet";
        entry.combinations.push({ name, expected: expectedStatus, actual: combined });
        if (combined !== expectedStatus)
          output.failures.push({
            key: entry.key,
            name,
            expected: expectedStatus,
            actual: combined,
          });
      }
      console.log(
        JSON.stringify({
          name: entry.name,
          checks: Object.keys(entry.expected).length,
          result: "checked",
        }),
      );
    } catch (error) {
      if (!output.samples.includes(entry)) output.samples.push(entry);
      entry.error = error instanceof Error ? error.message : String(error);
      output.failures.push({ key: entry.key, error: entry.error });
      console.log(JSON.stringify({ name: entry.name, result: "failed", error: entry.error }));
    }
    await save();
  }
  output.attemptedLeafChecks = output.samples.length * DIRECT_AUDIT_CONDITIONS.length;
  output.validatedSamples = output.samples.filter((sample) => sample.review).length;
  output.leafChecks = output.samples.reduce((count, sample) => count + sample.checks.length, 0);
  output.passedLeafChecks = output.samples.reduce(
    (count, sample) => count + sample.checks.filter((check) => check.passed).length,
    0,
  );
  output.combinationChecks = output.samples.reduce(
    (count, sample) => count + sample.combinations.length,
    0,
  );
  await save();
  console.log(
    JSON.stringify({
      samples: output.samples.length,
      leafChecks: output.leafChecks,
      combinationChecks: output.combinationChecks,
      failures: output.failures.length,
    }),
  );
  if (output.failures.length) process.exitCode = 1;
} finally {
  try {
    if (ai) await ai.shutdownAiConnections();
  } finally {
    try {
      if (runtime) await runtime.close();
    } finally {
      await server.close();
      await rm(cache, { recursive: true, force: true });
    }
  }
}
