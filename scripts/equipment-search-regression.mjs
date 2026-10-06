import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { chromium } from "playwright-core";
import {
  equipmentName,
  equipmentDescription,
  equipmentSearchDocument,
  equipmentDetailDocument,
  roleSentinelDocument,
} from "../tests/fixtures/equipment-search-site.mjs";

// All requests are intercepted below. Only a temporary Chrome profile is opened.
async function moduleUrl(file, replacements = {}) {
  let source = ts.transpileModule(await readFile(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const [name, url] of Object.entries(replacements))
    source = source.replaceAll(`from "${name}"`, `from "${url}"`);
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}
const inline = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const compact = await moduleUrl("server/crawler/compact.ts");
const viewport = await moduleUrl("server/viewport.ts");
const pageState = await moduleUrl("server/page-state.ts");
const configuration = await moduleUrl("server/config.ts");
const crawlerPage = await moduleUrl("server/crawler/page.ts", {
  "./listing": await moduleUrl("server/crawler/listing.ts"),
  "./types": await moduleUrl("server/crawler/types.ts"),
  "../viewport": viewport,
});
const workflow = await moduleUrl("server/workflow.ts", {
  "./config": configuration,
  "./page-state": pageState,
});
const session = await moduleUrl("server/session.ts", {
  "playwright-core": import.meta.resolve("playwright-core"),
  "./viewport": viewport,
  "./chrome": await moduleUrl("server/chrome.ts"),
  "./config": configuration,
  "./work-transport": await moduleUrl("server/work-transport.ts"),
  "./diagnostics": inline("export const diagnostics={record(){}};"),
});
const attributes = await moduleUrl("server/analysis/equip-attributes.ts", {
  "../crawler/compact": compact,
});
const matcher = await moduleUrl("server/analysis/equipment-match.ts", {
  "./equip-attributes": attributes,
});
const integrity = await moduleUrl("server/analysis/pricing-integrity.ts");
const estimate = await moduleUrl("server/analysis/pricing-estimate.ts", {
  "./pricing-integrity": integrity,
});
const jade = await moduleUrl("server/analysis/jade-query.ts", { "../crawler/compact": compact });
const pricing = await moduleUrl("server/analysis/equipment-pricing.ts", {
  "../crawler/compact": compact,
  "./equip-attributes": attributes,
  "./equipment-match": matcher,
  "./pricing-estimate": estimate,
  "./pricing-integrity": integrity,
  "./equipment-baseline": await moduleUrl("server/analysis/equipment-baseline.ts", {
    "../crawler/compact": compact,
    "./equip-attributes": attributes,
  }),
  "./valuation-calculator": await moduleUrl("server/analysis/valuation-calculator.ts", {
    "./valuation-facts": await moduleUrl("server/analysis/valuation-facts.ts"),
  }),
});
const { assertAvailable } = await import(crawlerPage);
// Pace is skipped only in this offline fixture run; availability checks are production code.
const pacedPage = inline(
  `export {assertAvailable} from ${JSON.stringify(crawlerPage)};export async function pace(signal){signal.throwIfAborted();}`,
);
const { equipmentSourceFromPages } = await import(
  await moduleUrl("server/analysis/browser-equipment-source.ts", {
    "../session": session,
    "../crawler/controller": inline(
      "export function crawlDatabase(){throw new Error('Fixture must not open the application database');}",
    ),
    "../crawler/page": pacedPage,
    "../viewport": viewport,
    "../page-state": pageState,
    "../workflow": workflow,
    "../crawler/compact": compact,
    "./equip-attributes": attributes,
    "./equipment-match": matcher,
    "./jade-query": jade,
    "./equipment-pricing": pricing,
  })
);
const { createHiddenPage } = await import(session);
const profile = await mkdtemp(path.join(os.tmpdir(), "cbg-equipment-regression-"));
let persistent, browser;
let passed = 0,
  failed = 0;
const check = async (name, run) => {
  try {
    await run();
    passed++;
    console.log("PASS: " + name);
  } catch (error) {
    failed++;
    console.error("FAIL: " + name + " — " + error.message);
  }
};
const item = (overrides = {}) => ({
  key: "道具/法宝:0",
  name: equipmentName,
  level: 100,
  category: "人物装备 · 腰带",
  description: equipmentDescription,
  query: "",
  status: "no_match",
  referencePrice: null,
  candidates: [],
  issues: [],
  ...overrides,
});
// Keep expected-failure waits short; browser callbacks and DOM still execute in real Chrome.
const bounded = (page) =>
  new Proxy(page, {
    get(target, key) {
      if (key === "waitForFunction")
        return (fn, argument, options = {}) =>
          target.waitForFunction(fn, argument, {
            ...options,
            timeout: Math.min(options.timeout || 1000, 1000),
          });
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
try {
  persistent = await chromium.launchPersistentContext(profile, {
    executablePath:
      process.env.CBG_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--remote-debugging-port=0"],
  });
  const [port, endpoint] = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8"))
    .trim()
    .split("\n");
  browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${endpoint}`, {
    noDefaults: true,
  });
  const context = browser.contexts()[0];
  let searchOptions = {},
    detailOptions = {},
    detailVisits = [],
    navigationDelay = 0;
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://xyq.cbg.163.com") {
      await route.abort();
      return;
    }
    let body;
    if (url.pathname === "/sentinel-role-list") body = roleSentinelDocument;
    else if (url.pathname === "/equip") {
      const eid = url.searchParams.get("eid");
      detailVisits.push(eid);
      if (navigationDelay) await new Promise((resolve) => setTimeout(resolve, navigationDelay));
      const settings = typeof detailOptions === "function" ? detailOptions(eid) : detailOptions;
      if (settings.redirect) {
        await route.fulfill({ status: 302, headers: { location: settings.redirect } });
        return;
      }
      body = equipmentDetailDocument(settings);
    } else if (url.pathname.startsWith("/cgi-bin/")) body = equipmentSearchDocument(searchOptions);
    else {
      await route.abort();
      return;
    }
    try {
      await route.fulfill({ contentType: "text/html; charset=utf-8", body });
    } catch (error) {
      if (!route.request().isNavigationRequest()) throw error;
    }
  });
  const role = await context.newPage();
  await role.goto("https://xyq.cbg.163.com/sentinel-role-list");
  const roleBefore = await role.evaluate(() => ({
    url: location.href,
    args: window.QueryArgs,
    checkpoint: window.checkpoint,
  }));
  await role.evaluate(() => localStorage.setItem("saved_overall_search_equip_query", "unchanged"));
  const open = async (search = {}, detail = {}) => {
    searchOptions = search;
    detailOptions = detail;
    detailVisits = [];
    navigationDelay = 0;
    const searchPage = await createHiddenPage(browser),
      detailPage = await createHiddenPage(browser);
    const control = new AbortController();
    const source = equipmentSourceFromPages(
      bounded(searchPage),
      bounded(detailPage),
      control.signal,
    );
    return { source, searchPage, detailPage, control };
  };
  const withSource = async (search, detail, run) => {
    const current = await open(search, detail);
    try {
      await run(current);
    } finally {
      await current.source.close();
    }
  };

  await check("官方列表调用保留全区条件，取实际href、主商品价格和查询记录", () =>
    withSource({}, { recommend: true }, async ({ source, searchPage, control }) => {
      const input = item();
      const result = await source.findCandidates([input], control.signal);
      assert.equal(result.items[0].candidates[0].price, 1000);
      assert.equal(result.items[0].candidates[0].verified, true);
      assert.match(result.items[0].candidates[0].url, /eid=primary/);
      assert.doesNotMatch(
        result.items[0].candidates[0].url,
        /from_shareid|reco_request_id|cross_buy_serverid|must-not-send-viewer/,
      );
      assert.equal(result.items[0].query, result.queries[0]);
      assert.equal(input.query, result.queries[0]);
      const [query] = await searchPage.evaluate(() => window.calls);
      assert.equal(query.kindid, "20");
      assert.equal(query.level_min, 100);
      assert.equal(query.front_status, "pass_fair_show");
      assert.equal(query.act, "overall_search_equip");
      assert.equal(query.serverid, undefined);
      assert.equal(query.server_type, "3");
      assert.equal(result.searchItems[0].serverAge, "3年以上服");
      assert.equal(await searchPage.evaluate(() => window.historyWrites), 0);
      assert.equal(
        await role.evaluate(() => localStorage.getItem("saved_overall_search_equip_query")),
        "unchanged",
      );
    }),
  );

  await check("官网组件丢失3年以上服参数时拒绝使用报价", () =>
    withSource({ dropServerType: true }, {}, async ({ source, control }) => {
      await assert.rejects(source.findCandidates([item()], control.signal), /3年以上服条件/);
      assert.deepEqual(detailVisits, []);
    }),
  );

  for (const missingConfig of [false, true])
    await check(
      `套装官网映射${missingConfig ? "缺失仍核验详情" : "实际传给查询并保存原始args"}`,
      () => {
        const name = "风月宝链",
          description =
            "等级60\n灵力56\n耐久126 修理失败3次\n套装效果：附加状态炼气化神\n装备条件：等级60";
        return withSource(
          {
            suitConfigMissing: missingConfig,
            pages: [[{ eid: "same-suit", name, description, modelId: "2810" }]],
          },
          { name, description, renderedPanel: true, selling: 1, modelId: 2810 },
          async ({ source, searchPage, control }) => {
            const result = await source.findCandidates(
              [
                item({
                  name,
                  description,
                  modelId: "2810",
                  kindId: "21",
                  category: "项链",
                  level: 60,
                }),
              ],
              control.signal,
            );
            const calls = await searchPage.evaluate(() => window.calls);
            assert.equal(calls[0].suit_effect, missingConfig ? undefined : "4013");
            assert.equal(
              result.searchItems[0].args.suit_effect,
              missingConfig ? undefined : "4013",
            );
            assert.equal(
              result.searchItems[0].modes[0].args.suit_effect,
              missingConfig ? undefined : "4013",
            );
            if (!missingConfig) assert.match(result.queries[0], /"suit_effect":"4013"/);
            assert.equal(result.items[0].candidates[0].verified, true);
          },
        );
      },
    );

  await check("同名推荐在主商品前也只悬浮主图标", () =>
    withSource(
      {},
      { recommend: true, recommendFirst: true, recommendSameName: true },
      async ({ source, detailPage, control }) => {
        const result = await source.findCandidates([item()], control.signal);
        assert.equal(result.items[0].candidates[0].verified, true);
        assert.deepEqual(await detailPage.evaluate(() => window.hovers), ["EquipTipsBox"]);
        assert.equal(result.items[0].candidates[0].price, 1000);
      },
    ),
  );

  await check("无宝石装备向官网发送初血初防筛选，详情仍逐项核对", () => {
    const description = "等级 100\n气血 +176 防御 +50\n耐久度 435";
    return withSource(
      {},
      { renderedPanel: true, selling: 1, description },
      async ({ source, searchPage, control }) => {
        const result = await source.findCandidates([item({ description })], control.signal);
        const [query] = await searchPage.evaluate(() => window.calls);
        assert.equal(query.init_hp, 176);
        assert.equal(query.init_defense, 50);
        assert.equal(query.attr_without_melt, 1);
        assert.equal(query.hp, undefined);
        assert.equal(query.defense, undefined);
        assert.equal(result.items[0].candidates[0].verified, true);
      },
    );
  });

  await check("列表先排除十个明确不同配置，后续有效报价只读取一个详情", () => {
    const description = "等级 100\n气血 +176 防御 +50\n耐久度 435";
    const wrong = Array.from({ length: 10 }, (_, i) => ({
      eid: "wrong-list-" + i,
      name: equipmentName,
      kindId: "20",
      level: "100",
      description:
        i % 2 ? description + "\n特效：简易" : description.replace("气血 +176", "气血 +475"),
    }));
    return withSource(
      {
        pages: [
          [
            ...wrong,
            { eid: "matching", name: equipmentName, kindId: "20", level: "100", description },
          ],
        ],
      },
      { renderedPanel: true, selling: 1, description },
      async ({ source, control }) => {
        const result = await source.findCandidates([item({ description })], control.signal);
        assert.equal(result.items[0].candidates[0].verified, true);
        assert.deepEqual(detailVisits, ["matching"]);
        assert.equal(result.searchItems[0].details, 1);
        assert.equal(result.searchItems[0].listingRejected.length, 10);
        assert.match(result.items[0].note, /列表已排除10/);
        assert.equal(result.searchItems[0].exhausted, true);
      },
    );
  });

  await check("不同宝石等级保留为相近候选，同配优先且不把总属性套成初值", () =>
    withSource(
      {
        pages: [
          [
            {
              eid: "other-gem",
              name: equipmentName,
              description: equipmentDescription.replace("锻炼等级：8", "锻炼等级：7"),
            },
            { eid: "matching", name: equipmentName, description: equipmentDescription },
          ],
        ],
      },
      (eid) => ({
        modelId: 2912,
        description:
          eid === "other-gem"
            ? equipmentDescription.replace("锻炼等级：8", "锻炼等级：7")
            : equipmentDescription,
      }),
      async ({ source, searchPage, control }) => {
        const result = await source.findCandidates([item({ modelId: "2912" })], control.signal);
        assert.deepEqual(detailVisits, ["matching", "other-gem"]);
        assert.equal(result.items[0].candidates[0].verified, true);
        assert.equal(result.items[0].candidates[1].matchType, "similar");
        const [query] = await searchPage.evaluate(() => window.calls);
        assert.equal(query.gem_level, 8);
        assert.equal(query.init_defense, undefined);
      },
    ),
  );

  await check("列表属性残缺或原文身份未绑定时仍读取详情，不把缺失当不匹配", () =>
    withSource(
      {
        pages: [
          [
            {
              eid: "matching",
              name: equipmentName,
              description: "等级100\n防御99",
              descriptionOrdersn: "another-product",
            },
          ],
        ],
      },
      {},
      async ({ source, control }) => {
        const result = await source.findCandidates([item()], control.signal);
        assert.deepEqual(detailVisits, ["matching"]);
        assert.equal(result.items[0].candidates[0].verified, true);
      },
    ),
  );

  await check("灵饰使用独立分类、主属性和双法伤组合筛选，列表排除不同词条", () => {
    const name = "测试耳饰";
    const description =
      "等级 80\n法术伤害 +16\n精炼等级 7\n附加属性：\n法术伤害 +8[+28]\n法术伤害 +9[+28]\n速度 +8[+21]";
    return withSource(
      {
        jewelry: true,
        pages: [
          [
            {
              eid: "wrong-list",
              name,
              kindId: "62",
              description: description.replace("法术伤害 +9[+28]", "法术伤害 +30[+28]"),
            },
            { eid: "matching", name, kindId: "62", description },
          ],
        ],
      },
      { renderedPanel: true, selling: 1, name, description },
      async ({ source, searchPage, control }) => {
        const result = await source.findCandidates(
          [item({ name, category: "灵饰 · 耳饰", level: 80, kindId: "62", description })],
          control.signal,
        );
        const [query] = await searchPage.evaluate(() => window.calls);
        assert.equal(query.act, "overall_search_lingshi");
        assert.equal(query.kindid, "62");
        assert.equal(query.magic_damage, 16);
        assert.equal(query["added_attr.4"], 2);
        assert.equal(query["added_attr.3"], 1);
        assert.equal(query.added_attr_num, "3");
        assert.deepEqual(detailVisits, ["matching"]);
        assert.equal(result.items[0].candidates[0].verified, true);
      },
    );
  });

  await check("从官网唯一武器名称配置补搜索分类，不把模型编号当kind", () => {
    const name = "鱼肠",
      description = "等级 90\n伤害 +300";
    return withSource(
      {
        namedModels: { "90_6": [{ label: name, value: 1050 }] },
        pages: [[{ eid: "matching", name }]],
      },
      { renderedPanel: true, selling: 1, name, description },
      async ({ source, searchPage, control }) => {
        await source.findCandidates(
          [item({ name, category: "人物装备", level: 90, description })],
          control.signal,
        );
        const [query] = await searchPage.evaluate(() => window.calls);
        assert.equal(query.kindid, "6");
      },
    );
  });

  await check("官网名称同时对应多个武器分类时不取第一个猜kind", () => {
    const name = "月光",
      description = "等级 90\n伤害 +300";
    return withSource(
      {
        namedModels: { "90_6": [{ label: name }], "90_13": [{ label: name }] },
        pages: [[{ eid: "matching", name }]],
      },
      { renderedPanel: true, selling: 1, name, description },
      async ({ source, searchPage, control }) => {
        await source.findCandidates(
          [item({ name, category: "人物装备", level: 90, description })],
          control.signal,
        );
        const [query] = await searchPage.evaluate(() => window.calls);
        assert.equal(query.kindid, undefined);
      },
    );
  });

  for (const delay of ["panelDelay", "infoDelay"])
    await check(`独立商品容器 ${delay} 延迟后仍绑定主属性与可见价格`, () =>
      withSource(
        {},
        { renderedPanel: true, independentPanels: true, selling: 1, [delay]: 150, recommend: true },
        async ({ source, control }) => {
          const result = await source.findCandidates([item()], control.signal);
          assert.equal(result.items[0].candidates[0].verified, true);
          assert.equal(result.items[0].candidates[0].price, 1000);
        },
      ),
    );

  await check("主体失败保存最小公开诊断，仍拒绝错误商品身份", () =>
    withSource(
      {},
      { renderedPanel: true, independentPanels: true, selling: 1, rawEid: "wrong-product" },
      async ({ source, control }) => {
        const result = await source.findCandidates([item()], control.signal);
        assert.equal(result.items[0].candidates[0].verified, false);
        assert.equal(
          result.searchItems[0].detailFailures[0].diagnostics.product.id,
          "wrong-product",
        );
        assert.equal(result.searchItems[0].detailFailures[0].diagnostics.panels.length, 1);
      },
    ),
  );

  await check("完整同配在列表排序优先，前置相近行不耗尽详情额度", () =>
    withSource(
      {
        pages: [
          [
            {
              eid: "near",
              name: equipmentName,
              description: equipmentDescription.replace("防御：50", "防御：49"),
            },
            ...Array.from({ length: 3 }, (_, index) => ({
              eid: "exact-" + index,
              name: equipmentName,
              description: equipmentDescription,
            })),
          ],
        ],
      },
      { renderedPanel: true, selling: 1, modelId: 2912 },
      async ({ source, control }) => {
        const result = await source.findCandidates([item({ modelId: "2912" })], control.signal);
        assert.deepEqual(detailVisits, ["exact-0", "exact-1", "exact-2"]);
        assert(result.items[0].candidates.every((candidate) => candidate.matchType === "exact"));
      },
    ),
  );

  await check("同配为空后使用80%下限、3年以上服，取得3条相近样本后停止", () => {
    const description = "等级100\n气血176 防御50\n耐久300\n修理失败0";
    const health = [172, 174, 178, 179, 180];
    return withSource(
      {
        pages: [[]],
        broadenedPages: [
          health.map((value, index) => ({
            eid: "similar-" + index,
            name: equipmentName,
            modelId: "2912",
            description: description.replace("气血176", "气血" + value),
          })),
        ],
      },
      (eid) => ({
        renderedPanel: true,
        selling: 1,
        modelId: 2912,
        price: 1000 + Number(eid.split("-")[1]) * 50,
        description: description.replace("气血176", "气血" + health[Number(eid.split("-")[1])]),
      }),
      async ({ source, searchPage, control }) => {
        const result = await source.findCandidates(
          [item({ description, modelId: "2912" })],
          control.signal,
        );
        assert.equal(result.queries.length, 2);
        assert.deepEqual(
          result.searchItems[0].modes.map((mode) => mode.mode),
          ["exact", "similar"],
        );
        const calls = await searchPage.evaluate(() => window.calls);
        assert.equal(calls[1].init_hp, 141);
        assert(calls.every((call) => call.server_type === "3"));
        assert.equal(result.items[0].candidates.length, 3);
        assert.equal(detailVisits.length, 3);
        assert(
          result.items[0].candidates.every(
            (candidate) =>
              candidate.verified &&
              candidate.matchType === "similar" &&
              candidate.differences.length,
          ),
        );
      },
    );
  });

  await check("玉魄通过官网yupo独立入口查价，不构造普通等级查询", () => {
    const name = "上古玉魄·阴",
      description = "防御 +25\n耐久度 102\n抵抗封印等级 +13 [+48]\n气血 +67 [+168]";
    return withSource(
      { jade: true, pages: [[{ eid: "jade", name, modelId: "61717", description }]] },
      { name, description, renderedPanel: true, selling: 1, modelId: 61717 },
      async ({ source, searchPage, control }) => {
        const result = await source.findCandidates(
          [item({ name, description, category: "上古玉魄", modelId: "61717", level: null })],
          control.signal,
        );
        assert.match(searchPage.url(), /show_overall_search_yupo/);
        const call = (await searchPage.evaluate(() => window.calls))[0];
        assert.equal(call.act, "yupo_search");
        assert.equal(call.equip_type, "61717");
        assert.equal(call.level_min, undefined);
        assert.equal(result.items[0].candidates[0].verified, true);
      },
    );
  });

  await check("悬浮提示异步出现后读取完整属性", () =>
    withSource({}, { tooltipDelay: 150 }, async ({ source, control }) => {
      const result = await source.findCandidates([item()], control.signal);
      assert.equal(result.items[0].candidates[0].verified, true);
    }),
  );

  for (const rawPriceValue of [368.6, "368.60"])
    await check(`官网直排属性模板读取元报价 ${rawPriceValue}，排除推荐和跨服费`, () =>
      withSource(
        {},
        {
          renderedPanel: true,
          tooltipMissing: true,
          price: 368.6,
          rawPriceValue,
          selling: 1,
          status: "上架中",
          recommend: true,
          recommendFirst: true,
          recommendSameName: true,
        },
        async ({ source, detailPage, control }) => {
          const result = await source.findCandidates([item()], control.signal);
          const candidate = result.items[0].candidates[0];
          assert.equal(candidate.price, 368.6);
          assert.equal(candidate.verified, true);
          assert.deepEqual(await detailPage.evaluate(() => window.hovers), []);
          assert.doesNotMatch(candidate.quote, /999|推荐商品|跨服交易费/);
        },
      ),
    );

  for (const { name, settings } of [
    { name: "直排模板缺主价，推荐价不能替代", settings: { visiblePrice: false } },
    { name: "直排模板全局价格与主价不同", settings: { rawPriceValue: "999.00" } },
    { name: "直排模板全局名称与可见名称不同", settings: { rawName: "其他装备" } },
    { name: "直排模板商品ID与URL不同", settings: { rawEid: "different-product" } },
    { name: "直排模板只有推荐商品", settings: { onlyRecommendation: true } },
  ])
    await check(name + "拒绝报价", () =>
      withSource(
        {},
        { renderedPanel: true, selling: 1, recommend: true, ...settings },
        async ({ source, control }) => {
          await assert.rejects(
            source.readSource("https://xyq.cbg.163.com/equip?s=1&eid=primary", control.signal),
          );
        },
      ),
    );

  await check("直排模板主商品下架，推荐仍上架也不能采用", () =>
    withSource(
      {},
      { renderedPanel: true, selling: 0, status: "上架中", recommend: true },
      async ({ source, control }) => {
        const result = await source.findCandidates([item()], control.signal);
        assert.equal(result.items[0].candidates[0].verified, false);
        assert.match(result.items[0].candidates[0].reason, /下架/);
      },
    ),
  );

  await check("直排模板仅从当前主商品模型目录补装备限制", () =>
    withSource(
      {},
      { renderedPanel: true, selling: 1, modelDescription: "说明文字#r【装备条件】等级100" },
      async ({ source, control }) => {
        const result = await source.findCandidates(
          [item({ description: equipmentDescription + "\n装备条件：等级100" })],
          control.signal,
        );
        const candidate = result.items[0].candidates[0];
        assert.equal(candidate.verified, true);
        assert.match(candidate.quote, /装备条件.*等级100/);
        assert.doesNotMatch(candidate.quote, /说明文字|装备角色.*男/);
      },
    ),
  );

  await check("直排模板模型目录名称与主商品不同拒绝报价", () =>
    withSource(
      {},
      {
        renderedPanel: true,
        selling: 1,
        modelName: "其他装备",
        modelDescription: "【装备条件】等级100",
      },
      async ({ source, control }) => {
        await assert.rejects(
          source.readSource("https://xyq.cbg.163.com/equip?s=1&eid=primary", control.signal),
          /模型目录名称/,
        );
      },
    ),
  );

  await check("第二页末尾只有上一页时终止，不再请求第三页", () =>
    withSource(
      { pages: [[{ eid: "first", name: "其他装备" }], [{ eid: "last", name: equipmentName }]] },
      {},
      async ({ source, searchPage, control }) => {
        const result = await source.findCandidates([item()], control.signal);
        assert.deepEqual(
          (await searchPage.evaluate(() => window.calls)).map((x) => x.page),
          [1, 1, 2],
        );
        assert.equal(result.items[0].candidates[0].verified, true);
        assert.match(result.items[0].note, /已读完/);
      },
    ),
  );

  await check("重复商品不重复读详情，非同配置装备不采用", () =>
    withSource(
      {
        pages: [
          [{ eid: "wrong", name: equipmentName }],
          [
            { eid: "wrong", name: equipmentName },
            { eid: "primary", name: equipmentName },
          ],
        ],
      },
      (eid) => ({
        description:
          eid === "wrong"
            ? equipmentDescription.replace("防御：50", "防御：99")
            : equipmentDescription,
      }),
      async ({ source, control }) => {
        const result = await source.findCandidates([item()], control.signal);
        assert.deepEqual(detailVisits, ["wrong", "primary"]);
        assert.equal(
          result.items[0].candidates.filter((candidate) => candidate.verified).length,
          1,
        );
        assert.equal(
          result.items[0].candidates.find((candidate) => candidate.url.includes("wrong")).verified,
          false,
        );
      },
    ),
  );

  await check("明确零结果才返回空候选", () =>
    withSource({ pages: [[]] }, {}, async ({ source, control }) => {
      const result = await source.findCandidates([item()], control.signal);
      assert.deepEqual(result.items[0].candidates, []);
      assert.deepEqual(detailVisits, []);
      assert.match(result.items[0].note, /已读完/);
    }),
  );

  for (const mode of ["error", "transport_failure", "stalled", "guard"]) {
    await check(mode + "查询失败或未完成不会假报没有匹配", () =>
      withSource({ mode }, {}, async ({ source, control }) => {
        await assert.rejects(
          source.findCandidates([item()], control.signal),
          mode === "guard" ? /安全验证/ : undefined,
        );
        assert.deepEqual(detailVisits, []);
      }),
    );
  }

  await check("最多三页，注明尚未遍历完", () =>
    withSource(
      {
        pages: Array.from({ length: 5 }, (_, page) => [{ eid: "other-" + page, name: "其他装备" }]),
      },
      {},
      async ({ source, searchPage, control }) => {
        const result = await source.findCandidates([item()], control.signal);
        assert.equal((await searchPage.evaluate(() => window.calls)).length, 3);
        assert.match(result.items[0].note, /未遍历/);
      },
    ),
  );

  await check("最多六十个列表候选，不无限请求详情", () =>
    withSource(
      {
        pages: Array.from({ length: 3 }, (_, page) =>
          Array.from({ length: 30 }, (_, row) => ({
            eid: `${page}-${row}`,
            name: "其他装备",
          })),
        ),
      },
      {},
      async ({ source, searchPage, control }) => {
        const result = await source.findCandidates([item()], control.signal);
        assert.equal((await searchPage.evaluate(() => window.calls)).length, 3);
        assert.match(result.items[0].note, /60个列表候选/);
        assert.deepEqual(detailVisits, []);
      },
    ),
  );

  await check("最多读取二十个详情，达到三个真实同配匹配立即停", async () => {
    await withSource(
      {
        pages: Array.from({ length: 3 }, (_, page) =>
          Array.from({ length: 25 }, (_, row) => ({
            eid: `${page}-${row}`,
            name: equipmentName,
          })),
        ),
      },
      { description: equipmentDescription.replace("防御：50", "防御：99") },
      async ({ source, control }) => {
        const result = await source.findCandidates([item()], control.signal);
        assert.equal(detailVisits.length, 20);
        assert.match(result.items[0].note, /20个详情/);
      },
    );
    await withSource(
      {
        pages: [
          Array.from({ length: 8 }, (_, row) => ({ eid: "match-" + row, name: equipmentName })),
        ],
      },
      {},
      async ({ source, control }) => {
        const result = await source.findCandidates([item()], control.signal);
        assert.equal(detailVisits.length, 3);
        assert.equal(result.items[0].candidates.length, 3);
      },
    );
  });

  await check("单页4条取到3个样本早停，不能误报所有商品已读完", () =>
    withSource(
      {
        pages: [
          Array.from({ length: 4 }, (_, row) => ({
            eid: "four-" + row,
            name: equipmentName,
          })),
        ],
      },
      {},
      async ({ source, control }) => {
        const result = await source.findCandidates([item()], control.signal);
        assert.equal(detailVisits.length, 3);
        assert.equal(result.items[0].candidates.length, 3);
        assert.equal(result.searchItems[0].exhausted, false);
        assert.match(result.items[0].note, /未遍历/);
      },
    ),
  );

  for (const { name, settings } of [
    { name: "只有后台raw价格没有可见价格", settings: { visiblePrice: false } },
    { name: "主商品缺少提示属性", settings: { tooltipMissing: true } },
    {
      name: "推荐上架不能替代主商品未知状态",
      settings: { status: "未知", recommend: true, recommendFirst: true },
    },
    { name: "主商品ID与当前URL不一致", settings: { rawEid: "another-product" } },
    { name: "主图标名称与主商品数据不一致", settings: { rawName: "其他主商品" } },
    { name: "页面只有推荐商品", settings: { recommend: true, onlyRecommendation: true } },
  ])
    await check(name + "拒绝报价", () =>
      withSource({}, settings, async ({ source, control }) => {
        const html = source.readSource(
          "https://xyq.cbg.163.com/equip?s=1&eid=primary",
          control.signal,
        );
        await assert.rejects(html);
      }),
    );

  await check("已下架主商品不能因推荐上架变成可用报价", () =>
    withSource(
      {},
      { status: "未上架", recommend: true, recommendFirst: true },
      async ({ source, control }) => {
        const result = await source.findCandidates([item()], control.signal);
        assert.equal(result.items[0].candidates[0].verified, false);
      },
    ),
  );

  await check("详情跳转到其他商品时不采用其价格", () =>
    withSource(
      {},
      (eid) =>
        eid === "primary" ? { redirect: "https://xyq.cbg.163.com/equip?s=1&eid=other" } : {},
      async ({ source, control }) => {
        await assert.rejects(
          source.readSource("https://xyq.cbg.163.com/equip?s=1&eid=primary", control.signal),
          /另一商品/,
        );
      },
    ),
  );

  await check("同一详情快照可复用，不重复请求", () =>
    withSource({}, {}, async ({ source, control }) => {
      const url = "https://xyq.cbg.163.com/equip?s=1&eid=primary";
      assert.equal(
        await source.readSource(url, control.signal),
        await source.readSource(url, control.signal),
      );
      assert.deepEqual(detailVisits, ["primary"]);
    }),
  );

  await check("用户取消正在导航，关闭两张自有页并抛出中止", () =>
    withSource({}, {}, async ({ source, searchPage, detailPage, control }) => {
      navigationDelay = 500;
      const pending = source.readSource(
        "https://xyq.cbg.163.com/equip?s=1&eid=primary",
        control.signal,
      );
      const rejected = assert.rejects(pending);
      await new Promise((resolve) => setTimeout(resolve, 50));
      control.abort(new Error("用户已暂停"));
      await rejected;
      await source.close();
      assert.equal(searchPage.isClosed(), true);
      assert.equal(detailPage.isClosed(), true);
    }),
  );

  await check("查价前后原角色列表URL、筛选、页码和断点保持一致", async () => {
    assert.equal(role.isClosed(), false);
    assert.deepEqual(
      await role.evaluate(() => ({
        url: location.href,
        args: window.QueryArgs,
        checkpoint: window.checkpoint,
      })),
      roleBefore,
    );
  });
  // A basic genuine availability check confirms the fixture does not bypass production login logic.
  await assertAvailable(role);
  console.log(
    `Offline isolated Chrome fixture checks: ${passed} passed, ${failed} failed. No real market or AI requests.`,
  );
  if (failed) process.exitCode = 1;
} finally {
  await browser?.close();
  await persistent?.close();
  await rm(profile, { recursive: true, force: true });
}
