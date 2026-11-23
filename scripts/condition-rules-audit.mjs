#!/usr/bin/env node
// Read-only replay of saved product snapshots. Outputs can contain private role data;
// keep --output and compilation caches outside the source tree when sharing a PR.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "vite-plus";
import {
  acquireConditionAuditRuntime,
  compileAuditThroughService,
} from "./condition-rules-audit-runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const flags = new Map();
for (let index = 0; index < args.length; index += 2) {
  if (!args[index]?.startsWith("--") || args[index + 1] === undefined)
    throw new Error(
      "用法：node scripts/condition-rules-audit.mjs --database /绝对路径/cbg.sqlite --output /private/tmp/rules-audit.json [--auth-project /项目路径] [--compiled-json /已编译JSON] [--compile-url http://127.0.0.1:5173/api/analysis/conditions/compile] [--provider codex] [--model 模型]",
    );
  flags.set(args[index].slice(2), args[index + 1]);
}
for (const name of flags.keys())
  if (
    ![
      "database",
      "output",
      "auth-project",
      "compiled-json",
      "compile-url",
      "provider",
      "model",
    ].includes(name)
  )
    throw new Error("未知参数：" + name);
const database = flags.get("database"),
  output = flags.get("output");
if (!database || !output || !isAbsolute(database) || !isAbsolute(output))
  throw new Error("--database 和 --output 须使用绝对路径");
if (
  resolve(database) === resolve(output) ||
  resolve(database) === resolve(output + ".compiled.json")
)
  throw new Error("输出路径不能覆盖数据库");
const authProject = flags.get("auth-project");
if (authProject && !isAbsolute(authProject)) throw new Error("--auth-project 须使用绝对路径");
const cache = mkdtempSync(join(tmpdir(), "cbg-rule-audit-vite-"));
const originalDirectory = process.cwd();
const server = await createServer({
  configFile: false,
  root,
  cacheDir: cache,
  appType: "custom",
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});
let db;
let ownedCodexRuntime;
try {
  const { compileConditionTexts } = await server.ssrLoadModule(
    "/server/analysis/condition-compiler.ts",
  );
  const { normalizeCompiledRule, RULE_ENGINE_VERSION } = await server.ssrLoadModule(
    "/server/analysis/condition-rule-types.ts",
  );
  const { evaluateCompiledRule } = await server.ssrLoadModule(
    "/server/analysis/condition-rule-runtime.ts",
  );
  const input = [
    { id: "C1", text: "人物装备、灵饰、宝宝装备和召唤兽的合计数量严格大于8" },
    { id: "C2", text: "至少3件等级大于或等于100级的人物装备" },
    { id: "C3", text: "至少一只召唤兽的当前技能包含须弥真言" },
    { id: "C4", text: "人物等级不低于175级，并且门派为化生寺" },
    { id: "C5", text: "挂牌价小于或等于裸号估值的90%" },
    { id: "C6", text: "人物装备的伤害属性数值总和大于1000" },
    { id: "C7", text: "灵饰的最低等级大于或等于100级" },
    { id: "C8", text: "召唤兽的最高成长大于或等于1.25" },
    { id: "C9", text: "配置很好，值得买" },
    { id: "C10", text: "人物法术伤害大于或等于2000" },
    { id: "C11", text: "只需满足任一条件：召唤兽数量至少3只，或者人物速度至少800" },
    { id: "C12", text: "人物装备至少3件，并且召唤兽至少2只" },
    { id: "C13", text: "装备和宝宝加起来的数量大于8件" },
    { id: "C14", text: "召唤兽数量至少3只" },
  ];
  if (authProject) process.chdir(authProject);
  let compiled;
  if (flags.has("compiled-json")) {
    const saved = JSON.parse(readFileSync(flags.get("compiled-json"), "utf8"));
    compiled = Array.isArray(saved) ? saved : saved.compiled;
    if (!Array.isArray(compiled) || compiled.length !== input.length)
      throw new Error("编译缓存缺少审计条件");
    const map = new Map(compiled.map((entry) => [entry.id, entry.rule]));
    if (map.size !== input.length) throw new Error("编译缓存编号重复");
    compiled = input.map((entry) => ({
      id: entry.id,
      rule: normalizeCompiledRule(map.get(entry.id), entry.text),
    }));
  } else {
    console.log(
      "编译自然语言审计条件：" + input.length + "条；仅解释规则，不分析商品、不采集网页。",
    );
    const options = {
      provider: flags.get("provider") || "codex",
      ...(flags.has("model") ? { model: flags.get("model") } : {}),
    };
    if (flags.has("compile-url")) {
      compiled = await compileAuditThroughService(
        flags.get("compile-url"),
        input,
        options,
        normalizeCompiledRule,
      );
    } else {
      if (options.provider === "codex")
        ownedCodexRuntime = await acquireConditionAuditRuntime(process.cwd());
      compiled = await compileConditionTexts(input, options);
    }
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(
    output + ".compiled.json",
    JSON.stringify({ version: RULE_ENGINE_VERSION, compiled }, null, 2) + "\n",
  );
  db = new DatabaseSync(database, { readOnly: true });
  const rows = db
    .prepare(`
    WITH completed AS (
      SELECT t.id,t.listing_key,t.result_json,t.source_listing_json,t.source_detail_json,
        row_number() OVER (PARTITION BY t.listing_key ORDER BY t.completed_at DESC,t.id DESC) position
      FROM analysis_tasks t
      WHERE t.status='completed' AND t.result_json IS NOT NULL
    )
    SELECT t.*,l.listing_json current_listing_json,l.detail_json current_detail_json
    FROM completed t JOIN listings l ON l.key=t.listing_key
    WHERE t.position=1 ORDER BY t.listing_key
  `)
    .all();
  const results = [];
  for (const row of rows) {
    const analysis = JSON.parse(row.result_json),
      valuation = analysis.valuation;
    if (!valuation) continue;
    const record = {
      listing: JSON.parse(row.source_listing_json),
      detail: JSON.parse(row.source_detail_json),
      status: "complete",
      error: null,
    };
    const prices = {
      asking: Number(record.listing.price),
      bare: valuation.bare_role_value ?? null,
    };
    const evaluations = compiled.map((entry) => ({
      id: entry.id,
      ...evaluateCompiledRule(entry.rule, record, prices),
    }));
    // An independent price oracle does not call the rule evaluator or field resolver.
    const priceOracle =
      typeof prices.bare === "number" &&
      Number.isFinite(prices.bare) &&
      prices.bare >= 0 &&
      Number.isFinite(prices.asking) &&
      prices.asking > 0
        ? Math.round(prices.asking * 100) <= Math.round(prices.bare * 0.9 * 100)
          ? "met"
          : "unmet"
        : "unknown";
    // The official count field is checked independently of normalized petInventory.
    const petTabs = record.detail?.tabs.filter((tab) => tab.name === "召唤兽/孩子") || [];
    const rawCounts = petTabs.map((tab) => tab.petCount);
    const completePets =
      record.detail?.captureMode !== "body" &&
      record.detail?.petCapture?.complete === true &&
      !record.detail?.petCapture?.issues?.length;
    const petCount =
      completePets &&
      rawCounts.length === 1 &&
      Number.isSafeInteger(rawCounts[0]) &&
      rawCounts[0] >= 0
        ? rawCounts[0]
        : null;
    const petCountOracle = petCount === null ? "unknown" : petCount >= 3 ? "met" : "unmet";
    results.push({
      key: row.listing_key,
      taskId: row.id,
      name: record.listing.name,
      asking: prices.asking,
      bare: prices.bare,
      decision: valuation.decision,
      sourceChanged:
        row.source_listing_json !== row.current_listing_json ||
        row.source_detail_json !== row.current_detail_json,
      sourceHash: createHash("sha256")
        .update(row.source_listing_json + row.source_detail_json)
        .digest("hex"),
      rawPetCount: petCount,
      priceOracle,
      petCountOracle,
      evaluations,
      oracleChecks: {
        price90: evaluations.find((entry) => entry.id === "C5").status === priceOracle,
        petCount:
          petCount === null
            ? null
            : evaluations.find((entry) => entry.id === "C14").status === petCountOracle,
      },
      // These small archival fields make the reported three-pet false positive reviewable
      // without putting the complete private role documents into the report.
      ...(String(record.listing.name) === "70391545"
        ? {
            regressionSource: {
              equipmentCapture: record.detail?.equipmentCapture,
              petCapture: record.detail?.petCapture,
              rawEquipment: (record.detail?.tabs || [])
                .filter((tab) => tab.name.startsWith("道具/法宝"))
                .flatMap((tab) => tab.items || [])
                .map((item) => ({
                  name: item.name,
                  category: item.category,
                  location: item.location,
                })),
              rawPets: petTabs
                .flatMap((tab) => tab.pets || [])
                .map((pet) => ({
                  name: pet.name,
                  equipment: (pet.equipment || []).map((item) => ({
                    name: item.name,
                    category: item.category,
                  })),
                })),
            },
          }
        : {}),
    });
  }
  const stats = compiled.map((entry) => {
    const outcomes = results.map((row) => row.evaluations.find((value) => value.id === entry.id));
    return {
      id: entry.id,
      text: entry.rule.sourceText,
      compilation: entry.rule.status,
      explanation: entry.rule.explanation,
      issues: entry.rule.issues,
      met: outcomes.filter((value) => value.status === "met").length,
      unmet: outcomes.filter((value) => value.status === "unmet").length,
      unknown: outcomes.filter((value) => value.status === "unknown").length,
    };
  });
  const expression = (id) => compiled.find((entry) => entry.id === id)?.rule.expression;
  const synonym = {
    first: "C1",
    second: "C13",
    exactCanonicalEqual: JSON.stringify(expression("C1")) === JSON.stringify(expression("C13")),
    outcomesEqual: results.every(
      (row) =>
        row.evaluations.find((entry) => entry.id === "C1").status ===
        row.evaluations.find((entry) => entry.id === "C13").status,
    ),
  };
  // Seeded varying thresholds test the general operator on actual inventories. The
  // check is monotonicity across >0, >1, >3, >8, >13, >21, not a mirrored expected count.
  const thresholds = [0, 1, 3, 8, 13, 21];
  const baseRule = compiled.find((entry) => entry.id === "C1")?.rule;
  const monotonicity = [];
  if (baseRule?.status === "ready") {
    for (const row of rows) {
      const valuation = JSON.parse(row.result_json).valuation;
      if (!valuation) continue;
      const record = {
        listing: JSON.parse(row.source_listing_json),
        detail: JSON.parse(row.source_detail_json),
        status: "complete",
        error: null,
      };
      const outcomes = thresholds.map((threshold) => {
        const sourceText = `四类数量大于${threshold}`;
        const rule = normalizeCompiledRule(
          {
            version: RULE_ENGINE_VERSION,
            sourceText,
            status: "ready",
            explanation: "阈值边界审计",
            issues: [],
            expression: {
              op: "gt",
              args: [
                { op: "count", collections: ["equipment", "jewelry", "petEquipment", "pets"] },
                { op: "literal", value: threshold },
              ],
            },
          },
          sourceText,
        );
        return evaluateCompiledRule(rule, record, {
          asking: Number(record.listing.price),
          bare: valuation.bare_role_value ?? null,
        }).status;
      });
      let sawUnmet = false;
      const valid = outcomes.every((status) => {
        if (status === "unknown") return true;
        if (status === "unmet") sawUnmet = true;
        return status !== "met" || !sawUnmet;
      });
      if (!valid) monotonicity.push({ key: row.listing_key, outcomes });
    }
  }
  const regression = results
    .filter((row) => String(row.name) === "70391545")
    .map((row) => ({
      key: row.key,
      countResult: row.evaluations.find((entry) => entry.id === "C1"),
      raw: row.regressionSource,
      passed: row.evaluations.find((entry) => entry.id === "C1")?.status === "unmet",
    }));
  const checks = {
    priceOracleDisagreements: results
      .filter((row) => !row.oracleChecks.price90)
      .map((row) => row.key),
    petCountOracleDisagreements: results
      .filter((row) => row.oracleChecks.petCount === false)
      .map((row) => row.key),
    synonym,
    thresholds,
    monotonicityViolations: monotonicity,
    subjectiveConditionNotReady:
      compiled.find((entry) => entry.id === "C9")?.rule.status !== "ready",
    regression70391545: regression,
  };
  const report = {
    generatedAt: new Date().toISOString(),
    engineVersion: RULE_ENGINE_VERSION,
    archivedSources: true,
    total: results.length,
    sourceChanged: results.filter((row) => row.sourceChanged).length,
    compilerMode: flags.has("compiled-json")
      ? "cached-validated"
      : flags.has("compile-url")
        ? "managed-service"
        : "owned-runtime",
    compiled,
    stats,
    checks,
    results,
  };
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.table(
    stats.map(({ id, compilation, met, unmet, unknown }) => ({
      id,
      compilation,
      met,
      unmet,
      unknown,
    })),
  );
  console.log(JSON.stringify({ output, total: results.length, checks }, null, 2));
  if (
    checks.priceOracleDisagreements.length ||
    checks.petCountOracleDisagreements.length ||
    !synonym.outcomesEqual ||
    monotonicity.length ||
    !checks.subjectiveConditionNotReady ||
    regression.some((entry) => !entry.passed)
  )
    process.exitCode = 1;
} finally {
  if (db) db.close();
  try {
    if (ownedCodexRuntime) {
      try {
        const { requestCodexCleanup } = await server.ssrLoadModule("/server/ai/codex-lifecycle.ts");
        await requestCodexCleanup();
      } finally {
        await ownedCodexRuntime.close();
      }
    }
  } finally {
    process.chdir(originalDirectory);
    await server.close();
    rmSync(cache, { recursive: true, force: true });
  }
}
