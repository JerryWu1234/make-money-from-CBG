import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { valuationRecord } from "../../tests/fixtures/analysis";
import { CrawlStore } from "../crawler/store";
import { BARE_ROLE_TEMPLATE } from "./bare-role-prompt";
import { textHash } from "./contract";
import { createProfile, DEFAULT_SETTINGS, PROMPT_FILE } from "./profile";
import { buildProductDocument } from "./product-document";
import { AnalysisStore } from "./store";
import { validateValuation, valuationPrompt } from "./valuation-contract";
import { validateValuationFacts } from "./valuation-facts";

const template = readFileSync(PROMPT_FILE, "utf8");
const profile = () =>
  createProfile(template, {
    ...DEFAULT_SETTINGS,
    servers: [{ serverId: valuationRecord().listing.serverId, age: "three", rank: 10 }],
  });
const assetTab = () => ({
  name: "召唤兽/孩子",
  text: "宝宝隐私标记：第1只坐骑：成长：2.35，已进阶，主属性比例：99%",
  fields: [],
  tables: [],
  elements: [],
  tooltips: [],
  items: [{ index: 0, name: "装备隐私标记", tooltip: "装备详细属性".repeat(4000) }],
});

describe("裸号专用 AI 请求", () => {
  it("全量存档不变，请求排除资产、原始数据和通用模板，只保留裸号输入", () => {
    const record = valuationRecord();
    record.detail!.tabs.push(assetTab());
    record.detail!.raw = { asset: "原始资产标记" };
    record.detail!.valuation = {
      version: 1,
      fields: [{ name: "神器套数", value: "0", tab: "道具/法宝" }],
      issues: [],
      source: { asset: "结构化资产标记" },
    };
    record.listing.summary = { assets: "列表资产标记", iCash: 0, iSaving: 0, xianyu: 0 };
    const before = structuredClone(record);
    const doc = buildProductDocument(record);
    const prompt = valuationPrompt(doc, record, profile());
    expect(prompt.startsWith(BARE_ROLE_TEMPLATE)).toBe(true);
    expect(prompt).toContain(doc.contentHash);
    expect(prompt).toContain('"name":"神器套数","value":"0"');
    expect(prompt).toContain("人物有效攻法修炼");
    for (const secret of [
      "装备隐私标记",
      "宝宝隐私标记",
      "原始资产标记",
      "结构化资产标记",
      "列表资产标记",
    ])
      expect(prompt).not.toContain(secret);
    expect(prompt).not.toContain(template);
    expect(prompt).not.toContain("core-initial-first-five-v3");
    expect(prompt.length).toBeLessThan(doc.text.length / 4);
    expect(doc.text).toContain("装备隐私标记");
    expect(buildProductDocument(record)).toEqual(doc);
    expect(record).toEqual(before);
  });

  it.each(["text", "field", "table"])(
    "神器原文 %s 保留真实路径并能补提复算，不重排 tab 下标",
    (source) => {
      const record = valuationRecord();
      record.detail!.tabs[0].fields = record.detail!.tabs[0].fields.filter(
        (field) => field.name !== "神器套数",
      );
      record.detail!.tabs.unshift(assetTab());
      const quote = "共有1套神器；第1套神器：十二水，总分：91，12/12。";
      record.detail!.tabs.push({
        ...assetTab(),
        name: "道具/法宝",
        items: [],
        text: source === "text" ? quote : "",
        fields: source === "field" ? [{ name: "神器原文", value: quote }] : [],
        tables: source === "table" ? [[[quote]]] : [],
      });
      const path =
        "/detail/tabs/3/" +
        (source === "text" ? "text" : source === "field" ? "fields/0/value" : "tables/0/0/0");
      const doc = buildProductDocument(record);
      const configured = profile();
      const prompt = valuationPrompt(doc, record, configured);
      expect(prompt).toContain(JSON.stringify(path));
      expect(prompt).toContain(quote);
      expect(prompt).not.toContain("宝宝隐私标记");
      const extracted_facts = [
        { name: "神器套数", value: "1" },
        { name: "神器1满槽", value: "是" },
        { name: "神器1类型", value: "十二水" },
        { name: "神器1总分", value: "91" },
      ].map((fact) => ({ ...fact, quote, path }));
      expect(validateValuationFacts(extracted_facts, record)).toEqual(extracted_facts);
      const result = validateValuation(
        JSON.stringify({ decision: "BUY", reason: "核对裸号神器", extracted_facts }),
        doc,
        record,
        configured,
      );
      expect(result.valuation?.items.find((item) => item.name === "神器")?.amount).toBe(1400);
      expect(result.inputHash).toBe(doc.contentHash);
    },
  );

  it("开启装备分析时仍发送原有完整资料和查价规则", () => {
    const record = valuationRecord();
    const doc = buildProductDocument(record);
    const prompt = valuationPrompt(
      doc,
      record,
      createProfile(template, DEFAULT_SETTINGS, true, true),
    );
    expect(prompt.startsWith(template)).toBe(true);
    expect(prompt.split(doc.text)).toHaveLength(2);
    expect(prompt).not.toContain(BARE_ROLE_TEMPLATE);
  });

  it("真实带空格坐骑子页中的补提证据保留原路径", () => {
    const record = valuationRecord();
    record.detail!.tabs[0].fields = record.detail!.tabs[0].fields.filter(
      (field) => field.name !== "坐骑总数",
    );
    const quote = "共有1只坐骑；第1只坐骑：成长：2.343，未进阶，主属性比例：未知。";
    record.detail!.tabs.push({ ...assetTab(), name: "坐骑 / 第1只", text: quote, items: [] });
    const doc = buildProductDocument(record),
      configured = profile();
    const prompt = valuationPrompt(doc, record, configured);
    expect(prompt).toContain(quote);
    expect(prompt).toContain('"path":"/detail/tabs/2/text"');
    const facts = [
      { name: "坐骑总数", value: "1" },
      { name: "坐骑1成长", value: "2.343" },
      { name: "坐骑1进阶状态", value: "未进阶" },
    ].map((fact) => ({ ...fact, path: "/detail/tabs/2/text", quote }));
    expect(validateValuationFacts(facts, record)).toEqual(facts);
    const result = validateValuation(
      JSON.stringify({ decision: "BUY", reason: "核对坐骑成长", extracted_facts: facts }),
      doc,
      record,
      configured,
    );
    expect(result.valuation?.items.find((item) => item.name === "坐骑")?.amount).toBe(100);
    expect(prompt).toContain("其他成长（包括2.3433）计0，不需要主属性比例");
  });

  it("旧队列继续时更新未处理请求，保留全量输入、已完成结果和历史调用", () => {
    const crawl = new CrawlStore(":memory:");
    try {
      for (const key of ["a", "b"]) {
        const record = valuationRecord(key);
        crawl.observe(record.listing);
        crawl.save(record.listing, record.detail!);
      }
      const store = new AnalysisStore(crawl.db);
      const runId = store.createRun("codex", "test", true, profile(), true, 2);
      const tasks = crawl.db
        .prepare("SELECT * FROM analysis_tasks WHERE run_id=? ORDER BY ordinal")
        .all(runId);
      const oldPrompt = "旧全量请求：" + tasks[1].input_text;
      crawl.db
        .prepare("UPDATE analysis_tasks SET prompt_text=?,prompt_hash=? WHERE run_id=?")
        .run(oldPrompt, textHash(oldPrompt), runId);
      crawl.db.prepare("UPDATE analysis_tasks SET status='completed' WHERE id=?").run(tasks[0].id);
      crawl.db
        .prepare(
          "INSERT INTO analysis_attempts(id,task_id,state,created_at,request_text,request_hash) VALUES('old',?,'interrupted','now',?,?)",
        )
        .run(tasks[1].id, oldPrompt, textHash(oldPrompt));
      store.refreshPendingCaptures(runId);
      const completed = store.detail(String(tasks[0].id))!;
      const pending = store.detail(String(tasks[1].id))!;
      expect(completed.promptText).toBe(oldPrompt);
      expect(pending.promptText.startsWith(BARE_ROLE_TEMPLATE)).toBe(true);
      expect(pending.requestTemplate).toBe(BARE_ROLE_TEMPLATE);
      expect(pending.promptHash).toBe(textHash(pending.promptText));
      expect(pending.inputText).toBe(tasks[1].input_text);
      expect(pending.inputHash).toBe(tasks[1].input_hash);
      expect(pending.attempts[0].requestText).toBe(oldPrompt);
      const frozen = crawl.db
        .prepare("SELECT profile_json FROM analysis_runs WHERE id=?")
        .get(runId)!;
      expect(JSON.parse(String(frozen.profile_json))).toEqual(profile());
    } finally {
      crawl.close();
    }
  });
});
