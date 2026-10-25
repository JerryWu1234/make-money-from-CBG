import { describe, expect, it } from "vite-plus/test";
import { compactDetail } from "./compact";
import { CrawlStore } from "./store";
import { AnalysisStore } from "../analysis/store";
import { analysisRecord, analysisResponse } from "../../tests/fixtures/analysis";
import type { DetailItem, RoleDetail, TabSnapshot } from "./types";

const schoolPairs = [
  ["154", "九转玄功"],
  ["164", "武神显圣"],
  ["161", "啸傲"],
  ["164", "气吞山河"],
  ["164", "诛魔"],
  ["164", "天地无极"],
  ["164", "法天象地"],
];
function fixture(formatVersion?: number): RoleDetail {
  const items: DetailItem[] = schoolPairs
    .filter(([, name]) => name !== "武神显圣")
    .map(([level, name], index) => ({
      index,
      name,
      kind: "skill",
      category: "师门技能",
      level,
    }));
  items.push({ index: 6, name: "强身术", level: "140", kind: "skill", category: "技能" });
  return {
    ...(formatVersion === undefined ? {} : { formatVersion }),
    url: "https://xyq.cbg.163.com/equip?s=689&eid=202604221400113-689-RE04GPTYNFCB",
    collectedAt: "2026-10-24T02:44:25.635Z",
    raw: {},
    tabs: [
      {
        name: "技能",
        text: `师门技能\n\n${schoolPairs.flat().join("\n\n")}\n生活技能\n\n140\n\n强身术\n剧情技能`,
        fields: [],
        tables: [],
        elements: [],
        tooltips: [],
        items,
      },
    ],
  };
}
const schoolItems = (tab: TabSnapshot) => tab.items!.filter((item) => item.category === "师门技能");

describe("师门技能原文与图标校核", () => {
  it.each([undefined, 3])("原始七对文字可补齐689漏读的一项，格式版本%s", (version) => {
    const detail = fixture(version);
    const original = structuredClone(detail);
    const result = compactDetail(detail);
    expect(schoolItems(result.tabs[0])).toHaveLength(7);
    expect(result.tabs[0].items!.find((item) => item.name === "武神显圣")).toEqual({
      index: 7,
      name: "武神显圣",
      level: "164",
      kind: "skill",
      category: "师门技能",
    });
    expect(result.tabs[0].items!.slice(0, 7)).toEqual(original.tabs[0].items);
    expect(result.tabs[0].text).toBe(original.tabs[0].text);
    expect(detail).toEqual(original);
    expect(compactDetail(result)).toBe(result);
  });

  it("已有七项原样保留，不改生活技能、不追加重复项", () => {
    const detail = fixture(3);
    detail.tabs[0].items!.push({
      index: 7,
      name: "武神显圣",
      level: "164",
      kind: "skill",
      category: "师门技能",
    });
    expect(compactDetail(detail)).toBe(detail);
  });

  it("补正当前采集不覆盖旧分析冻结输入、请求、结果与响应", () => {
    const crawl = new CrawlStore(":memory:");
    try {
      const record = analysisRecord("school-frozen");
      record.detail!.tabs = fixture(3).tabs;
      crawl.observe(record.listing);
      crawl.save(record.listing, record.detail!);
      // Simulate a six-item snapshot saved before this parser fix.
      crawl.db
        .prepare("UPDATE listings SET detail_json=? WHERE key=?")
        .run(JSON.stringify(record.detail), record.listing.key);
      const analysis = new AnalysisStore(crawl.db);
      const run = analysis.createRun("codex", "fixture-model", true, undefined, true);
      const task = analysis.next(run)!;
      expect(analysis.acquire("fixture-owner")).toBe(true);
      const attempt = analysis.begin(task, "fixture-owner");
      const result = { ...analysisResponse(record), score: 80 };
      analysis.finish(task, attempt, "fixture-owner", {
        state: "completed",
        result,
        raw: JSON.stringify(result),
        usage: { simulated: true },
      });
      const taskBefore = crawl.db.prepare("SELECT * FROM analysis_tasks WHERE id=?").get(task.id);
      const attemptsBefore = crawl.db.prepare("SELECT * FROM analysis_attempts").all();

      crawl.save(record.listing, record.detail!);

      const current = JSON.parse(
        String(crawl.db.prepare("SELECT detail_json FROM listings").get()!.detail_json),
      ) as RoleDetail;
      expect(schoolItems(current.tabs[0])).toHaveLength(7);
      expect(crawl.db.prepare("SELECT * FROM analysis_tasks WHERE id=?").get(task.id)).toEqual(
        taskBefore,
      );
      expect(crawl.db.prepare("SELECT * FROM analysis_attempts").all()).toEqual(attemptsBefore);
      expect(schoolItems(record.detail!.tabs[0])).toHaveLength(6);
    } finally {
      crawl.close();
    }
  });

  it.each([
    "wrong-level",
    "wrong-name",
    "duplicate-existing",
    "duplicate-text-name",
    "missing-school-header",
    "missing-life-header",
    "duplicate-school-header",
    "duplicate-life-header",
    "six-pairs",
    "eight-pairs",
    "ambiguous-pair",
    "other-tab",
  ])("不歧义的原文或对应关系未成立时不补：%s", (kind) => {
    const detail = fixture(3);
    const tab = detail.tabs[0];
    if (kind === "wrong-level") tab.items![0].level = "153";
    if (kind === "wrong-name") tab.items![0].name = "另一技能";
    if (kind === "duplicate-existing") tab.items!.push({ ...tab.items![0], index: 7 });
    if (kind === "duplicate-text-name") tab.text = tab.text.replace("武神显圣", "九转玄功");
    if (kind === "missing-school-header") tab.text = tab.text.replace("师门技能\n", "");
    if (kind === "missing-life-header") tab.text = tab.text.replace("生活技能\n", "");
    if (kind === "duplicate-school-header") tab.text = "师门技能\n" + tab.text;
    if (kind === "duplicate-life-header") tab.text += "\n生活技能";
    if (kind === "six-pairs") tab.text = tab.text.replace("164\n\n武神显圣\n\n", "");
    if (kind === "eight-pairs")
      tab.text = tab.text.replace("生活技能", "160\n\n其他技能\n生活技能");
    if (kind === "ambiguous-pair") tab.text = tab.text.replace("武神显圣", "武神显圣：164");
    if (kind === "other-tab") tab.name = "召唤兽/孩子";
    const before = structuredClone(detail);
    expect(compactDetail(detail)).toBe(detail);
    expect(detail).toEqual(before);
  });
});
