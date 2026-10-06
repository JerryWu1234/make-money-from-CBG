import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { textHash } from "./contract";
import type { AnalysisProfile, ValuationSettings } from "./valuation-types";
import { marketServers } from "./market";
import { EQUIPMENT_SIMILAR_POLICY_VERSION, SIMILAR_POLICY_VERSION } from "./pricing-estimate";
import { RECOMMENDED_BUY_FACTOR, RECOMMENDED_RULES } from "./valuation-settings";
import {
  DEFAULT_EQUIPMENT_BASELINE_PRICES,
  EQUIPMENT_BASELINE_POLICY_VERSION,
  type EquipmentBaselinePrices,
} from "./equipment-baseline";

export const PROMPT_FILE = resolve("prompts/role-valuation.md");
export const CALCULATION_VERSION = "price-comparison-v10";
// Update alongside the calculator when changing pricing sections III through VIII.
const PRICING_HASH = "0b29ddcd68d656a7749b447604eb1c5eae6903c72d74fc3cb1876336a55f5ddf";
export const DEFAULT_SETTINGS: ValuationSettings = {
  b: RECOMMENDED_BUY_FACTOR,
  a: null,
  budget: null,
  extraCost: null,
  ...RECOMMENDED_RULES,
  equipmentBaselinePrices: DEFAULT_EQUIPMENT_BASELINE_PRICES,
  servers: [],
};
export function normalizeSettings(input: unknown): ValuationSettings {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("分析参数格式错误");
  const value = input as Record<string, unknown>;
  const defaults = DEFAULT_SETTINGS as unknown as Record<string, unknown>;
  const number = (key: string, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    const raw = value[key] === undefined ? defaults[key] : value[key];
    if (raw === null || raw === undefined || raw === "") return null;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < min || raw > max)
      throw new Error("分析参数 " + key + " 超出范围");
    return raw;
  };
  const choice = <T extends string>(key: string, choices: readonly T[]): T | null => {
    const raw = value[key] === undefined ? defaults[key] : value[key];
    if (raw === null || raw === undefined || raw === "") return null;
    if (typeof raw !== "string" || !choices.includes(raw as T))
      throw new Error("计算口径 " + key + " 无效");
    return raw as T;
  };
  const boolean = (key: string, nullable = false) => {
    const raw = value[key] === undefined ? defaults[key] : value[key];
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
    .map((entry): ValuationSettings["servers"][number] => {
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
        ...(row.source === "auto" || row.source === "manual" ? { source: row.source } : {}),
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
  const baseline = value.equipmentBaselinePrices ?? DEFAULT_EQUIPMENT_BASELINE_PRICES;
  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline))
    throw new Error("普通装备默认价格格式错误");
  const equipmentBaselinePrices = Object.fromEntries(
    Object.keys(DEFAULT_EQUIPMENT_BASELINE_PRICES).map((level) => {
      const row = (baseline as Record<string, unknown>)[level];
      if (!row || typeof row !== "object" || Array.isArray(row))
        throw new Error("普通装备默认价格缺少等级 " + level);
      const prices = Object.fromEntries(
        ["weapon", "armor"].map((kind) => {
          const amount = (row as Record<string, unknown>)[kind];
          if (
            amount !== null &&
            (typeof amount !== "number" ||
              !Number.isSafeInteger(amount) ||
              amount <= 0 ||
              amount > 1e9)
          )
            throw new Error("普通装备默认价格应为正整数梦幻币或留空");
          return [kind, amount];
        }),
      );
      return [level, prices];
    }),
  ) as EquipmentBaselinePrices;
  return {
    equipmentBaselinePrices,
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
  equipmentSearch = true,
  petSearch = equipmentSearch,
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
  const { b: _b, a: _a, budget: _budget, extraCost: _extraCost, ...pricingSettings } = normalized;
  const promptHash = textHash(template),
    settingsHash = textHash(JSON.stringify(pricingSettings));
  return {
    version: "role-valuation-v1",
    equipmentSearch,
    petSearch,
    template,
    promptHash,
    settings: normalized,
    settingsHash,
    calculationVersion: CALCULATION_VERSION,
    calculationCompatible,
    hash: textHash(
      JSON.stringify([
        promptHash,
        settingsHash,
        CALCULATION_VERSION,
        "valuation-schema-v4",
        "final-assets-v1",
        "pet-region-v2",
        SIMILAR_POLICY_VERSION,
        EQUIPMENT_SIMILAR_POLICY_VERSION,
        EQUIPMENT_BASELINE_POLICY_VERSION,
        equipmentSearch,
        petSearch,
      ]),
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
  const stored = row ? (JSON.parse(String(row.settings_json)) as Record<string, unknown>) : null;
  // Legacy null choices and unchecked confirmation flags meant "not configured".
  // Apply the displayed policy; explicit null/false values from the new editor survive.
  const settings =
    stored && stored.settingsVersion !== 2
      ? {
          ...stored,
          b: stored.b ?? RECOMMENDED_BUY_FACTOR,
          ...Object.fromEntries(
            Object.entries(RECOMMENDED_RULES).map(([key, value]) => [key, stored[key] ?? value]),
          ),
          schoolCapConfirmed: RECOMMENDED_RULES.schoolCapConfirmed,
          sumAdvancedMounts: RECOMMENDED_RULES.sumAdvancedMounts,
        }
      : stored || DEFAULT_SETTINGS;
  const market = marketServers(db);
  const manual = normalizeSettings(settings).servers.filter(
    (row: ValuationSettings["servers"][number]) => row.source !== "auto",
  );
  const listed = new Set(
    db.prepare("SELECT 1 FROM sqlite_master WHERE name='listings'").get()
      ? db
          .prepare("SELECT server_id FROM listings GROUP BY server_id")
          .all()
          .map((row) => String(row.server_id))
      : [],
  );
  const available = market.filter(
    (row) =>
      listed.has(row.serverId) &&
      !manual.some((item: ValuationSettings["servers"][number]) => item.serverId === row.serverId),
  );
  const profile = createProfile(readFileSync(file, "utf8"), {
    ...settings,
    servers: [...manual, ...available],
  });
  return { ...profile, marketSources: available };
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
    ).run(
      JSON.stringify({
        ...next.settings,
        servers: next.settings.servers.filter((row) => row.source !== "auto"),
        settingsVersion: 2,
      }),
    );
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
