import type { DatabaseSync } from "node:sqlite";
import type { SavedRoleRecord } from "../crawler/types";
import { captureIssues } from "../crawler/capture-readiness";
import { readValuationFact } from "./valuation-facts";

const TABLE = "analysis_school_formula_confirmations";
const DEFAULT_NOTE =
  "用户明确确认当前角色最高五项师门技能沿用已飞升原公式；超过150级不封顶，负的q不归零。";

export class SchoolFormulaConfirmationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchoolFormulaConfirmationError";
  }
}

export type SchoolFormulaConfirmation = {
  listingKey: string;
  levels: number[];
  note: string;
  confirmedAt: string;
};

function currentLevels(db: DatabaseSync, key: string): number[] {
  const row = db
    .prepare("SELECT listing_json,detail_json,status FROM listings WHERE key=?")
    .get(key);
  if (!row || row.status !== "complete" || !row.detail_json)
    throw new SchoolFormulaConfirmationError("角色资料尚未完整采集，不能确认飞升师门公式：" + key);
  const record: SavedRoleRecord = {
    listing: JSON.parse(String(row.listing_json)),
    detail: JSON.parse(String(row.detail_json)),
    status: "complete",
    error: null,
  };
  if (
    record.listing.key !== key ||
    !record.detail ||
    captureIssues(record.detail, false, true, record.listing).length
  )
    throw new SchoolFormulaConfirmationError("角色资料尚未完整采集，不能确认飞升师门公式：" + key);
  const state = readValuationFact(record, "飞升/渡劫/化圣", "人物/修炼")?.raw.trim();
  const stateValues = [
    ...(record.detail.valuation?.fields || []).filter(
      (field) => field.name === "飞升/渡劫/化圣" && field.tab === "人物/修炼",
    ),
    ...record.detail.tabs
      .filter((tab) => tab.name === "人物/修炼")
      .flatMap((tab) => tab.fields.filter((field) => field.name === "飞升/渡劫/化圣")),
  ].map((field) => field.value.trim());
  if (
    (state !== "已飞升" && state !== "飞升") ||
    stateValues.some((value) => value !== "已飞升" && value !== "飞升")
  )
    throw new SchoolFormulaConfirmationError("只有明确已飞升的角色可以确认此公式：" + key);
  const tabs = record.detail.tabs.filter((tab) => tab.name === "技能");
  const skills = tabs[0]?.items?.filter((item) => item.category === "师门技能") || [];
  if (
    tabs.length !== 1 ||
    skills.length !== 7 ||
    new Set(skills.map((item) => item.name)).size !== 7 ||
    skills.some(
      (item) => item.kind !== "skill" || !item.name.trim() || !/^\d{1,3}$/.test(item.level || ""),
    )
  )
    throw new SchoolFormulaConfirmationError(
      "必须有七项名称唯一、等级明确的师门技能才能确认：" + key,
    );
  return skills
    .map((item) => Number(item.level))
    .sort((a, b) => b - a)
    .slice(0, 5);
}

/** Record explicit consent for existing products only, deriving levels from collected evidence. */
export function confirmAscendedSchoolFormula(
  db: DatabaseSync,
  productKeys: unknown,
  confirmation: unknown,
  note: unknown = DEFAULT_NOTE,
) {
  if (confirmation !== true)
    throw new SchoolFormulaConfirmationError("请明确确认沿用已飞升师门原公式");
  if (
    !Array.isArray(productKeys) ||
    productKeys.length < 1 ||
    productKeys.length > 50 ||
    productKeys.some((key) => typeof key !== "string" || !/^\d+:[\w-]+$/.test(key)) ||
    new Set(productKeys).size !== productKeys.length
  )
    throw new SchoolFormulaConfirmationError("请提供1至50个唯一有效的商品标识");
  if (typeof note !== "string" || !note.trim() || note.length > 1000)
    throw new SchoolFormulaConfirmationError("用户确认说明须为1至1000字");
  const confirmedAt = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const confirmations: SchoolFormulaConfirmation[] = productKeys.map((listingKey: string) => ({
      listingKey,
      levels: currentLevels(db, listingKey),
      note: note.trim(),
      confirmedAt,
    }));
    db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      listing_key TEXT PRIMARY KEY, levels_json TEXT NOT NULL,
      note TEXT NOT NULL, confirmed_at TEXT NOT NULL
    )`);
    const save = db.prepare(`INSERT INTO ${TABLE} VALUES(?,?,?,?)
      ON CONFLICT(listing_key) DO UPDATE SET levels_json=excluded.levels_json,
        note=excluded.note,confirmed_at=excluded.confirmed_at`);
    for (const item of confirmations)
      save.run(item.listingKey, JSON.stringify(item.levels), item.note, item.confirmedAt);
    db.exec("COMMIT");
    return { confirmed: confirmations.length, productKeys: [...productKeys], confirmations };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Old consent stays in its audit row, but cannot authorize changed or incomplete current data. */
export function loadAscendedSchoolFormulaConfirmations(db: DatabaseSync): Record<string, number[]> {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(TABLE)) return {};
  const result: Record<string, number[]> = {};
  for (const row of db.prepare(`SELECT listing_key,levels_json FROM ${TABLE}`).all()) {
    const key = String(row.listing_key);
    const saved: unknown = JSON.parse(String(row.levels_json));
    if (
      !Array.isArray(saved) ||
      saved.length !== 5 ||
      saved.some(
        (level) => typeof level !== "number" || !Number.isSafeInteger(level) || level < 0,
      ) ||
      saved.some((level, index) => index > 0 && saved[index - 1] < level)
    )
      throw new Error("已保存的飞升师门公式确认等级损坏：" + key);
    try {
      const levels = currentLevels(db, key);
      if (levels.every((level, index) => level === saved[index])) result[key] = levels;
    } catch (error) {
      if (!(error instanceof SchoolFormulaConfirmationError)) throw error;
      // A removed role, changed state, or partial recapture needs a new explicit confirmation.
    }
  }
  return result;
}
