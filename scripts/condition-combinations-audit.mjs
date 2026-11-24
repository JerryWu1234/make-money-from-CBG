#!/usr/bin/env node
// Replay selected archived products without changing the database or starting analysis.
// The saved compilation comes from a real model call; independent raw-data oracles
// verify its leaf results before checking the user-visible sequential combinations.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "vite-plus";

const flags = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i]?.startsWith("--") || !process.argv[i + 1])
    throw new Error("须提供 --database、--compiled-json、--output 绝对路径");
  flags.set(process.argv[i].slice(2), process.argv[i + 1]);
}
for (const key of ["database", "compiled-json", "output"])
  if (!isAbsolute(flags.get(key) || "")) throw new Error(key + " 须为绝对路径");
for (const key of flags.keys())
  if (!["database", "compiled-json", "output"].includes(key)) throw new Error("未知参数：" + key);
if (flags.get("database") === flags.get("output")) throw new Error("不可覆盖数据库");
const cache = mkdtempSync(join(tmpdir(), "cbg-combinations-audit-"));
const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("../", import.meta.url)),
  cacheDir: cache,
  appType: "custom",
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});
let db;
try {
  const { evaluateSavedConditions } = await server.ssrLoadModule(
    "/server/analysis/condition-evaluation.ts",
  );
  const { evaluateCompiledRule } = await server.ssrLoadModule(
    "/server/analysis/condition-rule-runtime.ts",
  );
  const { recommendationFor } = await server.ssrLoadModule("/server/analysis/recommendation.ts");
  const { normalizeCompiledRule, RULE_ENGINE_VERSION } = await server.ssrLoadModule(
    "/server/analysis/condition-rule-types.ts",
  );
  const saved = JSON.parse(readFileSync(flags.get("compiled-json"), "utf8"));
  const compilation = saved.compiled || saved;
  const rule = (id) => {
    const found = compilation.find((entry) => entry.id === id)?.rule;
    if (!found) throw new Error("编译缓存缺少 " + id);
    return normalizeCompiledRule(found, found.sourceText);
  };
  const rules = { B: rule("C14"), C: rule("C1"), U: rule("C9") };
  if ([rules.B, rules.C].some((value) => value.status !== "ready") || rules.U.status === "ready")
    throw new Error("审计条件编译状态不符合预期");
  db = new DatabaseSync(flags.get("database"), { readOnly: true });
  db.exec("PRAGMA query_only=ON");
  const rows = db
    .prepare(`WITH completed AS (
    SELECT id,listing_key,result_json,source_listing_json,source_detail_json,
      row_number() OVER(PARTITION BY listing_key ORDER BY completed_at DESC,id DESC) position
    FROM analysis_tasks WHERE status='completed' AND result_json IS NOT NULL)
    SELECT * FROM completed WHERE position=1 ORDER BY listing_key`)
    .all();
  const classified = [],
    unreviewable = [];
  // This oracle reads explicit source arrays and official petCount directly. It does
  // not use any inventory helper, expression evaluator, or normalized engine evidence.
  function sourceCounts(detail) {
    if (
      !detail ||
      detail.captureMode === "body" ||
      !detail.equipmentCapture?.complete ||
      detail.equipmentCapture.issues?.length ||
      !detail.petCapture?.complete ||
      detail.petCapture.issues?.length
    )
      return null;
    const petTabs = detail.tabs.filter((tab) => tab.name === "召唤兽/孩子");
    if (
      petTabs.length !== 1 ||
      !Number.isInteger(petTabs[0].petCount) ||
      petTabs[0].petCount !== petTabs[0].pets?.length
    )
      return null;
    const equipmentTabs = detail.tabs.filter((tab) => /^道具\/法宝(?:\s*\/|$)/.test(tab.name));
    // Multi-page deduplication has its own unit coverage; use a single source tab here.
    if (equipmentTabs.length !== 1) return null;
    const counts = {
      roleAndJewelry: 0,
      petEquipment: 0,
      loosePetEquipment: 0,
      pets: petTabs[0].petCount,
      excluded: [],
    };
    for (const item of equipmentTabs[0].items || []) {
      const category = item.category || "";
      const official = item.officialModel?.description || "";
      if (
        item.kind === "skill" ||
        item.kind === "innerSkill" ||
        /法宝|灵宝|神器|材料|消耗品|上古玉魄|元身/.test(category)
      ) {
        counts.excluded.push(item.name);
        continue;
      }
      // Count explicitly identified loose pet gear as well as the attached gear below.
      if (
        /召唤兽装备/.test(category) ||
        item.attributes?.装备对象 === "召唤兽" ||
        /【装备对象】召唤兽/.test(official)
      ) {
        if (item.location === "RolePetShipin" || /饰品/.test(category)) {
          counts.excluded.push(item.name);
          continue;
        }
        counts.petEquipment++;
        counts.loosePetEquipment++;
        continue;
      }
      if (
        /人物装备|灵饰/.test(category) ||
        /^role_using_equip_(?:[1-6]|18[7-9]|190)$/.test(item.location || "") ||
        /【装备角色】/.test(official) ||
        /【装备条件】\s*等级\s*[:：]?\s*\d+/.test(official) ||
        /^等级\s*[:：]?\s*\d+$/.test(item.attributes?.装备条件 || "")
      ) {
        counts.roleAndJewelry++;
        continue;
      }
      // Do not invent classifications for uncertain archived evidence.
      return null;
    }
    for (const pet of petTabs[0].pets)
      for (const item of pet.equipment || []) {
        if (item.location === "RolePetShipin" || /饰品/.test(item.category || "")) continue;
        if (item.location !== "RolePetEquips" && item.attributes?.装备对象 !== "召唤兽")
          return null;
        counts.petEquipment++;
      }
    return { ...counts, total: counts.roleAndJewelry + counts.petEquipment + counts.pets };
  }
  for (const row of rows) {
    const valuation = JSON.parse(row.result_json).valuation;
    const record = {
      listing: JSON.parse(row.source_listing_json),
      detail: JSON.parse(row.source_detail_json),
      status: "complete",
      error: null,
    };
    const asking = Number(record.listing.price),
      bare = valuation?.bare_role_value;
    const counts = sourceCounts(record.detail);
    if (
      !counts ||
      !valuation ||
      valuation.decision === "NEED_INFO" ||
      !Number.isFinite(asking) ||
      asking <= 0 ||
      typeof bare !== "number" ||
      !Number.isFinite(bare) ||
      bare < 0
    ) {
      unreviewable.push(row.listing_key);
      continue;
    }
    classified.push({
      row,
      valuation,
      record,
      counts,
      asking,
      bare,
      expected: {
        A: Math.round(asking * 100) > Math.round(bare * 100) ? "met" : "unmet",
        D: Math.round(asking * 100) < Math.round(bare * 100) ? "met" : "unmet",
        B: counts.pets >= 3 ? "met" : "unmet",
        C: counts.total > 8 ? "met" : "unmet",
        U: "unknown",
        N: "met",
      },
    });
  }
  // Include each observed truth pattern, price/count extrema, and the reported false positive.
  const selected = new Map();
  const add = (entry) => {
    if (entry) selected.set(entry.row.listing_key, entry);
  };
  const patterns = new Set();
  for (const entry of classified) {
    const pattern = [entry.expected.A, entry.expected.B, entry.expected.C].join("/");
    if (!patterns.has(pattern)) {
      patterns.add(pattern);
      add(entry);
    }
  }
  for (const sort of [
    (a, b) => a.counts.total - b.counts.total,
    (a, b) => a.asking - a.bare - (b.asking - b.bare),
  ]) {
    const sorted = [...classified].sort(sort);
    sorted.slice(0, 4).forEach(add);
    sorted.slice(-4).forEach(add);
  }
  add(classified.find((entry) => String(entry.record.listing.name) === "70391545"));
  classified
    .filter((entry) => entry.counts.loosePetEquipment > 0)
    .slice(0, 5)
    .forEach(add);
  for (const entry of classified) {
    if (selected.size >= 24) break;
    add(entry);
  }
  if (selected.size < 12) throw new Error("可独立复核的完整样本不足12条");
  const scenarios = [
    {
      name: "且且且",
      keys: ["A", "B", "C", "B"],
      joins: ["and", "and", "and"],
      expected: (s) => (s.A === "met" && s.B === "met" && s.C === "met" ? "met" : "unmet"),
    },
    {
      name: "或或或",
      keys: ["A", "B", "C", "B"],
      joins: ["or", "or", "or"],
      expected: (s) => (s.A === "met" || s.B === "met" || s.C === "met" ? "met" : "unmet"),
    },
    {
      name: "先或后且",
      keys: ["A", "B", "C"],
      joins: ["or", "and"],
      expected: (s) => ((s.A === "met" || s.B === "met") && s.C === "met" ? "met" : "unmet"),
    },
    {
      name: "先且后或",
      keys: ["A", "B", "C"],
      joins: ["and", "or"],
      expected: (s) => ((s.A === "met" && s.B === "met") || s.C === "met" ? "met" : "unmet"),
    },
    {
      name: "且或且",
      keys: ["A", "B", "C", "A"],
      joins: ["and", "or", "and"],
      expected: (s) =>
        ((s.A === "met" && s.B === "met") || s.C === "met") && s.A === "met" ? "met" : "unmet",
    },
    {
      name: "低于裸号且数量",
      keys: ["D", "C"],
      joins: ["and"],
      expected: (s) => (s.D === "met" && s.C === "met" ? "met" : "unmet"),
    },
    { name: "不限制或数量", keys: ["N", "C"], joins: ["or"], expected: (s) => s.C },
    {
      name: "数量且不明确",
      keys: ["C", "U"],
      joins: ["and"],
      expected: (s) => (s.C === "unmet" ? "unmet" : "unknown"),
    },
    {
      name: "数量或不明确",
      keys: ["C", "U"],
      joins: ["or"],
      expected: (s) => (s.C === "met" ? "met" : "unknown"),
    },
    {
      name: "不明确且数量或宠物",
      keys: ["U", "C", "B"],
      joins: ["and", "or"],
      expected: (s) => (s.B === "met" ? "met" : s.C === "unmet" ? "unmet" : "unknown"),
    },
  ];
  const failures = [],
    results = [];
  // Check the exact four-category count, not only >8: a missing loose piece could
  // otherwise keep the same boolean result and hide an undercount.
  for (const sample of classified) {
    const exact = {
      ...rules.C,
      sourceText: `四类合计数量等于${sample.counts.total}`,
      expression: {
        op: "eq",
        args: [
          { op: "count", collections: ["equipment", "jewelry", "petEquipment", "pets"] },
          { op: "literal", value: sample.counts.total },
        ],
      },
    };
    const actual = evaluateCompiledRule(exact, sample.record, {
      asking: sample.asking,
      bare: sample.bare,
    });
    if (actual.status !== "met")
      failures.push({ key: sample.row.listing_key, exactCount: sample.counts, actual });
  }
  for (const sample of selected.values()) {
    const scenariosResults = [];
    for (const scenario of scenarios) {
      const tree = {
        id: "G1",
        evaluation: "sequence",
        operator: "and",
        children: scenario.keys.map((key, index) => ({
          id: "C" + (index + 1),
          text: ["A", "D", "N"].includes(key) ? "" : rules[key].sourceText,
          ...(index ? { join: scenario.joins[index - 1] } : {}),
          ...(["A", "D", "N"].includes(key)
            ? {
                price: {
                  comparison: { A: "gt", D: "lt", N: "none" }[key],
                  adjustment: "none",
                  unit: "amount",
                  value: 0,
                },
              }
            : { rule: rules[key] }),
        })),
      };
      const review = evaluateSavedConditions(tree, sample.record, {
        asking: sample.asking,
        bare: sample.bare,
      });
      const actual = review.results.find((entry) => entry.id === "G1").status;
      const expected = scenario.expected(sample.expected);
      for (let i = 0; i < scenario.keys.length; i++) {
        const leaf = review.results.find((entry) => entry.id === "C" + (i + 1));
        if (leaf.status !== sample.expected[scenario.keys[i]])
          failures.push({
            key: sample.row.listing_key,
            scenario: scenario.name,
            leaf: leaf.id,
            expected: sample.expected[scenario.keys[i]],
            actual: leaf.status,
          });
      }
      const recommendation = recommendationFor(sample.record, sample.valuation, tree);
      const expectedRecommendation = { met: "recommended", unmet: "excluded", unknown: "manual" }[
        expected
      ];
      if (actual !== expected || recommendation.status !== expectedRecommendation)
        failures.push({
          key: sample.row.listing_key,
          scenario: scenario.name,
          expected,
          actual,
          expectedRecommendation,
          actualRecommendation: recommendation.status,
        });
      scenariosResults.push({
        name: scenario.name,
        expected,
        actual,
        recommendation: recommendation.status,
        leaves: review.results.filter((entry) => entry.id !== "G1"),
      });
    }
    results.push({
      key: sample.row.listing_key,
      name: sample.record.listing.name,
      asking: sample.asking,
      bare: sample.bare,
      counts: sample.counts,
      sourceHash: createHash("sha256")
        .update(sample.row.source_listing_json + sample.row.source_detail_json)
        .digest("hex"),
      expected: sample.expected,
      scenarios: scenariosResults,
    });
  }
  const statistics = scenarios.map((scenario) => ({
    name: scenario.name,
    ...Object.fromEntries(
      ["met", "unmet", "unknown"].map((status) => [
        status,
        results.filter(
          (row) => row.scenarios.find((entry) => entry.name === scenario.name).actual === status,
        ).length,
      ]),
    ),
  }));
  const precedenceWitnesses = results
    .filter(
      (row) =>
        (row.expected.A === "met" || row.expected.B === "met") &&
        row.expected.C !== "met" &&
        row.expected.A === "met",
    )
    .map((row) => row.key);
  if (!precedenceWitnesses.length)
    failures.push({ error: "样本缺少从上到下计算与且优先计算结果不同的真实反例" });
  const regression = results.find((row) => String(row.name) === "70391545");
  if (regression && (regression.counts.total !== 3 || regression.expected.C !== "unmet"))
    failures.push({ error: "未复现0装备3召唤兽回归样本" });
  const report = {
    generatedAt: new Date().toISOString(),
    engineVersion: RULE_ENGINE_VERSION,
    readOnly: true,
    compilerMode: "cached-real-model",
    archivedRecords: rows.length,
    independentlyReviewable: classified.length,
    loosePetEquipmentRecords: classified.filter((entry) => entry.counts.loosePetEquipment > 0)
      .length,
    selectedLoosePetEquipmentRecords: results.filter((entry) => entry.counts.loosePetEquipment > 0)
      .length,
    selected: results.length,
    scenarioCount: scenarios.length,
    exactCountChecks: classified.length,
    leafChecks: results.length * scenarios.reduce((n, scenario) => n + scenario.keys.length, 0),
    combinationChecks: results.length * scenarios.length,
    precedenceWitnesses,
    statistics,
    failures,
    conditions: rules,
    results,
  };
  mkdirSync(dirname(flags.get("output")), { recursive: true });
  writeFileSync(flags.get("output"), JSON.stringify(report, null, 2) + "\n");
  console.table(statistics);
  console.log(
    JSON.stringify(
      {
        output: flags.get("output"),
        archivedRecords: rows.length,
        independentlyReviewable: classified.length,
        selected: results.length,
        exactCountChecks: report.exactCountChecks,
        selectedLoosePetEquipmentRecords: report.selectedLoosePetEquipmentRecords,
        leafChecks: report.leafChecks,
        combinationChecks: report.combinationChecks,
        precedenceWitnesses,
        regression: regression
          ? { name: regression.name, counts: regression.counts }
          : "当前数据库没有70391545；另外由浏览器归档回归fixture覆盖",
        failures,
      },
      null,
      2,
    ),
  );
  if (failures.length) process.exitCode = 1;
} finally {
  db?.close();
  await server.close();
  rmSync(cache, { recursive: true, force: true });
}
