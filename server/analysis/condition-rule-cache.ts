import type { DatabaseSync } from "node:sqlite";
import { conditionNodes, type ConditionGroup, type ConditionNode } from "./conditions";
import {
  RULE_ENGINE_VERSION,
  normalizeCompiledRule,
  type CompiledConditionRule,
} from "./condition-rule-types";
import {
  compileConditionTexts,
  type ConditionCompilerOptions,
  type ConditionTextInput,
  type CompiledConditionText,
} from "./condition-compiler";

const TABLE = "analysis_condition_rules";

/** Derived rules are independent of the user's saved settings and prompt. */
export function applyCachedConditionRules(
  db: DatabaseSync,
  tree: ConditionGroup | undefined,
): ConditionGroup | undefined {
  if (!tree) return tree;
  const available = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(TABLE);
  const read = available
    ? db.prepare(`SELECT rule_json FROM ${TABLE} WHERE version=? AND source_text=?`)
    : null;
  function visit(node: ConditionNode): ConditionNode {
    if ("children" in node) return { ...node, children: node.children.map(visit) };
    if (node.price) return { ...node };
    const cached = read?.get(RULE_ENGINE_VERSION, node.text.trim());
    if (cached) {
      try {
        const rule = normalizeCompiledRule(JSON.parse(String(cached.rule_json)), node.text);
        return { ...node, rule };
      } catch {
        // A damaged or obsolete cache entry is prepared again before execution.
      }
    }
    return { ...node };
  }
  return visit(tree) as ConditionGroup;
}

type PrepareOptions = ConditionCompilerOptions & { profileFile?: string };
type Compiler = (
  input: readonly ConditionTextInput[],
  options: ConditionCompilerOptions,
) => Promise<CompiledConditionText[]>;
const preparations = new WeakMap<DatabaseSync, Promise<unknown>>();

/** Prepare missing rules automatically at analysis start; never rewrite user settings. */
export async function prepareConditionRules(
  db: DatabaseSync,
  options: PrepareOptions,
  compile: Compiler = compileConditionTexts,
) {
  const previous = preparations.get(db);
  const pending = (async () => {
    await previous?.catch(() => undefined);
    const { loadProfile } = await import("./profile");
    const compilerOptions = {
      provider: options.provider,
      ...(options.model ? { model: options.model } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    };
    let profile = loadProfile(db, options.profileFile);
    for (let attempt = 0; attempt <= 3; attempt++) {
      options.signal?.throwIfAborted();
      const input = profile.settings.conditions
        ? conditionNodes(profile.settings.conditions)
            .filter((node) => !("children" in node) && !node.price && !node.rule)
            .map((node) => ({ id: node.id, text: "text" in node ? node.text : "" }))
        : [];
      if (!input.length) return profile;
      if (attempt === 3) throw new Error("分析条件在准备期间多次变更，请稍后重新开始分析");
      const compiled = await compile(input, compilerOptions);
      options.signal?.throwIfAborted();
      const remaining = new Map(input.map((item) => [item.id, item.text]));
      const rules: CompiledConditionRule[] = [];
      if (compiled.length !== remaining.size) throw new Error("条件判断准备结果缺项或重复");
      for (const item of compiled) {
        const text = remaining.get(item.id);
        if (!text) throw new Error("条件判断准备结果编号无效或重复");
        rules.push(normalizeCompiledRule(item.rule, text));
        remaining.delete(item.id);
      }
      db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
        version TEXT NOT NULL,
        source_text TEXT NOT NULL,
        rule_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(version, source_text)
      )`);
      const save = db.prepare(`INSERT INTO ${TABLE} VALUES(?,?,?,?)
        ON CONFLICT(version,source_text) DO UPDATE SET
          rule_json=excluded.rule_json, created_at=excluded.created_at`);
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const rule of rules)
          save.run(
            RULE_ENGINE_VERSION,
            rule.sourceText,
            JSON.stringify(rule),
            new Date().toISOString(),
          );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      // Settings may have changed while the provider was working. Re-read them,
      // prepare any newly added text, and freeze only the current configuration.
      profile = loadProfile(db, options.profileFile);
    }
    throw new Error("条件判断准备未完成，请重新开始分析");
  })();
  preparations.set(db, pending);
  try {
    return await pending;
  } finally {
    if (preparations.get(db) === pending) preparations.delete(db);
  }
}
