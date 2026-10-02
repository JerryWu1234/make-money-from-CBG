import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { textHash } from "./contract";
import type { AnalysisProfile, ValuationSettings } from "./valuation-types";

export const PROMPT_FILE = resolve("prompts/role-valuation.md");
export const CALCULATION_VERSION = "bare-role-v2";
// Update alongside the calculator when changing pricing sections III through VIII.
const PRICING_HASH = "5b1cafe85105292b985c2076dfcaf30eb72ba7bf247a45ba71efacf4ac7dbf11";
export const DEFAULT_SETTINGS: ValuationSettings = {
  b: null,
  a: null,
  budget: null,
  extraCost: null,
  strengthMode: null,
  schoolCapConfirmed: false,
  capMode: null,
  capTie: null,
  holyLevelPremium: null,
  opportunityMode: null,
  mountBoundary: null,
  sumAdvancedMounts: false,
  adjustmentMode: null,
  adjustmentScope: null,
  servers: [],
};
export function normalizeSettings(input: unknown): ValuationSettings {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("分析参数格式错误");
  const value = input as Record<string, unknown>;
  const number = (key: string, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    const raw = value[key];
    if (raw === null || raw === undefined || raw === "") return null;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < min || raw > max)
      throw new Error("分析参数 " + key + " 超出范围");
    return raw;
  };
  const choice = <T extends string>(key: string, choices: readonly T[]): T | null => {
    const raw = value[key];
    if (raw === null || raw === undefined || raw === "") return null;
    if (typeof raw !== "string" || !choices.includes(raw as T))
      throw new Error("计算口径 " + key + " 无效");
    return raw as T;
  };
  const boolean = (key: string, nullable = false) => {
    const raw = value[key];
    if (raw == null) return nullable ? null : false;
    if (typeof raw !== "boolean") throw new Error("分析参数 " + key + " 无效");
    return raw;
  };
  const b = number("b", Number.MIN_VALUE, 1),
    a = number("a", Number.MIN_VALUE, 1);
  if (a !== null && (b === null || a > b)) throw new Error("理想买入系数需满足 0 < a ≤ b");
  if (value.servers !== undefined && (!Array.isArray(value.servers) || value.servers.length > 200))
    throw new Error("区服参数格式错误");
  const servers = ((value.servers || []) as unknown[])
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        throw new Error("区服参数格式错误");
      const row = entry as Record<string, unknown>;
      if (typeof row.serverId !== "string" || !/^\d{1,12}$/.test(row.serverId))
        throw new Error("服务器 ID 无效");
      const age = row.age ?? null;
      if (age !== null && (typeof age !== "string" || !["one", "three", "older"].includes(age)))
        throw new Error("区服年代无效");
      const positive = (key: string) => {
        const raw = row[key];
        if (raw == null || raw === "") return null;
        if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw > 1e12)
          throw new Error("区服参数 " + key + " 无效");
        if (key === "rank" && !Number.isInteger(raw)) throw new Error("热度排名应为整数");
        return raw;
      };
      if (row.baselineUnitConfirmed != null && typeof row.baselineUnitConfirmed !== "boolean")
        throw new Error("基准报价单位确认无效");
      return {
        serverId: row.serverId,
        age: age as ValuationSettings["servers"][number]["age"],
        rank: positive("rank"),
        goldPrice: positive("goldPrice"),
        goldUnit: positive("goldUnit"),
        baselineUnitConfirmed: row.baselineUnitConfirmed === true,
      };
    })
    .sort((left, right) => left.serverId.localeCompare(right.serverId));
  if (new Set(servers.map((row) => row.serverId)).size !== servers.length)
    throw new Error("同一服务器只能配置一次");
  return {
    b,
    a,
    budget: number("budget"),
    extraCost: number("extraCost"),
    strengthMode: choice("strengthMode", ["single", "cumulative"]),
    schoolCapConfirmed: boolean("schoolCapConfirmed")!,
    capMode: choice("capMode", ["both", "effective"]),
    capTie: choice("capTie", ["attack", "magic"]),
    holyLevelPremium: boolean("holyLevelPremium", true),
    opportunityMode: choice("opportunityMode", ["formula", "discrete"]),
    mountBoundary: choice("mountBoundary", ["lower", "upper"]),
    sumAdvancedMounts: boolean("sumAdvancedMounts")!,
    adjustmentMode: choice("adjustmentMode", ["add", "multiply"]),
    adjustmentScope: choice("adjustmentScope", ["body", "all"]),
    servers,
  };
}
export function createProfile(
  template: string,
  settings: unknown = DEFAULT_SETTINGS,
): AnalysisProfile {
  if (!template.trim() || Buffer.byteLength(template, "utf8") > 64 * 1024)
    throw new Error("Prompt 不能为空或超过 64 KiB");
  const normalized = normalizeSettings(settings);
  const start = template.indexOf("## 三、"),
    end = template.indexOf("## 九、");
  const calculationCompatible =
    start >= 0 &&
    end > start &&
    textHash(template.slice(start, end).replace(/\s/g, "")) === PRICING_HASH;
  const promptHash = textHash(template),
    settingsHash = textHash(JSON.stringify(normalized));
  return {
    version: "role-valuation-v1",
    template,
    promptHash,
    settings: normalized,
    settingsHash,
    calculationVersion: CALCULATION_VERSION,
    calculationCompatible,
    hash: textHash(
      JSON.stringify([promptHash, settingsHash, CALCULATION_VERSION, "valuation-schema-v1"]),
    ),
  };
}
function initialize(db: DatabaseSync) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS analysis_settings (id INTEGER PRIMARY KEY CHECK(id=1), settings_json TEXT NOT NULL)",
  );
}
export function loadProfile(db: DatabaseSync, file = PROMPT_FILE) {
  initialize(db);
  const row = db.prepare("SELECT settings_json FROM analysis_settings WHERE id=1").get();
  return createProfile(
    readFileSync(file, "utf8"),
    row ? JSON.parse(String(row.settings_json)) : DEFAULT_SETTINGS,
  );
}
export function saveProfile(db: DatabaseSync, input: unknown, file = PROMPT_FILE) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("分析设置格式错误");
  const value = input as Record<string, unknown>;
  if (typeof value.template !== "string" || typeof value.baseHash !== "string")
    throw new Error("请先读取完整分析设置");
  const next = createProfile(value.template, value.settings);
  initialize(db);
  db.exec("BEGIN IMMEDIATE");
  let previous = "";
  const temporary = file + "." + randomUUID() + ".tmp";
  let replaced = false;
  try {
    previous = readFileSync(file, "utf8");
    if (loadProfile(db, file).hash !== value.baseHash)
      throw new Error("分析设置已被修改，请重新打开后保存");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temporary, next.template, { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
    replaced = true;
    db.prepare(
      "INSERT INTO analysis_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET settings_json=excluded.settings_json",
    ).run(JSON.stringify(next.settings));
    db.exec("COMMIT");
    return next;
  } catch (error) {
    db.exec("ROLLBACK");
    if (replaced) writeFileSync(file, previous, { mode: 0o600 });
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}
