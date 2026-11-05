import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vite-plus/test";
import { analysisRecord } from "../../tests/fixtures/analysis";
import { schoolPrice } from "../analysis/valuation-calculator";
import { captureIssues, collectCompleteCapture } from "./capture-readiness";
import { CAPTURE_VERSION, compactDetail } from "./compact";
import { schoolSkillsComplete } from "./school-skills";
import { CrawlStore } from "./store";
import type { RoleDetail, SavedRoleRecord, TabSnapshot } from "./types";

type SchoolSkill = { id: string; name: string; level: number; slot: number };

// Saved failure 299/26667428 supplied these five skills in both the page and raw
// all_skills. Two official layout slots were empty; they are not observed zeros.
const fiveSkills: SchoolSkill[] = [
  { id: "71", name: "天罡气", level: 86, slot: 1 },
  { id: "72", name: "清明自在", level: 86, slot: 2 },
  { id: "73", name: "宁气诀", level: 86, slot: 3 },
  { id: "74", name: "乾坤塔", level: 86, slot: 4 },
  { id: "76", name: "云霄步", level: 86, slot: 7 },
];
const sevenSkills: SchoolSkill[] = [
  ...fiveSkills,
  { id: "75", name: "混天术", level: 86, slot: 5 },
  { id: "77", name: "傲世诀", level: 86, slot: 6 },
];

function schoolTab(skills = fiveSkills): TabSnapshot {
  return {
    name: "技能",
    text:
      "师门技能\n\n" +
      skills.flatMap(({ name, level }) => [String(level), name]).join("\n\n") +
      "\n生活技能\n\n36\n\n健身术\n剧情技能\n无",
    fields: [],
    tables: [],
    elements: [],
    tooltips: [],
    items: [
      ...skills.map(({ name, level, slot }) => ({
        index: slot - 1,
        name,
        level: String(level),
        kind: "skill" as const,
        category: "师门技能",
      })),
      { index: 7, name: "健身术", level: "36", kind: "skill", category: "技能" },
    ],
  };
}

function source(skills = fiveSkills): Record<string, unknown> {
  return {
    serverId: "367",
    eid: "item-sparse-school",
    allSkills: { ...Object.fromEntries(skills.map(({ id, level }) => [id, level])), 212: 36 },
    schoolSkills: structuredClone(skills),
  };
}

function record(): SavedRoleRecord {
  const saved = analysisRecord("sparse-school");
  const detail = saved.detail!;
  delete detail.formatVersion;
  detail.captureMode = "all";
  detail.captureVersion = CAPTURE_VERSION;
  detail.raw = { encodedRoleData: "synthetic sparse-school source" };
  detail.valuation = { version: 1, fields: [], issues: [], source: source() };
  detail.equipmentCapture!.emptyProof = "explicit-text";
  detail.tabs = detail.tabs.map((tab) => (tab.name === "技能" ? schoolTab() : tab));
  return saved;
}

describe("原始技能证明的师门空槽", () => {
  it.each([1, 2, 3, 4, 5, 6])("源、图标和原文一致的%d项可采集，不补空槽等级", (count) => {
    const skills = sevenSkills.slice(0, count);
    const tab = schoolTab(skills);
    const evidence = source(skills);
    const before = structuredClone({ tab, evidence });
    expect(schoolSkillsComplete([tab], evidence)).toBe(true);
    expect({ tab, evidence }).toEqual(before);
    expect(tab.items!.filter((item) => item.category === "师门技能")).toHaveLength(count);
  });

  it("明确零级仍为实际技能，空槽不生成零级技能", () => {
    const skills = structuredClone(fiveSkills);
    skills[0].level = 0;
    expect(schoolSkillsComplete([schoolTab(skills)], source(skills))).toBe(true);
    expect(schoolTab(skills).items!.filter((item) => item.category === "师门技能")).toHaveLength(5);
  });

  it("没有官方师门证据的五项仍失败，旧七项记录仍兼容", () => {
    expect(schoolSkillsComplete([schoolTab()])).toBe(false);
    expect(schoolSkillsComplete([schoolTab()], { allSkills: source().allSkills })).toBe(false);
    expect(schoolSkillsComplete([schoolTab(sevenSkills)])).toBe(true);
  });

  it("源有七项而页面只读五项时不能当空槽放过", () => {
    expect(schoolSkillsComplete([schoolTab()], source(sevenSkills))).toBe(false);
  });

  it("页面七项与源五项冲突时不回退旧七项规则", () => {
    expect(schoolSkillsComplete([schoolTab(sevenSkills)], source())).toBe(false);
  });

  it.each([
    "level",
    "name",
    "missing-pair",
    "extra-pair",
    "missing-school-header",
    "duplicate-school-header",
    "missing-life-header",
    "duplicate-life-header",
  ])("原文与源、图标不一致时拒绝：%s", (kind) => {
    const tab = schoolTab();
    if (kind === "level") tab.text = tab.text.replace("86", "85");
    if (kind === "name") tab.text = tab.text.replace("天罡气", "其他技能");
    if (kind === "missing-pair") tab.text = tab.text.replace("86\n\n云霄步", "");
    if (kind === "extra-pair") tab.text = tab.text.replace("生活技能", "86\n\n混天术\n生活技能");
    if (kind === "missing-school-header") tab.text = tab.text.replace("师门技能", "");
    if (kind === "duplicate-school-header") tab.text = "师门技能\n" + tab.text;
    if (kind === "missing-life-header") tab.text = tab.text.replace("生活技能", "");
    if (kind === "duplicate-life-header") tab.text += "\n生活技能";
    expect(schoolSkillsComplete([tab], source())).toBe(false);
  });

  it.each([
    "duplicate-name",
    "missing-level",
    "fractional-level",
    "negative-level",
    "wrong-level",
    "wrong-kind",
  ])("图标资料异常时拒绝：%s", (kind) => {
    const tab = schoolTab();
    const item = tab.items![0];
    if (kind === "duplicate-name") item.name = tab.items![1].name;
    if (kind === "missing-level") delete item.level;
    if (kind === "fractional-level") item.level = "86.5";
    if (kind === "negative-level") item.level = "-1";
    if (kind === "wrong-level") item.level = "85";
    if (kind === "wrong-kind") item.kind = "equipment";
    expect(schoolSkillsComplete([tab], source())).toBe(false);
  });

  it.each([
    "missing-all-skills",
    "missing-source-id",
    "wrong-raw-level",
    "string-raw-level",
    "duplicate-id",
    "duplicate-name",
    "duplicate-slot",
    "blank-name",
    "invalid-id",
    "zero-slot",
    "eighth-slot",
    "fractional-slot",
    "negative-level",
    "fractional-level",
    "string-level",
    "unsafe-level",
    "empty-evidence",
    "non-array-evidence",
  ])("官方证据缺失、歧义或与原始等级冲突时拒绝：%s", (kind) => {
    const evidence = source();
    const skills = evidence.schoolSkills as SchoolSkill[];
    const all = evidence.allSkills as Record<string, unknown>;
    if (kind === "missing-all-skills") delete evidence.allSkills;
    if (kind === "missing-source-id") delete all[skills[0].id];
    if (kind === "wrong-raw-level") all[skills[0].id] = 85;
    if (kind === "string-raw-level") all[skills[0].id] = "86";
    if (kind === "duplicate-id") skills[0].id = skills[1].id;
    if (kind === "duplicate-name") skills[0].name = skills[1].name;
    if (kind === "duplicate-slot") skills[0].slot = skills[1].slot;
    if (kind === "blank-name") skills[0].name = " ";
    if (kind === "invalid-id") skills[0].id = "not-a-skill";
    if (kind === "zero-slot") skills[0].slot = 0;
    if (kind === "eighth-slot") skills[0].slot = 8;
    if (kind === "fractional-slot") skills[0].slot = 1.5;
    if (kind === "negative-level") skills[0].level = -1;
    if (kind === "fractional-level") skills[0].level = 86.5;
    if (kind === "string-level") Object.assign(skills[0], { level: "86" });
    if (kind === "unsafe-level") skills[0].level = Number.MAX_SAFE_INTEGER + 1;
    if (kind === "empty-evidence") evidence.schoolSkills = [];
    if (kind === "non-array-evidence") evidence.schoolSkills = {};
    expect(schoolSkillsComplete([schoolTab()], evidence)).toBe(false);
  });

  it("有新证据但证据异常的七项也必须失败", () => {
    const evidence = source(sevenSkills);
    (evidence.schoolSkills as SchoolSkill[])[0].slot = 0;
    expect(schoolSkillsComplete([schoolTab(sevenSkills)], evidence)).toBe(false);
  });

  it("空证据和空技能区不能冒充明确的空技能证明", () => {
    expect(schoolSkillsComplete([schoolTab([])], source([]))).toBe(false);
  });

  it("技能标签缺失或重复时不发布完整资料", () => {
    expect(schoolSkillsComplete([], source())).toBe(false);
    expect(schoolSkillsComplete([schoolTab(), schoolTab()], source())).toBe(false);
  });

  it("五项证据可通过采集、压缩与存储，原始来源仍单独归档", async () => {
    const saved = record();
    const detail = saved.detail!;
    const original = structuredClone(detail);
    const read = vi.fn().mockResolvedValue(detail);
    const result = await collectCompleteCapture(
      read,
      new AbortController().signal,
      vi.fn(),
      saved.listing,
    );
    expect(read).toHaveBeenCalledOnce();
    expect(captureIssues(result, true, true, saved.listing)).toEqual([]);
    expect(result).toEqual(original);
    const compact = compactDetail(result);
    expect(compact.valuation!.source).toEqual(detail.valuation!.source);
    expect(compact.tabs.find((tab) => tab.name === "技能")!.items).toHaveLength(6);

    const store = new CrawlStore(":memory:");
    try {
      store.observe(saved.listing);
      expect(store.save(saved.listing, result)).toBe(true);
      const persisted = store.detail(saved.listing.key) as SavedRoleRecord;
      expect(persisted.status).toBe("complete");
      expect(persisted.error).toBeNull();
      expect(persisted.detail!.valuation!.source).toEqual(detail.valuation!.source);
      const archived = store.db
        .prepare("SELECT source_gzip FROM role_sources WHERE listing_key=?")
        .get(saved.listing.key)!;
      const sourceDetail = JSON.parse(
        gunzipSync(archived.source_gzip as Uint8Array).toString(),
      ) as RoleDetail;
      expect(sourceDetail).toEqual(original);
    } finally {
      store.close();
    }
  });

  it("其他商品的五项源证据不得保存为当前商品的完整资料", () => {
    const saved = record();
    saved.detail!.valuation!.source.eid = "another-role";
    expect(captureIssues(saved.detail!, true, true, saved.listing).join("；")).toContain("身份");
    const store = new CrawlStore(":memory:");
    try {
      store.observe(saved.listing);
      expect(store.save(saved.listing, saved.detail!)).toBe(false);
      expect((store.detail(saved.listing.key) as SavedRoleRecord).status).toBe("failed");
    } finally {
      store.close();
    }
  });

  it.each(["未飞升", "已飞升", "已渡劫", "已化圣"])(
    "五项可采集不等于七项金额已知，%s师门报价仍未知",
    (state) => {
      expect(
        schoolPrice(
          fiveSkills.map(({ level }) => level),
          state,
          true,
        ),
      ).toBeNull();
    },
  );
});
