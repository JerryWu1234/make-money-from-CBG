import { describe, expect, it, vi } from "vite-plus/test";
import { analysisResponse, valuationRecord } from "../../tests/fixtures/analysis";
import { CrawlStore } from "../crawler/store";
import type { SavedRoleRecord } from "../crawler/types";
import { AnalysisStore } from "./store";
import { loadProfile } from "./profile";
import { calculateValuation } from "./valuation-calculator";
import {
  confirmAscendedSchoolFormula,
  loadAscendedSchoolFormulaConfirmations,
  SchoolFormulaConfirmationError,
} from "./school-confirmation";

const key = "367:school-a";
function ascendedRecord(productKey = key) {
  const record = valuationRecord(productKey);
  record.detail!.tabs[0].fields.find((field) => field.name === "飞升/渡劫/化圣")!.value = "已飞升";
  const skills = record.detail!.tabs[1].items!.filter((item) => item.category === "师门技能");
  [150, 154, 130, 130, 130, 150, 125].forEach((level, index) => {
    skills[index].level = String(level);
  });
  return record;
}
function persist(crawl: CrawlStore, record: SavedRoleRecord) {
  crawl.observe(record.listing);
  crawl.save(record.listing, record.detail!);
}
function memory(run: (crawl: CrawlStore) => void) {
  const crawl = new CrawlStore(":memory:");
  try {
    run(crawl);
  } finally {
    crawl.close();
  }
}

function currentAscendedRecord() {
  const record = ascendedRecord();
  record.listing.eid = "school-a";
  record.listing.url = "https://xyq.cbg.163.com/equip?s=367&eid=school-a";
  record.detail!.captureMode = "all";
  record.detail!.valuation = {
    version: 1,
    fields: [],
    issues: [],
    source: { serverId: "367", eid: "school-a" },
  };
  return record;
}

describe("逐角色保存飞升原公式确认", () => {
  it.each(["missing", "mismatch"])("当前合同%s身份不能持久确认错源技能", (kind) => {
    memory((crawl) => {
      const record = currentAscendedRecord();
      persist(crawl, record);
      record.detail!.valuation!.source =
        kind === "missing" ? {} : { serverId: "367", eid: "foreign-role" };
      crawl.db
        .prepare("UPDATE listings SET detail_json=? WHERE key=?")
        .run(JSON.stringify(record.detail), key);
      expect(() => confirmAscendedSchoolFormula(crawl.db, [key], true)).toThrow(
        SchoolFormulaConfirmationError,
      );
      expect(loadAscendedSchoolFormulaConfirmations(crawl.db)).toEqual({});
    });
  });
  it.each(["missing", "mismatch"])("当前合同%s身份使旧确认不适用且保留审计行", (kind) => {
    memory((crawl) => {
      const record = currentAscendedRecord();
      persist(crawl, record);
      confirmAscendedSchoolFormula(crawl.db, [key], true);
      const before = crawl.db.prepare("SELECT * FROM analysis_school_formula_confirmations").all();
      record.detail!.valuation!.source =
        kind === "missing" ? {} : { serverId: "367", eid: "foreign-role" };
      crawl.db
        .prepare("UPDATE listings SET detail_json=? WHERE key=?")
        .run(JSON.stringify(record.detail), key);
      expect(loadAscendedSchoolFormulaConfirmations(crawl.db)).toEqual({});
      expect(crawl.db.prepare("SELECT * FROM analysis_school_formula_confirmations").all()).toEqual(
        before,
      );
    });
  });
  it("预期校验使用固定错误类型，内部数据库错误原样抛出", () => {
    memory((crawl) => {
      persist(crawl, ascendedRecord());
      expect(() => confirmAscendedSchoolFormula(crawl.db, [key], false)).toThrow(
        SchoolFormulaConfirmationError,
      );
      confirmAscendedSchoolFormula(crawl.db, [key], true);
      const prepare = crawl.db.prepare.bind(crawl.db);
      const sqlError = new Error("模拟内部SQL故障");
      const spy = vi.spyOn(crawl.db, "prepare").mockImplementation((sql) => {
        if (sql.startsWith("SELECT listing_json")) throw sqlError;
        return prepare(sql);
      });
      try {
        expect(() => confirmAscendedSchoolFormula(crawl.db, [key], true)).toThrow(sqlError);
        expect(() => loadAscendedSchoolFormulaConfirmations(crawl.db)).toThrow(sqlError);
      } finally {
        spy.mockRestore();
      }
    });
  });
  it("严格记录用户确认及当前最高五项，加载profile按角色应用，hash不受无关确认影响", () => {
    memory((crawl) => {
      const record = ascendedRecord();
      persist(crawl, record);
      const before = loadProfile(crawl.db);
      const receipt = confirmAscendedSchoolFormula(
        crawl.db,
        [key],
        true,
        "用户确认：按原公式，不封顶",
      );
      expect(receipt).toMatchObject({
        confirmed: 1,
        productKeys: [key],
        confirmations: [
          {
            listingKey: key,
            levels: [154, 150, 150, 130, 130],
            note: "用户确认：按原公式，不封顶",
          },
        ],
      });
      expect(Number.isFinite(Date.parse(receipt.confirmations[0].confirmedAt))).toBe(true);
      const current = loadProfile(crawl.db);
      expect(current.hash).toBe(before.hash);
      expect(current.ascendedSchoolFormulaConfirmations).toEqual({
        [key]: [154, 150, 150, 130, 130],
      });
      const result = calculateValuation(record, current);
      expect(result.pending_rules).not.toContain("飞升师门技能公式出现反常溢价，需核实适用范围");
      expect(result.items.find((item) => item.name === "师门技能")?.amount).toBeCloseTo(16.36);
    });
  });

  it.each([false, undefined, "true", 1, { levels: [154, 150, 150, 130, 130] }])(
    "不接受非明确确认：%s",
    (confirmation) => {
      memory((crawl) => {
        persist(crawl, ascendedRecord());
        expect(() => confirmAscendedSchoolFormula(crawl.db, [key], confirmation)).toThrow(
          "明确确认",
        );
        expect(loadAscendedSchoolFormulaConfirmations(crawl.db)).toEqual({});
      });
    },
  );

  it.each([
    [],
    [key, key],
    Array.from({ length: 51 }, (_, i) => `367:key-${i}`),
    ["invalid"],
    [null],
    key,
  ])("不接受无效商品范围：%j", (keys) => {
    memory((crawl) => {
      expect(() => confirmAscendedSchoolFormula(crawl.db, keys, true)).toThrow("商品标识");
      expect(loadAscendedSchoolFormulaConfirmations(crawl.db)).toEqual({});
    });
  });

  it.each([null, "", "   ", "字".repeat(1001)])("不接受无效确认说明：%s", (note) => {
    memory((crawl) => {
      persist(crawl, ascendedRecord());
      expect(() => confirmAscendedSchoolFormula(crawl.db, [key], true, note)).toThrow("确认说明");
      expect(loadAscendedSchoolFormulaConfirmations(crawl.db)).toEqual({});
    });
  });

  it.each([
    "pending",
    "failed",
    "missing-detail",
    "incomplete",
    "not-ascended",
    "conflicting-state",
    "six-skills",
    "duplicate-skill",
    "unknown-level",
    "duplicate-tab",
  ])("拒绝未完整或不明确资料：%s", (kind) => {
    memory((crawl) => {
      const record = ascendedRecord();
      persist(crawl, record);
      const detail = record.detail!;
      if (kind === "not-ascended")
        detail.tabs[0].fields.find((field) => field.name === "飞升/渡劫/化圣")!.value = "未飞升";
      if (kind === "conflicting-state")
        detail.tabs[0].fields.push({ name: "飞升/渡劫/化圣", value: "渡劫" });
      if (kind === "six-skills") detail.tabs[1].items!.splice(0, 1);
      if (kind === "duplicate-skill") detail.tabs[1].items![0].name = detail.tabs[1].items![1].name;
      if (kind === "unknown-level") detail.tabs[1].items![0].level = "未知";
      if (kind === "duplicate-tab") detail.tabs.push(structuredClone(detail.tabs[1]));
      if (kind === "incomplete") detail.petCapture!.complete = false;
      crawl.db
        .prepare("UPDATE listings SET status=?,detail_json=? WHERE key=?")
        .run(
          ["pending", "failed"].includes(kind) ? kind : "complete",
          kind === "missing-detail" ? null : JSON.stringify(detail),
          key,
        );
      expect(() => confirmAscendedSchoolFormula(crawl.db, [key], true)).toThrow();
      expect(loadAscendedSchoolFormulaConfirmations(crawl.db)).toEqual({});
    });
  });

  it("批量确认原子提交，未采集或拒绝项不留下部分确认", () => {
    memory((crawl) => {
      persist(crawl, ascendedRecord());
      expect(() => confirmAscendedSchoolFormula(crawl.db, [key, "367:not-captured"], true)).toThrow(
        "尚未完整采集",
      );
      expect(loadAscendedSchoolFormulaConfirmations(crawl.db)).toEqual({});
    });
  });

  it.each([
    "{bad",
    "null",
    "{}",
    "[154,150,150,130]",
    "[154,150,150,130,130,125]",
    '[154,150,"150",130,130]',
    "[154,150,150,130,-1]",
    "[154,150,150,130,130.5]",
    "[1e309,150,150,130,130]",
    "[150,154,150,130,130]",
  ])("确认表内部等级数据损坏必须报内部错误：%s", (saved) => {
    memory((crawl) => {
      persist(crawl, ascendedRecord());
      confirmAscendedSchoolFormula(crawl.db, [key], true);
      crawl.db.prepare("UPDATE analysis_school_formula_confirmations SET levels_json=?").run(saved);
      expect(() => loadAscendedSchoolFormulaConfirmations(crawl.db)).toThrow();
      try {
        loadAscendedSchoolFormulaConfirmations(crawl.db);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(SchoolFormulaConfirmationError);
      }
      expect(() => loadProfile(crawl.db)).toThrow();
    });
  });

  it("等级JSON按结构读取，排版变化有效，合法但不同等级仅视为确认不适用", () => {
    memory((crawl) => {
      persist(crawl, ascendedRecord());
      confirmAscendedSchoolFormula(crawl.db, [key], true);
      const update = crawl.db.prepare(
        "UPDATE analysis_school_formula_confirmations SET levels_json=?",
      );
      update.run("[154, 150, 150, 130, 130]");
      expect(loadAscendedSchoolFormulaConfirmations(crawl.db)).toEqual({
        [key]: [154, 150, 150, 130, 130],
      });
      update.run("[155,150,150,130,130]");
      expect(loadAscendedSchoolFormulaConfirmations(crawl.db)).toEqual({});
    });
  });

  it("最高五项变化时保留审计行但不应用旧确认，且不会确认尚未见过的角色", () => {
    memory((crawl) => {
      const record = ascendedRecord();
      persist(crawl, record);
      confirmAscendedSchoolFormula(crawl.db, [key], true);
      persist(crawl, ascendedRecord("367:new-role"));
      expect(loadAscendedSchoolFormulaConfirmations(crawl.db)).toEqual({
        [key]: [154, 150, 150, 130, 130],
      });
      record.detail!.tabs[1].items![1].level = "155";
      crawl.save(record.listing, record.detail!);
      expect(loadAscendedSchoolFormulaConfirmations(crawl.db)).toEqual({});
      expect(
        crawl.db.prepare("SELECT levels_json FROM analysis_school_formula_confirmations").get()!
          .levels_json,
      ).toBe("[154,150,150,130,130]");
      expect(calculateValuation(record, loadProfile(crawl.db)).pending_rules).toContain(
        "飞升师门技能公式出现反常溢价，需核实适用范围",
      );
    });
  });

  it("确认不改旧批次、任务、请求、结果和响应，其他角色的规则仍相同", () => {
    memory((crawl) => {
      const record = ascendedRecord();
      persist(crawl, record);
      persist(crawl, ascendedRecord("367:school-b"));
      const beforeProfile = loadProfile(crawl.db);
      const analysis = new AnalysisStore(crawl.db);
      const id = analysis.createRun("codex", "fixture-model", true, beforeProfile);
      expect(analysis.acquire("fixture-owner")).toBe(true);
      const task = analysis.next(id)!;
      const attempt = analysis.begin(task, "fixture-owner");
      const result = { ...analysisResponse(record), score: 80 };
      analysis.finish(task, attempt, "fixture-owner", {
        state: "completed",
        result,
        raw: JSON.stringify(result),
        usage: { simulated: true },
      });
      const frozen = ["analysis_runs", "analysis_tasks", "analysis_attempts"].map((table) =>
        crawl.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
      );

      confirmAscendedSchoolFormula(crawl.db, [key], true);

      expect(
        ["analysis_runs", "analysis_tasks", "analysis_attempts"].map((table) =>
          crawl.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
        ),
      ).toEqual(frozen);
      const profile = loadProfile(crawl.db);
      expect(analysis.detail(task.id, profile)?.profileChanged).toBe(true);
      const other = crawl.db
        .prepare("SELECT id FROM analysis_tasks WHERE listing_key=?")
        .get("367:school-b")!;
      expect(analysis.detail(String(other.id), profile)?.profileChanged).toBe(false);
    });
  });
});
