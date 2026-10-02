import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vite-plus/test";
import { analysisRecord } from "../../tests/fixtures/analysis";
import { CrawlStore } from "../crawler/store";
import { AnalysisStore } from "./store";
import { AnalysisRunner } from "./runner";
import {
  createProfile,
  DEFAULT_SETTINGS,
  loadProfile,
  normalizeSettings,
  PROMPT_FILE,
  saveProfile,
} from "./profile";
import {
  artifactPrice,
  calculateValuation,
  floorPrice,
  mountPrice,
  opportunityPrice,
  purchase,
  schoolPrice,
  strengthPrice,
  trainingPrice,
} from "./valuation-calculator";
import { buildProductDocument } from "./product-document";
import { validateValuation, valuationPrompt } from "./valuation-contract";
const template = readFileSync(PROMPT_FILE, "utf8");
function completeRecord() {
  const record = analysisRecord("a");
  record.listing.price = "500.00";
  record.listing.summary = { iCash: 0, iSaving: 0, xianyu: 0 };
  const fields = {
    "飞升/渡劫/化圣": "未飞升",
    级别: "109",
    攻击修炼: "20/25",
    法术修炼: "0/25",
    防御修炼: "17/25",
    抗法修炼: "10/25",
    攻击控制力: "20",
    法术控制力: "20",
    防御控制力: "20",
    抗法控制力: "20",
    靓号特效: "否",
    月饼粽子机缘: "40/69",
    神器套数: "0",
    坐骑总数: "0",
    储备金: "0",
  };
  record.detail!.tabs = [
    {
      name: "人物/修炼",
      text: "",
      fields: Object.entries(fields).map(([name, value]) => ({ name, value })),
      tables: [],
      elements: [],
      tooltips: [],
    },
    {
      name: "技能",
      text: "",
      fields: [],
      tables: [],
      elements: [],
      tooltips: [],
      items: [
        ...Array.from({ length: 7 }, (_, i) => ({
          index: i,
          kind: "skill" as const,
          category: "师门技能",
          name: "师门" + i,
          level: "119",
        })),
        { index: 7, kind: "skill", category: "技能", name: "强壮", level: "0" },
        { index: 8, kind: "skill", category: "技能", name: "神速", level: "0" },
      ],
    },
  ];
  return record;
}
const profile = () =>
  createProfile(template, {
    ...DEFAULT_SETTINGS,
    b: 0.8,
    extraCost: 0,
    capMode: "both",
    servers: [
      {
        serverId: completeRecord().listing.serverId,
        age: "three",
        rank: 10,
        goldPrice: null,
        goldUnit: null,
      },
    ],
  });
describe("裸号估值的复算与可追溯输入", () => {
  it("不提前舍入、不给1—4级插值、强壮口径分别计算", () => {
    expect(trainingPrice(6, "defense")).toBe(50 / 1.5);
    expect(trainingPrice(17, "defense")).toBe(230);
    expect(trainingPrice(4, "petAttack")).toBeNull();
    expect(trainingPrice(0, "petAttack")).toBe(0);
    expect(strengthPrice(2, "single")).toBe(8 / 270);
    expect(strengthPrice(2, "cumulative")).toBe(9 / 270);
    expect(schoolPrice([180, 180, 180, 180, 180, 180, 180], "已化圣", false)).toBeCloseTo(
      4814.86,
      2,
    );
    expect(schoolPrice([160, 130, 130, 130, 130, 130, 130], "未飞升", false)).toBeNull();
    expect(schoolPrice([160, 160, 160, 160, 160, 160, 160], "已飞升", false)).toBeGreaterThan(250);
  });
  it("机缘负向扣分只用完整基数，69级差异不自动择一", () => {
    expect(opportunityPrice(69, 7, 2000, null)).toBe(-132);
    expect(opportunityPrice(69, 7, null, "formula")).toBeNull();
    expect(opportunityPrice(69, 55, 2000, null)).toBeNull();
    expect(opportunityPrice(69, 55, 2000, "formula")).toBe(150);
    expect(opportunityPrice(69, 55, 2000, "discrete")).toBe(180);
    expect(opportunityPrice(69, 56, 2000, "discrete")).toBeNull();
  });
  it("神器先选最高套，坐骑边界不默认，高价向下取分", () => {
    expect(
      artifactPrice([
        { full: true, type: "十二火", score: 91 },
        { full: true, type: "十二水", score: 91 },
      ]),
    ).toBe(1900);
    expect(artifactPrice([{ full: null, type: "十二水", score: 91 }])).toBeNull();
    expect(mountPrice(2.35, true, 70, null)).toBeNull();
    expect(mountPrice(2.35, true, 70, "lower")).toBe(100);
    expect(mountPrice(2.35, true, 70, "upper")).toBe(200);
    expect(mountPrice(2.35, true, 95, null)).toBe(775);
    expect(floorPrice(123.459)).toBe(123.45);
    expect(purchase(1000, 801, { ...DEFAULT_SETTINGS, b: 0.8, extraCost: 0 }).decision).toBe(
      "WATCH",
    );
    expect(purchase(1000, 1001, { ...DEFAULT_SETTINGS, b: 0.8, extraCost: 0 }).decision).toBe(
      "PASS",
    );
  });
  it("完整条件可BUY；原文缺失、未覆盖上限和未知费用保留待确认", () => {
    const record = completeRecord(),
      configured = profile();
    const full = calculateValuation(record, configured);
    expect(full.decision).toBe("BUY");
    expect(full.model_value).toBeGreaterThan(4000);
    const field = record.detail!.tabs[0].fields.find((item) => item.name === "防御修炼")!;
    field.value = "17/20";
    const partial = calculateValuation(record, configured);
    expect(partial.decision).toBe("NEED_INFO");
    expect(partial.model_value).toBeNull();
    expect(partial.items.find((item) => item.name === "防御修炼")?.amount).toBe(230);
    expect(partial.items.find((item) => item.name === "防御修炼上限")?.amount).toBeNull();
    const noFees = calculateValuation(
      completeRecord(),
      createProfile(template, { ...configured.settings, extraCost: null }),
    );
    expect(noFees.decision).toBe("NEED_INFO");
    expect(noFees.total_cost).toBeNull();
    expect(noFees.model_value).not.toBeNull();
  });
  it("已采集储备字段映射为储备金，缺金价只留金额待确认", () => {
    const record = completeRecord(),
      configured = profile();
    const field = record.detail!.tabs[0].fields.find((item) => item.name === "储备金")!;
    field.name = "储备";
    field.value = "1947803";
    const result = calculateValuation(record, configured),
      asset = result.items.find((item) => item.name === "储备金")!;
    expect(asset.input).toBe("1947803");
    expect(asset.amount).toBeNull();
    expect(asset.evidence[0].value).toBe("1947803");
  });
  it("执行中参数修改不影响已冻结批次，校验重试保存实际请求", async () => {
    const crawl = new CrawlStore(":memory:"),
      record = completeRecord(),
      configured = profile();
    crawl.observe(record.listing);
    crawl.save(record.listing, record.detail!);
    const expected = calculateValuation(record, configured),
      store = new AnalysisStore(crawl.db);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const analyze = vi
      .fn()
      .mockImplementationOnce(async () => {
        await wait;
        return { text: JSON.stringify({ ...expected, model_value: 1 }) };
      })
      .mockResolvedValue({ text: JSON.stringify(expected) });
    const runner = new AnalysisRunner(store, async () => ({ model: "test", analyze }));
    try {
      const id = await runner.start("codex", true, configured, true);
      configured.settings.b = 0.01;
      configured.template = "下一批的新规则";
      release();
      await runner.settled();
      expect(store.run(id)?.completed).toBe(1);
      const detail = store.detail(store.overview({ runId: id }).records.items[0].taskId!)!;
      expect(detail.profile?.settings.b).toBe(0.8);
      expect(detail.profile?.template).toBe(template);
      expect(detail.attempts).toHaveLength(2);
      expect(detail.attempts[1].requestText).toContain("上次输出校验未通过");
      expect(detail.attempts[1].requestText).toBe(analyze.mock.calls[1][0]);
      expect(detail.attempts[1].requestHash).not.toBe(detail.promptHash);
      expect(detail.result?.valuation?.decision).toBe("BUY");
    } finally {
      await runner.shutdown();
      crawl.db.close();
    }
  });
  it("完整原文只出现一次，金额严格复算；AI改写待确认项时保留程序完整列表", () => {
    const record = completeRecord(),
      configured = profile(),
      doc = buildProductDocument(record);
    const prompt = valuationPrompt(doc, record, configured);
    expect(prompt.startsWith(template)).toBe(true);
    expect(prompt.split(doc.text)).toHaveLength(2);
    const computed = calculateValuation(record, configured);
    const result = validateValuation(JSON.stringify(computed), doc, record, configured);
    expect(result.valuation?.decision).toBe("BUY");
    expect(() =>
      validateValuation(
        JSON.stringify({ ...computed, model_value: computed.model_value! + 1 }),
        doc,
        record,
        configured,
      ),
    ).toThrow("核算不一致");
    const pendingProfile = createProfile(template),
      pending = calculateValuation(record, pendingProfile);
    for (const wording of [
      { missing_fields: ["买入系数 b、总费用 F 尚未提供"], pending_rules: ["计价口径需确认"] },
      { missing_fields: [], pending_rules: [] },
    ]) {
      const preserved = validateValuation(
        JSON.stringify({ ...pending, ...wording }),
        doc,
        record,
        pendingProfile,
      );
      expect(preserved.valuation?.decision).toBe("NEED_INFO");
      expect(preserved.valuation?.model_value).toBeNull();
      expect(preserved.valuation?.missing_fields).toEqual(pending.missing_fields);
      expect(preserved.valuation?.pending_rules).toEqual(pending.pending_rules);
      expect(preserved.missingData).toEqual([...pending.missing_fields, ...pending.pending_rules]);
    }
  });
  it("修改价格会停用旧算法，说明修改可直接生效；参数不偷设默认值", () => {
    expect(createProfile(template).calculationCompatible).toBe(true);
    expect(createProfile(template + "\n请简洁解释。").calculationCompatible).toBe(true);
    const changed = createProfile(template.replace("| 未飞升 | 0 元 |", "| 未飞升 | 10 元 |"));
    expect(changed.calculationCompatible).toBe(false);
    expect(calculateValuation(completeRecord(), changed).model_value).toBeNull();
    expect(normalizeSettings({})).toMatchObject({ b: null, extraCost: null });
    expect(normalizeSettings({ extraCost: 0, budget: 0 })).toMatchObject({
      extraCost: 0,
      budget: 0,
    });
    expect(() => normalizeSettings({ b: 0.8, a: 0.9 })).toThrow("0 < a ≤ b");
  });
  it("保存设置防止覆盖并持久化，保留原Prompt逐字内容", () => {
    const directory = mkdtempSync(join(tmpdir(), "cbg-profile-")),
      file = join(directory, "prompt.md"),
      crawl = new CrawlStore(":memory:");
    try {
      writeFileSync(file, template);
      const before = loadProfile(crawl.db, file);
      const saved = saveProfile(
        crawl.db,
        {
          template,
          settings: { ...DEFAULT_SETTINGS, b: 0.75, extraCost: 0 },
          baseHash: before.hash,
        },
        file,
      );
      expect(readFileSync(file, "utf8")).toBe(template);
      expect(loadProfile(crawl.db, file).hash).toBe(saved.hash);
      expect(() =>
        saveProfile(
          crawl.db,
          { template: template + "过时修改", settings: {}, baseHash: before.hash },
          file,
        ),
      ).toThrow("已被修改");
      expect(readFileSync(file, "utf8")).toBe(template);
    } finally {
      crawl.db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("只分析1件，缓存区分Prompt和参数，调用和批次冻结输入", async () => {
    const crawl = new CrawlStore(":memory:");
    const first = completeRecord();
    crawl.observe(first.listing);
    crawl.save(first.listing, first.detail!);
    const second = analysisRecord("second");
    crawl.observe(second.listing);
    crawl.save(second.listing, second.detail!);
    const store = new AnalysisStore(crawl.db),
      configured = profile();
    let current = configured;
    const analyze = vi.fn(async () => ({
      text: JSON.stringify(calculateValuation(first, current)),
    }));
    const runner = new AnalysisRunner(store, async () => ({ model: "test", analyze }));
    try {
      const one = await runner.start("codex", true, configured, true);
      await runner.settled();
      expect(store.run(one)).toMatchObject({
        total: 1,
        completed: 1,
        profileHash: configured.hash,
      });
      const task = store.overview({ runId: one }).ranking[0].taskId!;
      const detail = store.detail(task)!;
      expect(detail.profile?.template).toBe(template);
      expect(detail.attempts[0].requestText).toBe(detail.promptText);
      const reused = await runner.start("codex", false, configured, true);
      await runner.settled();
      expect(store.run(reused)?.reused).toBe(1);
      expect(analyze).toHaveBeenCalledTimes(1);
      current = createProfile(template, { ...configured.settings, b: 0.7 });
      const newParameters = await runner.start("codex", false, current, true);
      await runner.settled();
      expect(store.run(newParameters)?.reused).toBe(0);
      expect(analyze).toHaveBeenCalledTimes(2);
      current = createProfile(template + "\n分析说明调整。", current.settings);
      const newPrompt = await runner.start("codex", false, current, true);
      await runner.settled();
      expect(store.run(newPrompt)?.reused).toBe(0);
      expect(analyze).toHaveBeenCalledTimes(3);
      expect(store.detail(task)?.profile?.hash).toBe(configured.hash);
    } finally {
      await runner.shutdown();
      crawl.db.close();
    }
  });
});
