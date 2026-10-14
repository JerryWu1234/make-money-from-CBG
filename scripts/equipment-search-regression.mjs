import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const baseline = await moduleUrl("server/analysis/equipment-baseline.ts", {
  "../crawler/compact": compact,
  "./equip-attributes": attributes,
});
const exclusion = await moduleUrl("server/analysis/equipment-exclusion.ts", {
  "./equipment-baseline": baseline,
});
const integrity = await moduleUrl("server/analysis/pricing-integrity.ts", {
  "./equipment-exclusion": exclusion,
});
const progress = await moduleUrl("server/analysis/pricing-progress.ts", {
  "./pricing-integrity": integrity,
});
const estimate = await moduleUrl("server/analysis/pricing-estimate.ts", {
  "./pricing-integrity": integrity,
});
const { buildEquipmentEstimate } = await import(estimate);
const jade = await moduleUrl("server/analysis/jade-query.ts", {
  "../crawler/compact": compact,
  "./equipment-match": matcher,
});
const specialMatcher = await moduleUrl("server/analysis/special-asset-match.ts", {
  "../crawler/compact": compact,
  "./equipment-match": matcher,
});
const pricing = await moduleUrl("server/analysis/equipment-pricing.ts", {
  "./pricing-progress": progress,
  "./market-scope": await moduleUrl("server/analysis/market-scope.ts"),
  "../crawler/compact": compact,
  "./equip-attributes": attributes,
  "./equipment-match": matcher,
  "./special-asset-match": specialMatcher,
  "./equipment-exclusion": exclusion,
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
const { searchEquipmentPrices } = await import(pricing);
const { assertAvailable } = await import(crawlerPage);
// Pace is skipped only in this offline fixture run; availability checks are production code.
const pacedPage = inline(
  `export {assertAvailable} from ${JSON.stringify(crawlerPage)};export async function pace(signal){signal.throwIfAborted();}`,
);
const { equipmentSourceFromPages, equipmentPageSource } = await import(
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
    "./pricing-estimate": estimate,
    "./pricing-progress": progress,
    "./pricing-integrity": integrity,
    "./market-scope": await moduleUrl("server/analysis/market-scope.ts"),
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
  if (
    process.env.CBG_OFFLINE_FILTER &&
    !process.env.CBG_OFFLINE_FILTER.split("|").some((part) => name.includes(part))
  )
    return;
  try {
    await run();
    passed++;
    console.log("PASS: " + name);
  } catch (error) {
    failed++;
    console.error(
      "FAIL: " + name + " — " + (process.env.CBG_OFFLINE_DEBUG ? error.stack : error.message),
    );
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
    serviceWorkers: "block",
    args: [
      "--remote-debugging-port=0",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
    ],
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
    marketRequests = [],
    navigationDelay = 0,
    onDetailVisit = null;
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
      onDetailVisit?.(eid);
      if (navigationDelay) await new Promise((resolve) => setTimeout(resolve, navigationDelay));
      const settings = typeof detailOptions === "function" ? detailOptions(eid) : detailOptions;
      if (settings.redirect) {
        await route.fulfill({ status: 302, headers: { location: settings.redirect } });
        return;
      }
      body = equipmentDetailDocument(settings);
    } else if (url.pathname === "/cgi-bin/recommend.py") {
      marketRequests.push(Object.fromEntries(url.searchParams));
      body = "{}";
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
    marketRequests = [];
    navigationDelay = 0;
    onDetailVisit = null;
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

  await check("元身由真实控件填表、读取运行时动作并检索，不猜接口字段", () => {
    const name = "巨剑·元身",
      description = "伤害：500\n命中：600\n附加属性：力量+20\n附加特技概率：12%";
    return withSource(
      {
        yuanshen: true,
        pages: [
          [
            { eid: "yuan-1", name },
            { eid: "yuan-2", name },
          ],
        ],
      },
      { name, description, renderedPanel: true, selling: 1, price: 250 },
      async ({ source, searchPage, control }) => {
        const result = await source.findCandidates(
          [item({ name, category: "元身", level: null, description })],
          control.signal,
        );
        assert.equal(result.items[0].searchState, "completed", JSON.stringify(result.searchItems));
        assert.equal(result.items[0].candidates.length, 2);
        assert.ok(
          result.items[0].candidates.every(
            (value) => value.verified && value.matchType === "exact",
          ),
        );
        const calls = await searchPage.evaluate(() => window.calls);
        assert.equal(calls[0].act, "fixture_search_yuanshen");
        assert.equal(calls[0].fixture_kind, "93");
        assert.equal(calls[0].fixture_attr_type, "shanghai");
        assert.equal(calls[0].attr_value, 500);
        assert.equal(calls[0].addon_skill_chance, 12);
        assert.equal(calls[0].fixture_addon, "51");
        assert.ok(searchPage.url().includes("show_overall_search_yuanshen"));
        assert.deepEqual(detailVisits, ["yuan-1", "yuan-2"]);
      },
    );
  });

  await check("元身相近查询由运行时控件放宽基础值，附加概率保持不变", () => {
    const name = "巨剑·元身",
      description = "伤害：500\n命中：600\n附加属性：力量+20\n附加特技概率：12%";
    return withSource(
      { yuanshen: true, pages: [[{ eid: "yuan-near", name, kindId: "93" }]] },
      {
        name,
        kindId: 93,
        description: description.replace("500", "450"),
        renderedPanel: true,
        selling: 1,
        price: 250,
      },
      async ({ source, searchPage, control }) => {
        const result = await source.findCandidates(
          [item({ name, kindId: "93", category: "元身", level: null, description })],
          control.signal,
        );
        assert.equal(result.items[0].searchState, "completed");
        assert.equal(result.items[0].candidates[0].matchType, "similar");
        const calls = await searchPage.evaluate(() => window.calls);
        assert.equal(calls[0].attr_value, 500);
        assert.equal(calls.at(-1).attr_value, 400);
        assert.ok(
          calls.every(
            (call) =>
              call.addon_skill_chance === 12 &&
              call.fixture_addon === "51" &&
              call.level_min === undefined,
          ),
        );
      },
    );
  });

  await check("普通无匹配装备经过两组全服表单穷尽后排除，仍没有0元价格", () =>
    withSource({ pages: [[]] }, {}, async ({ source, control }) => {
      const collectedAt = new Date().toISOString();
      const record = {
        listing: { serverId: "1" },
        detail: {
          collectedAt,
          equipmentCapture: { version: 1, collectedAt, complete: true, issues: [] },
          tabs: [
            {
              name: "道具/法宝",
              text: "",
              fields: [],
              tables: [],
              elements: [],
              tooltips: [],
              items: [
                {
                  index: 0,
                  kind: "equipment",
                  name: "普通腰带",
                  category: "人物装备 · 腰带",
                  description: "等级60\n防御35 气血140\n耐久度300\n装备条件：等级60",
                },
              ],
            },
          ],
        },
      };
      const result = await searchEquipmentPrices(record, control.signal, source);
      assert.equal(result.searchComplete, true);
      assert.equal(result.items[0].exclusion?.label, "无匹配，未计入参考合计");
      assert.equal(result.items[0].referencePrice, null);
      assert.equal(result.total, null);
      assert.deepEqual(
        result.items[0].exclusion.stages.map((stage) => stage.mode),
        ["exact", "similar"],
      );
    }),
  );

  await check("前五件均价完整经过表单提交、翻页、详情核验和计价，不读取第六件", () => {
    const prices = [145, 100, 130, 110, 120, 101, 102, 103, 104, 105, 1];
    return withSource(
      {
        pages: [
          Array.from({ length: 5 }, (_, index) => "mean-" + index),
          ["mean-5", "mean-6", "mean-7", "mean-8", "mean-9", "mean-10"],
        ].map((page) => page.map((eid) => ({ eid, name: equipmentName }))),
      },
      (eid) => ({ price: prices[Number(eid.split("-").at(-1))] }),
      async ({ source, searchPage, control }) => {
        const collectedAt = new Date().toISOString();
        const record = {
          listing: { serverId: "1" },
          detail: {
            collectedAt,
            equipmentCapture: { version: 1, collectedAt, complete: true, issues: [] },
            tabs: [
              {
                name: "道具/法宝",
                text: "",
                fields: [],
                tables: [],
                elements: [],
                tooltips: [],
                items: [
                  {
                    index: 0,
                    kind: "equipment",
                    name: equipmentName,
                    category: "人物装备 · 腰带",
                    description: equipmentDescription,
                  },
                ],
              },
            ],
          },
        };
        const result = await searchEquipmentPrices(record, control.signal, source);
        assert.equal(result.total, 121, JSON.stringify(result));
        assert.equal(result.searchComplete, true);
        assert.equal(result.items[0].referencePrice, 121);
        assert.deepEqual(
          result.items[0].candidates.map((value) => value.price),
          prices.slice(0, 5),
        );
        assert.deepEqual(
          detailVisits,
          Array.from({ length: 5 }, (_, index) => "mean-" + index),
        );
        const calls = await searchPage.evaluate(() => window.calls);
        assert.deepEqual(
          calls.map((call) => call.page),
          [1],
        );
        assert.ok(calls.every((call) => call.server_type === "3" && call.level_min === 100));
        assert.equal(result.searchItems[0].uiQueries[0].submittedArgs.gem_level, 8);
      },
    );
  });

  await check("前五件相近报价保留官网顺序，不按属性距离重新挑样本", () => {
    const prices = [145, 100, 130, 110, 120, 101, 102, 103, 104, 105, 1];
    const defenses = [55, 49, 54, 48, 51, 52, 53, 49, 47, 46, 50];
    return withSource(
      {
        pages: [
          prices.map((_, index) => ({
            eid: `similar-mean-${index}`,
            name: equipmentName,
            modelId: "2912",
          })),
        ],
      },
      (eid) => ({
        modelId: 2912,
        price: prices[Number(eid.split("-").at(-1))],
        description: equipmentDescription.replace(
          "防御：50",
          `防御：${defenses[Number(eid.split("-").at(-1))]}`,
        ),
      }),
      async ({ source, control }) => {
        const result = await source.findCandidates([item({ modelId: "2912" })], control.signal);
        assert.equal(result.items[0].searchState, "completed");
        assert.deepEqual(
          result.items[0].candidates.map((value) => value.price),
          prices.slice(0, 5),
        );
        assert.equal(buildEquipmentEstimate(result.items[0].candidates).average, 121);
        assert.equal(detailVisits.includes("similar-mean-5"), false);
      },
    );
  });

  await check("官方列表调用保留全区条件，取实际href、主商品价格和查询记录", () =>
    withSource({}, { recommend: true }, async ({ source, searchPage, control }) => {
      const input = item();
      const result = await source.findCandidates([input], control.signal);
      assert.ok(result.items[0].candidates.length, JSON.stringify(result.searchItems));
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
      assert.equal(
        result.searchItems[0].searchUrl,
        "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=show_overall_search_equip",
      );
      assert.equal(result.searchItems[0].uiQueries[0].submittedArgs.gem_level, 8);
      assert.deepEqual(result.searchItems[0].scopeEvidence, [
        {
          mode: "exact",
          request: {
            endpoint: "https://xyq.cbg.163.com/cgi-bin/recommend.py",
            act: "recommd_by_role",
            searchType: "overall_search_equip",
            serverType: "3",
            page: 1,
            restrictions: {},
          },
          rowCount: 1,
          candidateServers: { 1: 1 },
        },
      ]);
      assert.equal(await searchPage.evaluate(() => window.historyWrites), 1);
      const events = await searchPage.evaluate(() => window.uiEvents);
      assert.ok(
        events.some(
          (event) => event.type === "input" && event.id === "txt_gem_level" && event.value === "8",
        ),
      );
      assert.ok(events.some((event) => event.type === "click" && event.id === "btn_equip_search"));
      assert.ok(
        result.searchItems[0].uiQueries[0].actions.some(
          (action) => action.method === "drag" && action.value === "100-100",
        ),
      );
      assert.equal(
        await role.evaluate(() => localStorage.getItem("saved_overall_search_equip_query")),
        "unchanged",
      );
    }),
  );

  for (const sample of [
    { category: "剑", field: "伤害", parameter: "damage", raw: 300, melting: -10 },
    { category: "饰品", field: "灵力", parameter: "all_wakan", raw: 100, melting: -5 },
  ]) {
    await check("负熔炼原值查询：带宝石" + sample.category, async () => {
      const name = "负熔炼" + sample.category;
      const description =
        "等级100\n" +
        sample.field +
        sample.raw +
        "\n锻炼等级8 镶嵌宝石 黑宝石\n熔炼效果：\n" +
        sample.melting +
        sample.field;
      await withSource(
        {
          pages: [
            [
              {
                eid: "negative-melt",
                name,
                description,
                rawAttributes: { [sample.parameter]: sample.raw },
                meltAttributes: { [sample.parameter]: sample.melting },
              },
            ],
          ],
        },
        { name, description },
        async ({ source, searchPage, control }) => {
          const result = await source.findCandidates(
            [item({ name, category: "人物装备 · " + sample.category, description })],
            control.signal,
          );
          const [query] = await searchPage.evaluate(() => window.calls);
          assert.equal(query[sample.parameter], sample.raw);
          assert.equal(
            query.attr_without_melt,
            1,
            JSON.stringify({
              request: marketRequests[0],
              rows: result.searchItems[0].scopeEvidence[0].rowCount,
            }),
          );
          assert.equal(query.attr_with_melt, undefined);
          assert.equal(marketRequests[0][sample.parameter], String(sample.raw));
          for (const request of marketRequests) {
            assert.equal(request.attr_without_melt, "1");
            assert.equal(request.attr_with_melt, undefined);
          }
          assert.equal(result.searchItems[0].scopeEvidence[0].rowCount, 1);
          assert.equal(result.items[0].candidates[0].verified, true);
          assert.equal(result.items[0].candidates[0].matchType, "exact");
          assert.ok(
            result.searchItems[0].uiQueries[0].actions.some(
              (action) => action.control === "chk_attr_with_melt" && action.value === "false",
            ),
          );
        },
      );
    });
  }

  for (const sample of [
    {
      label: "已开孔装备",
      input: item({ description: equipmentDescription + "\n开运孔数：3孔/3孔" }),
      search: {},
      expected: { hole_num: 3 },
    },
    {
      label: "简易灵饰",
      input: item({
        name: "芙蓉戒",
        category: "人物装备 · 戒指",
        kindId: "61",
        level: 80,
        description:
          "等级80\n防御21\n精炼等级5\n附加属性：\n法术伤害8[+20]\n特效：健步如飞（2级）\n速度+2\n特效：简易",
      }),
      search: { jewelry: true },
      expected: { special_effect: 1, suit_effect: "4", suit_effect_level: 2 },
    },
    {
      label: "玉魄额外灵尘",
      input: item({
        name: "上古玉魄·阴",
        category: "上古玉魄",
        modelId: "61717",
        level: null,
        description:
          "防御 +25\n耐久度 102\n灵尘等级 5 [+1]\n抵抗封印等级 +13 [+48]\n气血 +67 [+168]",
      }),
      search: { jade: true },
      expected: { minghun_level_min: "5" },
    },
  ]) {
    await check("官网表单补齐：" + sample.label, () =>
      withSource(
        {
          ...sample.search,
          pages: [
            [
              {
                eid: "form-fields",
                name: sample.input.name,
                description: sample.input.description,
              },
            ],
          ],
        },
        {
          name: sample.input.name,
          description: sample.input.description,
          ...(sample.input.modelId ? { modelId: Number(sample.input.modelId) } : {}),
        },
        async ({ source, control }) => {
          const result = await source.findCandidates([sample.input], control.signal);
          for (const [key, value] of Object.entries(sample.expected))
            assert.equal(marketRequests[0][key], String(value));
          assert.equal(marketRequests[0].include_ext_mh_lv, undefined);
          assert.equal(result.items[0].candidates[0].verified, true);
          if (sample.search.jade)
            assert.ok(
              result.searchItems[0].uiQueries[0].actions.some(
                (action) => action.control === "chk_include_ext_mh_lv" && action.value === "false",
              ),
            );
          if (sample.expected.hole_num)
            for (const request of marketRequests.slice(1))
              assert.equal(request.hole_num, undefined);
          if (sample.expected.special_effect)
            for (const request of marketRequests) assert.equal(request.special_effect, "1");
        },
      ),
    );
  }

  for (const sample of [
    {
      name: "另一双鞋",
      category: "人物装备 · 鞋子",
      level: 70,
      description: "等级70\n防御30\n敏捷20",
      expected: { kindid: "19", level_min: 70, level_max: 70, init_defense: 30, init_dex: 20 },
    },
    {
      name: "另一把剑",
      category: "人物装备 · 剑",
      level: 160,
      description: "等级160\n伤害500\n特技：破血狂攻\n特效：永不磨损\n锻炼等级10 镶嵌宝石 太阳石",
      expected: {
        kindid: "6",
        level_min: 160,
        level_max: 160,
        gem_level: 10,
        gem_value: "2",
        special_skill: "1036",
        special_effect: "5",
      },
    },
    {
      name: "另一个手镯",
      category: "人物装备 · 手镯",
      level: 100,
      jewelry: true,
      description:
        "等级100\n封印命中等级25\n精炼等级6\n附加属性：\n气血80[+100]\n防御20[+50]\n特效：血气方刚（3级）",
      expected: {
        kindid: "63",
        equip_level_min: 100,
        equip_level_max: 100,
        fengyin: 25,
        jinglian_level: 6,
        suit_effect: "1",
        suit_effect_level: 3,
      },
    },
  ]) {
    await check("通用 UI 动态查询：" + sample.name, () =>
      withSource(
        { jewelry: !!sample.jewelry, pages: [[{ eid: "generic", name: sample.name }]] },
        { name: sample.name, description: sample.description },
        async ({ source, searchPage, control }) => {
          const result = await source.findCandidates([item(sample)], control.signal);
          assert.equal(result.items[0].candidates[0]?.verified, true, JSON.stringify(result.items));
          const [actual] = await searchPage.evaluate(() => window.calls);
          for (const [key, value] of Object.entries(sample.expected))
            assert.equal(String(actual[key]), String(value), key);
          assert.ok(
            result.searchItems[0].uiQueries[0].actions.some(
              (action) =>
                action.control === (sample.jewelry ? "btn_lingshi_search" : "btn_equip_search") &&
                action.method === "click",
            ),
          );
        },
      ),
    );
  }
  for (const { label, settings, target, stage, unsupported = false } of [
    {
      label: "搜索按钮缺失",
      settings: { omitControl: "btn_equip_search" },
      target: item(),
      stage: "query_submit",
    },
    {
      label: "字段被官网忽略",
      settings: { dropUiField: "gem_level" },
      target: item(),
      stage: "ui_condition_verify",
    },
    {
      label: "官网保留未计划的价格上限",
      settings: { extraUiFilters: { price_max: 10000 } },
      target: item(),
      stage: "ui_condition_verify",
    },
    {
      label: "非官网步长等级",
      settings: {},
      target: item({ level: 65, description: "等级65" }),
      unsupported: true,
    },
  ])
    await check("UI 无函数 fallback：" + label, () =>
      withSource(settings, {}, async ({ source, searchPage, control }) => {
        const result = await source.findCandidates([target], control.signal);
        if (unsupported) {
          assert.equal(result.items[0].searchState, "unsupported");
          assert.equal(result.searchItems[0].reason, "unsupported_level");
          assert.match(result.items[0].note, /60至160级.*步长10级.*65级装备/);
          assert.deepEqual(result.queries, []);
          assert.deepEqual(marketRequests, []);
          assert.deepEqual(detailVisits, []);
          assert.equal(searchPage.url(), "about:blank");
        } else {
          assert.equal(result.items[0].searchState, "read_failed");
          assert.equal(result.searchItems[0].failure.stage, stage);
        }
        assert.deepEqual(result.items[0].candidates, []);
        if (!unsupported && stage !== "ui_condition_verify")
          assert.deepEqual(await searchPage.evaluate(() => window.calls), []);
      }),
    );

  await check("官网组件丢失3年以上服参数时拒绝使用报价", () =>
    withSource({ dropServerType: true }, {}, async ({ source, control }) => {
      await assert.rejects(
        source.findCandidates([item()], control.signal),
        /三年以上服|3年以上服条件/,
      );
      assert.deepEqual(detailVisits, []);
    }),
  );

  for (const { label, settings } of [
    { label: "helper后注入单服", settings: { marketOverrides: { serverid: "33" } } },
    { label: "helper后注入区域", settings: { marketOverrides: { area_id: "1" } } },
    { label: "helper后扩大服务器年龄", settings: { marketOverrides: { server_type: "2,3" } } },
    { label: "本页没有发市场请求", settings: { omitMarketRequest: true } },
    { label: "市场请求页码与当前页不一致", settings: { marketPageOverride: 2 } },
  ])
    await check(label + "拒绝装备报价，不只相信内存query", () =>
      withSource(settings, {}, async ({ source, control }) => {
        await assert.rejects(
          source.findCandidates([item()], control.signal),
          /全服|三年以上服|3年以上服|请求|限制/,
        );
        assert.deepEqual(detailVisits, []);
      }),
    );

  await check("真实市场请求允许空或0范围，逐页保存不同服务器来源", () =>
    withSource(
      {
        marketOverrides: { serverid: "0", area_id: "" },
        pages: [
          [
            { eid: "server-a", name: "其他装备", serverId: "33" },
            { eid: "server-b", name: "其他装备", serverId: "123" },
          ],
          [{ eid: "server-c", name: "其他装备", serverId: "377" }],
        ],
      },
      {},
      async ({ source, control }) => {
        const result = await source.findCandidates(
          [item({ description: "等级100" })],
          control.signal,
        );
        const evidence = result.searchItems[0].scopeEvidence;
        assert.equal(evidence.length, 2);
        assert.deepEqual(
          evidence.map((entry) => entry.request.page),
          [1, 2],
        );
        assert.deepEqual(
          evidence.map((entry) => entry.request.restrictions),
          [
            { serverid: "0", area_id: "" },
            { serverid: "0", area_id: "" },
          ],
        );
        assert.deepEqual(
          evidence.map((entry) => entry.candidateServers),
          [{ 33: 1, 123: 1 }, { 377: 1 }],
        );
        assert.equal(result.items[0].searchState, "completed");
        assert.deepEqual(detailVisits, []);
      },
    ),
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
  await check("初防衣服全流程：填写、提交、翻页、独立报价核验与均价", async () => {
    const name = "模拟月亮石衣服";
    const description =
      "等级100\n防御296\n耐久300\n锻炼等级8\n镶嵌宝石 月亮石\n熔炼效果：\n+10防御";
    await withSource(
      {
        pages: [
          [
            { eid: "initial-1", name },
            { eid: "initial-bad", name },
          ],
          [{ eid: "initial-2", name }],
        ],
      },
      (eid) => ({
        name,
        description:
          eid === "initial-bad" ? description.replace("防御296", "防御428") : description,
        modelId: 2912,
        kindId: 18,
        price: eid === "initial-2" ? 800 : 600,
        renderedPanel: true,
        selling: 1,
      }),
      async ({ source, searchPage, control }) => {
        const collectedAt = new Date().toISOString();
        const record = {
          listing: { serverId: "1" },
          detail: {
            equipmentCapture: { version: 1, collectedAt, complete: true, issues: [] },
            tabs: [
              {
                name: "道具/法宝",
                text: "",
                fields: [],
                tables: [],
                elements: [],
                tooltips: [],
                items: [
                  {
                    index: 0,
                    kind: "equipment",
                    name,
                    description,
                    category: "人物装备 · 衣服",
                    kindId: "18",
                    modelId: "2912",
                  },
                ],
              },
            ],
          },
        };
        const snapshot = await searchEquipmentPrices(record, control.signal, source);
        assert.equal(snapshot.searchComplete, true);
        assert.equal(snapshot.total, 700);
        assert.equal(snapshot.items[0].referencePrice, 700);
        assert.deepEqual(
          snapshot.items[0].candidates.map((value) => new URL(value.url).searchParams.get("eid")),
          ["initial-1", "initial-2"],
        );
        const calls = await searchPage.evaluate(() => window.calls);
        assert.deepEqual(
          calls.map((call) => call.page),
          [1, 2],
        );
        for (const call of calls) {
          assert.equal(call.kindid, "18");
          assert.equal(call.init_defense, 200);
          assert.equal(call.attr_without_melt, 1);
          assert.equal(call.attr_with_melt, undefined);
        }
        const events = await searchPage.evaluate(() => window.uiEvents);
        assert.ok(
          events.some(
            (event) =>
              event.type === "input" && event.id === "txt_init_defense" && event.value === "200",
          ),
        );
        assert.deepEqual(
          await role.evaluate(() => ({
            url: location.href,
            args: window.QueryArgs,
            checkpoint: window.checkpoint,
          })),
          roleBefore,
        );
        const directory = "data/initial-defense-validation";
        await mkdir(directory, { recursive: true });
        await writeFile(
          path.join(directory, "armor-search-e2e.json"),
          JSON.stringify(
            {
              simulated: true,
              target: { description, initialDefense: 200 },
              calls,
              marketRequests,
              events,
              detailVisits,
              snapshot,
              originalRole: roleBefore,
            },
            null,
            2,
          ),
        );
        await searchPage.screenshot({
          path: path.join(directory, "armor-search-e2e.png"),
          fullPage: true,
        });
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

  await check("先采用同宝石同段匹配，不为已有同配扩大段数或换算总属性", () =>
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
        assert.deepEqual(detailVisits, ["matching"]);
        assert.equal(result.items[0].candidates[0].verified, true);
        assert.equal(result.items[0].candidates.length, 1);
        const [query] = await searchPage.evaluate(() => window.calls);
        assert.equal(query.gem_level, 8);
        assert.equal(query.init_defense, 50);
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

  await check("保存的芙蓉戒属性不含整套生效速度时仍取得五件相近参考", () => {
    const name = "芙蓉戒";
    const description =
      "等级 80\n防御 +21\n耐久度 84\n精炼等级 5\n附加属性：\n法术伤害结果 +8 [+15]\n法术伤害 +8 [+20]\n法术暴击等级 +10 [+20]\n特效：健步如飞（2级）\n速度 +2\n速度+7（已生效）\n装备条件：等级80";
    const standalone = description
      .replace("速度+7（已生效）\n", "")
      .replace("法术伤害 +8 [+20]", "法术伤害 +10 [+20]");
    return withSource(
      {
        jewelry: true,
        pages: [
          Array.from({ length: 5 }, (_, index) => ({
            eid: "jewelry-context-" + index,
            name,
            level: "80",
            kindId: "61",
            description: standalone,
          })),
        ],
      },
      (eid) => ({
        name,
        description: standalone,
        kindId: "61",
        renderedPanel: true,
        selling: 1,
        price: [1000, 1100, 1200, 1300, 1450][Number(eid.slice(-1))],
      }),
      async ({ source, searchPage, control }) => {
        const result = await source.findCandidates(
          [item({ name, level: 80, category: "人物装备 · 戒指", kindId: "61", description })],
          control.signal,
        );
        assert.equal(result.items[0].searchState, "completed");
        assert.equal(result.items[0].candidates.length, 5);
        for (const candidate of result.items[0].candidates) {
          assert.equal(candidate.verified, true);
          assert.equal(candidate.matchType, "similar");
          assert.ok(candidate.differences.includes("已生效套装加成：速度:+7 → 未标明"));
          assert.ok(candidate.differences.includes("法术伤害：+8 [+20] → +10 [+20]"));
          assert.equal(
            candidate.price,
            [1000, 1100, 1200, 1300, 1450][Number(candidate.url.slice(-1))],
          );
        }
        const [query] = await searchPage.evaluate(() => window.calls);
        assert.equal(query.server_type, "3");
        assert.equal(query.kindid, "61");
        assert.equal(query.jinglian_level, 5);
        assert.equal(query.suit_effect, "4");
        assert.equal(query.suit_effect_level, 2);
        assert.equal(detailVisits.length, 5);
        assert.equal(buildEquipmentEstimate(result.items[0].candidates).average, 1210);
        assert.equal(
          result.searchItems[0].scopeEvidence[0].request.searchType,
          "overall_search_lingshi",
        );
        assert.equal(result.searchItems[0].scopeEvidence[0].request.serverType, "3");
        assert.deepEqual(result.searchItems[0].scopeEvidence[0].candidateServers, { 1: 5 });
      },
    );
  });

  await check("保存的明月珰属性按健步2级搜索前五件，主副法伤互换不采纳", () => {
    const name = "明月珰";
    const description =
      "等级 80\n法术伤害 +16\n耐久度 47\n精炼等级 5\n附加属性：\n法术伤害 +12 [+20]\n法术暴击等级 +8 [+20]\n特效：健步如飞（2级）\n速度 +2\n速度+7（已生效）\n装备条件：等级80";
    const standalone = description.replace("附加属性：\n", "").replace("速度+7（已生效）\n", "");
    const swapped = standalone
      .replace("法术伤害 +16", "法术伤害 +12")
      .replace("法术伤害 +12 [+20]", "法术伤害 +16 [+20]");
    return withSource(
      {
        jewelry: true,
        jewelrySuitEffects: ["血气方刚", "通真达灵", "心无旁骛", "健步如飞", 163],
        pages: [
          [
            { eid: "swapped", name, kindId: "62", description: swapped },
            ...Array.from({ length: 5 }, (_, index) => ({
              eid: "ear-" + index,
              name,
              kindId: "62",
              description: standalone,
            })),
          ],
        ],
      },
      { name, description: standalone, kindId: "62", renderedPanel: true, selling: 1 },
      async ({ source, searchPage, control }) => {
        const result = await source.findCandidates(
          [item({ name, level: 80, category: "人物装备 · 耳饰", kindId: "62", description })],
          control.signal,
        );
        const [query] = await searchPage.evaluate(() => window.calls);
        assert.equal(query.suit_effect, "4");
        assert.equal(query.suit_effect_level, 2);
        assert.equal(query.server_type, "3");
        assert.equal(result.items[0].searchState, "completed");
        assert.equal(result.items[0].candidates.length, 5);
        assert.deepEqual(detailVisits, ["ear-0", "ear-1", "ear-2", "ear-3", "ear-4"]);
        for (const candidate of result.items[0].candidates) {
          assert.equal(candidate.verified, true);
          assert.equal(candidate.matchType, "similar");
        }
      },
    );
  });

  await check("主副法伤互换的独立商品详情不被误采纳", () => {
    const name = "明月珰";
    const description =
      "等级80\n法术伤害 +16\n耐久度47\n精炼等级5\n附加属性：\n法术伤害 +12 [+20]\n法术暴击等级 +8 [+20]\n特效：健步如飞（2级）\n速度 +2\n装备条件：等级80";
    const swapped = description
      .replace("附加属性：\n", "")
      .replace("法术伤害 +16", "法术伤害 +12")
      .replace("法术伤害 +12 [+20]", "法术伤害 +16 [+20]");
    return withSource(
      { jewelry: true, pages: [[{ eid: "swapped-ear", name, kindId: "62" }]] },
      { name, description: swapped, kindId: "62", renderedPanel: true, selling: 1 },
      async ({ source, control }) => {
        const result = await source.findCandidates(
          [item({ name, level: 80, category: "人物装备 · 耳饰", kindId: "62", description })],
          control.signal,
        );
        assert.equal(
          result.items[0].candidates.some((candidate) => candidate.verified),
          false,
        );
        const rejected = result.searchItems.flatMap((record) => record.rejectedCandidates || []);
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0].verified, false);
        assert.match(rejected[0].reason, /主属性.*法术伤害.*20%/);
        assert.deepEqual(detailVisits, ["swapped-ear"]);
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

  await check("列表保持官网顺序，详情核验结果不按属性距离重排", () =>
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
        assert.deepEqual(detailVisits, ["near", "exact-0", "exact-1", "exact-2"]);
        assert(result.items[0].candidates.every((candidate) => candidate.matchType === "exact"));
      },
    ),
  );

  await check("同配为空后使用80%下限、3年以上服，取得5件相近样本后停止", () => {
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
        assert.equal(result.items[0].candidates.length, 5);
        assert.equal(detailVisits.length, 5);
        assert.equal(buildEquipmentEstimate(result.items[0].candidates).average, 1100);
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
      { jade: true, pages: [[{ eid: "jade", name, modelId: "61717", level: "0", description }]] },
      { name, description, renderedPanel: true, selling: 1, modelId: 61717 },
      async ({ source, searchPage, control }) => {
        const result = await source.findCandidates(
          [item({ name, description, category: "上古玉魄", modelId: "61717", level: null })],
          control.signal,
        );
        assert.match(searchPage.url(), /show_overall_search_yupo/);
        const call = (await searchPage.evaluate(() => window.calls))[0];
        assert.equal(call.act, "yupo_search");
        assert.equal(result.searchItems[0].scopeEvidence[0].request.searchType, "yupo_search");
        assert.equal(result.searchItems[0].scopeEvidence[0].request.serverType, "3");
        assert.deepEqual(result.searchItems[0].scopeEvidence[0].candidateServers, { 1: 1 });
        assert.equal(call.equip_type, "61717");
        assert.equal(call.level_min, undefined);
        assert.equal(result.items[0].candidates[0].verified, true);
      },
    );
  });

  await check("分散报价仍按官网顺序计均价，继续翻页补到实际八件", () => {
    const rows = (prefix, count) =>
      Array.from({ length: count }, (_, index) => ({
        eid: prefix + index,
        name: equipmentName,
        kindId: "20",
        modelId: "2912",
        level: "100",
      }));
    return withSource(
      { pages: [rows("distant-", 5), rows("closest-", 3)] },
      (eid) => ({
        kindId: 20,
        modelId: 2912,
        renderedPanel: true,
        selling: 1,
        description: equipmentDescription.replace(
          "防御：50",
          eid.startsWith("distant-") ? "防御：55" : "防御：49",
        ),
        price: eid.startsWith("distant-")
          ? (Number(eid.slice(-1)) + 1) * 100
          : 1000 + Number(eid.slice(-1)) * 10,
      }),
      async ({ source, control }) => {
        const input = item({ modelId: "2912" });
        const first = await source.findCandidates([input], control.signal);
        assert.equal(first.items[0].searchState, "completed");
        assert.equal(
          buildEquipmentEstimate(first.items[0].candidates).status,
          "range",
          JSON.stringify(
            first.items[0].candidates.map(({ price, verified, reason }) => ({
              price,
              verified,
              reason,
            })),
          ),
        );
        const finished = first;
        assert.equal(finished.items[0].searchState, "completed");
        const selected = finished.items[0].candidates.filter((value) => value.verified);
        assert.equal(selected.length, 5);
        assert.deepEqual(
          selected.map((value) => value.price),
          [100, 200, 300, 400, 500],
        );
        assert.equal(buildEquipmentEstimate(selected).status, "range");
        assert.equal(buildEquipmentEstimate(selected).average, 300);
        assert.ok(first.searchItems[0].comparableCandidates.length >= 5);
        assert.ok(finished.searchItems[0].comparableCandidates.length >= 5);
      },
    );
  });

  await check("已读完三件时按实际数量计均价，阶段排除项保留审计不纳入", () =>
    withSource(
      {
        pages: [
          ["stage-rejected", "nearest-0", "nearest-1", "nearest-2"].map((eid) => ({
            eid,
            name: equipmentName,
            modelId: "2912",
          })),
        ],
      },
      (eid) => ({
        modelId: 2912,
        description:
          eid === "stage-rejected"
            ? equipmentDescription.replace("特效：愤怒", "特效：暴怒")
            : equipmentDescription.replace("防御：50", "防御：49"),
        price: eid === "stage-rejected" ? 500 : 1000 + Number(eid.slice(-1)) * 10,
      }),
      async ({ source, control }) => {
        const input = item({ modelId: "2912" });
        let result = await source.findCandidates([input], control.signal);
        const records = [...result.searchItems];
        for (let round = 0; round < 3 && result.items[0].searchState === "pending"; round++) {
          result = await source.findCandidates([{ ...input, ...result.items[0] }], control.signal);
          records.push(...result.searchItems);
        }
        assert.equal(result.items[0].searchState, "completed");
        assert.equal(result.items[0].candidates.length, 3);
        assert.ok(
          result.items[0].candidates.every(
            (value) => value.verified && !value.url.includes("stage-rejected"),
          ),
        );
        assert.equal(buildEquipmentEstimate(result.items[0].candidates).average, 1010);
        assert.ok(
          records.some((record) =>
            record.rejectedCandidates?.some((value) => value.url.includes("stage-rejected")),
          ),
        );
      },
    ),
  );

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

  for (const failCount of [2, Infinity]) {
    await check("导航被同页重定向中断时最多重试两次：" + failCount, () =>
      withSource({}, {}, async ({ source, detailPage, control }) => {
        const originalGoto = detailPage.goto.bind(detailPage);
        let attempts = 0;
        detailPage.goto = async (...args) => {
          if (++attempts <= failCount)
            throw new Error("page.goto: Navigation is interrupted by another navigation");
          return originalGoto(...args);
        };
        const read = source.readSource(
          "https://xyq.cbg.163.com/equip?s=1&eid=primary",
          control.signal,
        );
        if (failCount === Infinity) await assert.rejects(read, /interrupted by another navigation/);
        else assert.match(await read, /挂牌价：¥1000/);
        assert.equal(attempts, 3);
      }),
    );
  }
  await check("主商品容器缺少info_panel仍核验价格，不串用同名推荐", () =>
    withSource(
      {},
      {
        renderedPanel: true,
        missingInfoPanel: true,
        selling: 1,
        recommend: true,
        recommendFirst: true,
        recommendSameName: true,
      },
      async ({ source, control }) => {
        const result = await source.findCandidates([item()], control.signal);
        assert.equal(result.items[0].candidates[0].verified, true);
        assert.equal(result.items[0].candidates[0].price, 1000);
      },
    ),
  );
  for (const options of [
    { visiblePrice: false },
    { unsupportedContainer: true },
    { rawPriceValue: 999 },
    { rawEid: "another-product" },
    { selling: 0, status: "已下架" },
  ])
    await check("无info_panel模板保留价格、身份及下架保护：" + JSON.stringify(options), () =>
      withSource(
        {},
        { renderedPanel: true, missingInfoPanel: true, selling: 1, recommend: true, ...options },
        async ({ source, control }) => {
          const result = await source.findCandidates([item()], control.signal);
          assert.equal(
            result.items[0].candidates.some((candidate) => candidate.verified),
            false,
          );
          if (options.visiblePrice === false) assert.equal(detailVisits.length, 3);
          if (options.unsupportedContainer) {
            assert.equal(detailVisits.length, 1);
            assert.equal(result.items[0].searchState, "read_failed");
            assert.match(result.searchItems[0].detailFailures[0].reason, /结构不支持/);
          }
        },
      ),
    );
  await check("直排模板主商品下架，推荐仍上架也不能采用", () =>
    withSource(
      {},
      { renderedPanel: true, selling: 0, status: "上架中", recommend: true },
      async ({ source, control }) => {
        const result = await source.findCandidates([item()], control.signal);
        assert.equal(
          result.items[0].candidates.some((candidate) => candidate.verified),
          false,
        );
        const rejected = result.searchItems.flatMap((record) => record.rejectedCandidates || []);
        assert.match(rejected[0].reason, /下架/);
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

  for (const [label, kindId, modelDescription, valid] of [
    ["官方kind29与目录对象确认", 29, "【装备对象】召唤兽", true],
    ["普通装备kind不能套宠装", 20, "【装备对象】召唤兽", false],
    ["目录无召唤兽对象拒绝", 29, "【装备角色】男", false],
  ])
    await check("宠装主商品 reader：" + label, () =>
      withSource(
        {},
        {
          renderedPanel: true,
          selling: 1,
          kindId,
          modelDescription,
          description: "等级95\n防御30\n耐久300",
        },
        async ({ detailPage, control }) => {
          await detailPage.goto("https://xyq.cbg.163.com/equip?s=1&eid=pet-gear");
          if (valid) {
            const result = await equipmentPageSource(
              bounded(detailPage),
              control.signal,
              "pet-gear",
            );
            assert.equal(result.price, 1000);
            assert.match(result.text, /装备对象.*召唤兽/);
          } else
            await assert.rejects(
              equipmentPageSource(bounded(detailPage), control.signal, "pet-gear"),
              /召唤兽装备/,
            );
        },
      ),
    );

  await check("第二页末尾只有上一页时终止，不再请求第三页", () =>
    withSource(
      { pages: [[{ eid: "first", name: "其他装备" }], [{ eid: "last", name: equipmentName }]] },
      {},
      async ({ source, searchPage, control }) => {
        const input = item();
        const result = await source.findCandidates([input], control.signal);
        assert.equal(result.items[0].searchState, "completed");
        assert.deepEqual(
          (await searchPage.evaluate(() => window.calls)).map((x) => x.page),
          [1, 2],
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
      async ({ source, searchPage, control }) => {
        const input = item();
        const result = await source.findCandidates([input], control.signal);
        assert.equal(result.items[0].searchState, "completed");
        assert.deepEqual(
          (await searchPage.evaluate(() => window.calls)).map((x) => x.page),
          [1, 2],
        );
        assert.deepEqual(detailVisits, ["wrong", "primary"]);
        assert.equal(
          result.items[0].candidates.filter((candidate) => candidate.verified).length,
          1,
        );
        assert.equal(
          result.searchItems[0].rejectedCandidates.find((candidate) =>
            candidate.url.includes("wrong"),
          ).verified,
          false,
        );
        assert.equal(
          result.items[0].candidates.some(
            (candidate) => candidate.url.includes("wrong") && candidate.verified,
          ),
          false,
        );
      },
    ),
  );

  await check("明确零结果才返回空候选", () =>
    withSource({ pages: [[]] }, {}, async ({ source, control }) => {
      const input = item();
      let result = await source.findCandidates([input], control.signal);
      assert.equal(result.items[0].searchState, "completed");
      for (let round = 0; round < 3 && result.items[0].searchState === "pending"; round++)
        result = await source.findCandidates([{ ...input, ...result.items[0] }], control.signal);
      assert.equal(result.items[0].searchState, "completed");
      assert.deepEqual(result.items[0].candidates, []);
      assert.deepEqual(detailVisits, []);
      assert.match(result.items[0].note, /已读完/);
      assert.ok(result.searchItems[0].scopeEvidence.length > 0);
      for (const entry of result.searchItems[0].scopeEvidence) {
        assert.equal(entry.request.serverType, "3");
        assert.equal(entry.rowCount, 0);
        assert.deepEqual(entry.candidateServers, {});
      }
    }),
  );

  await check("详情连续读取失败保留重试URL，恢复后不把失败当作空结果", () =>
    withSource(
      { pages: [[{ eid: "one", name: equipmentName }]] },
      { tooltipMissing: true },
      async ({ source, control }) => {
        const target = item();
        const first = await source.findCandidates([target], control.signal);
        assert.equal(
          first.items[0].searchState,
          "read_failed",
          JSON.stringify({
            item: first.items[0],
            detailFailures: first.searchItems[0]?.detailFailures,
          }),
        );
        assert.equal(first.items[0].searchCursor.failed.length, 1);
        const retry = {
          ...target,
          candidates: first.items[0].candidates,
          searchCursor: first.items[0].searchCursor,
        };
        const second = await source.findCandidates([retry], control.signal);
        assert.equal(second.items[0].searchState, "read_failed");
        assert.deepEqual(second.items[0].searchCursor.failed, first.items[0].searchCursor.failed);
        detailOptions = {};
        const recovered = await source.findCandidates(
          [
            {
              ...retry,
              candidates: second.items[0].candidates,
              searchCursor: second.items[0].searchCursor,
            },
          ],
          control.signal,
        );
        assert.equal(recovered.items[0].searchState, "completed");
        assert.equal(recovered.items[0].candidates[0].verified, true);
        assert.equal(recovered.items[0].candidates[0].price, 1000);
      },
    ),
  );

  for (const mode of ["error", "transport_failure", "stalled", "guard"]) {
    await check(mode + "查询失败或未完成不会假报没有匹配", () =>
      withSource({ mode }, {}, async ({ source, control }) => {
        if (mode === "guard" || mode === "transport_failure")
          await assert.rejects(
            source.findCandidates([item()], control.signal),
            mode === "guard" ? /安全验证/ : /网站繁忙|频率/,
          );
        else {
          const result = await source.findCandidates([item()], control.signal);
          assert.equal(result.items[0].searchState, "read_failed");
          assert.deepEqual(result.items[0].candidates, []);
          assert.ok(result.items[0].searchCursor);
          assert.equal(
            result.searchItems[0].failure.stage,
            mode === "stalled" ? "query_wait" : "listing_read",
          );
          assert.equal(
            result.searchItems[0].failure.diagnostics.publicPath,
            "/cgi-bin/equipquery.py",
          );
          assert.equal(result.searchItems[0].failure.diagnostics.overallSearch, true);
          assert.doesNotMatch(result.items[0].note, /结果已读完/);
        }
        assert.deepEqual(detailVisits, []);
      }),
    );
  }

  await check("第一页列表无同名装备直接换筛选，不查询后续页", () =>
    withSource(
      {
        pages: [
          [{ eid: "wrong", name: "其他装备" }],
          [{ eid: "later-match", name: equipmentName }],
        ],
      },
      {},
      async ({ source, searchPage, control }) => {
        const result = await source.findCandidates(
          [
            item({
              searchCursor: {
                version: 1,
                planHash: "old-policy",
                modeIndex: 0,
                pageNumber: 3,
                rowIndex: 0,
                pageRowsHash: "old",
                seen: [],
                failed: [],
              },
            }),
          ],
          control.signal,
        );
        const calls = await searchPage.evaluate(() => window.calls);
        assert.ok(calls.length >= 1);
        assert.ok(calls.every((call) => call.page === 1));
        assert.deepEqual(detailVisits, []);
        assert.equal(result.items[0].samplingStopped, true);
        assert.equal(result.items[0].searchState, "pending");
        assert.match(result.items[0].note, /后续页未查询/);
        assert.ok(result.searchItems[0].modes.every((mode) => mode.exhausted === false));
      },
    ),
  );
  await check("第一页有价格但核验零有效样本，也不翻后续页", () =>
    withSource(
      {
        pages: [
          [{ eid: "rejected", name: equipmentName }],
          [{ eid: "later-match", name: equipmentName }],
        ],
      },
      (id) => ({
        description:
          id === "rejected"
            ? equipmentDescription.replace("防御：50", "防御：99")
            : equipmentDescription,
      }),
      async ({ source, searchPage, control }) => {
        const result = await source.findCandidates([item()], control.signal);
        assert.ok((await searchPage.evaluate(() => window.calls)).every((call) => call.page === 1));
        assert.deepEqual(detailVisits, ["rejected"]);
        assert.equal(result.items[0].samplingStopped, true);
        assert.equal(
          result.items[0].candidates.some((candidate) => candidate.verified),
          false,
        );
        assert.ok(
          result.searchItems[0].rejectedCandidates.some(
            (candidate) => candidate.price === 1000 && !candidate.verified,
          ),
        );
      },
    ),
  );
  await check("第一页有有效样本时继续第二页，仍取前五件", () =>
    withSource(
      {
        pages: [
          [{ eid: "first-valid", name: equipmentName }],
          Array.from({ length: 9 }, (_, i) => ({ eid: "next-valid-" + i, name: equipmentName })),
        ],
      },
      {},
      async ({ source, searchPage, control }) => {
        const result = await source.findCandidates([item()], control.signal);
        assert.deepEqual(
          (await searchPage.evaluate(() => window.calls)).map((call) => call.page),
          [1, 2],
        );
        assert.equal(
          result.items[0].candidates.filter((candidate) => candidate.verified).length,
          5,
        );
        assert.equal(result.items[0].searchState, "completed");
        assert.notEqual(result.items[0].samplingStopped, true);
        assert.equal(
          new URL(result.items[0].candidates[0].url).searchParams.get("eid"),
          "first-valid",
        );
      },
    ),
  );
  await check("保存的两条参考刷新途中超时，保留全部旧候选和后件断点", async () => {
    const fixture = {
      pages: Array.from({ length: 4 }, () => [
        { eid: "saved-1", name: equipmentName },
        { eid: "saved-2", name: equipmentName },
      ]),
    };
    const details = (eid) => ({
      kindId: "20",
      description: equipmentDescription.replace(
        "防御：50",
        eid === "saved-1" ? "防御：49" : "防御：51",
      ),
    });
    let saved;
    await withSource(fixture, details, async ({ source, control }) => {
      const originalNow = Date.now,
        baseline = originalNow();
      onDetailVisit = () => {
        if (detailVisits.length === 2) Date.now = () => baseline + 180_001;
      };
      try {
        saved = (await source.findCandidates([item({ kindId: "20" })], control.signal)).items[0];
      } finally {
        Date.now = originalNow;
        onDetailVisit = null;
      }
      assert.equal(saved.searchState, "pending");
      assert.equal(
        saved.candidates.filter((candidate) => candidate.verified).length,
        2,
        JSON.stringify(saved),
      );
    });
    await withSource(fixture, details, async ({ source, control }) => {
      const originalNow = Date.now;
      const baseline = originalNow();
      onDetailVisit = () => {
        Date.now = () => baseline + 180_001;
      };
      try {
        const untouched = item({ key: "later-item", ...saved });
        const result = await source.findCandidates(
          [
            { ...item({ kindId: "20" }), ...saved },
            { ...untouched, key: "later-item" },
          ],
          control.signal,
        );
        assert.deepEqual(detailVisits, ["saved-1"]);
        assert.equal(result.items[0].skipped, true);
        assert.deepEqual(result.items[0].candidates, saved.candidates);
        assert.deepEqual(result.items[0].searchCursor, saved.searchCursor);
        assert.equal(result.searchItems[0].reason, "candidate_refresh_budget");
        assert.equal(result.searchItems[0].refreshed, 1);
        assert.equal(result.items[1].skipped, true);
        assert.deepEqual(result.items[1].candidates, saved.candidates);
        assert.deepEqual(result.items[1].searchCursor, saved.searchCursor);
      } finally {
        Date.now = originalNow;
        onDetailVisit = null;
      }
    });
  });

  await check("前排装备详情失败不跳过它凑五件，重试后仍保留官网商品顺序", () =>
    withSource(
      {
        pages: [
          Array.from({ length: 12 }, (_, index) => ({
            eid: `failure-${index}`,
            name: equipmentName,
          })),
        ],
      },
      (id) => ({ tooltipMissing: id === "failure-1" }),
      async ({ source, control }) => {
        const first = (await source.findCandidates([item()], control.signal)).items[0];
        assert.equal(first.searchState, "read_failed");
        assert.deepEqual(detailVisits, ["failure-0", "failure-1", "failure-1", "failure-1"]);
        assert.equal(first.candidates.filter((x) => x.verified).length, 1);
        detailOptions = {};
        const second = (await source.findCandidates([{ ...item(), ...first }], control.signal))
          .items[0];
        assert.equal(second.searchState, "completed", second.note);
        assert.deepEqual(
          second.candidates
            .filter((x) => x.verified)
            .map((x) => new URL(x.url).searchParams.get("eid")),
          Array.from({ length: 5 }, (_, index) => `failure-${index}`),
        );
        assert.ok(!detailVisits.includes("failure-5"));
      },
    ),
  );

  await check("续查页面重排或清空时丢弃旧候选，从第一页重建官网取样顺序", async () => {
    const rows = Array.from({ length: 21 }, (_, index) => ({
      eid: `order-${index}`,
      name: equipmentName,
    }));
    const detail = (id) => ({
      description:
        Number(id.split("-").at(-1)) < 19
          ? equipmentDescription.replace("防御：50", "防御：99")
          : equipmentDescription,
    });
    let saved;
    await withSource({ pages: [rows] }, detail, async ({ source, control }) => {
      const originalNow = Date.now,
        baseline = originalNow();
      onDetailVisit = () => {
        if (detailVisits.length === 20) Date.now = () => baseline + 180_001;
      };
      try {
        saved = (await source.findCandidates([item()], control.signal)).items[0];
      } finally {
        Date.now = originalNow;
        onDetailVisit = null;
      }
      assert.equal(saved.searchState, "pending");
      assert.equal(saved.candidates.filter((x) => x.verified).length, 1);
    });
    for (const changed of [[rows[20], ...rows.slice(0, 20)], []]) {
      await withSource({ pages: [changed] }, detail, async ({ source, control }) => {
        const result = await source.findCandidates([{ ...item(), ...saved }], control.signal);
        const reset = result.items[0];
        assert.equal(reset.searchState, "pending", reset.note);
        assert.deepEqual(reset.candidates, []);
        assert.equal(reset.searchCursor.rowIndex, 0);
        assert.equal(reset.searchCursor.pageNumber, 1);
        assert.equal(reset.searchCursor.restartCount, 1);
        assert.deepEqual(reset.searchCursor.seen, []);
        assert.ok(result.searchItems.some((x) => x.reason === "result_order_changed"));
        if (changed.length) {
          let rebuilt = reset;
          for (let round = 0; round < 2 && rebuilt.searchState === "pending"; round++)
            rebuilt = (await source.findCandidates([{ ...item(), ...rebuilt }], control.signal))
              .items[0];
          assert.equal(rebuilt.searchState, "completed", rebuilt.note);
          assert.deepEqual(
            rebuilt.candidates
              .filter((x) => x.verified)
              .map((x) => new URL(x.url).searchParams.get("eid")),
            ["order-20", "order-19"],
          );
        }
      });
    }
  });

  await check("续查当前页未变也复核已读前页，新增前排商品使旧取样失效", async () => {
    const rows = Array.from({ length: 22 }, (_, index) => ({
      eid: `prefix-${index}`,
      name: equipmentName,
    }));
    const detail = (id) => ({
      description:
        id === "prefix-new" || Number(id.split("-").at(-1)) >= 18
          ? equipmentDescription
          : equipmentDescription.replace("防御：50", "防御：99"),
    });
    let saved;
    await withSource(
      { pages: [rows.slice(0, 20), rows.slice(20)] },
      detail,
      async ({ source, control }) => {
        const originalNow = Date.now,
          baseline = originalNow();
        onDetailVisit = () => {
          if (detailVisits.length === 20) Date.now = () => baseline + 180_001;
        };
        try {
          saved = (await source.findCandidates([item()], control.signal)).items[0];
        } finally {
          Date.now = originalNow;
          onDetailVisit = null;
        }
        assert.equal(saved.searchCursor.pageNumber, 2);
        assert.equal(saved.searchCursor.pageHistory[0].pageNumber, 1);
      },
    );
    await withSource(
      {
        pages: [[{ eid: "prefix-new", name: equipmentName }, ...rows.slice(1, 20)], rows.slice(20)],
      },
      detail,
      async ({ source, control }) => {
        const reset = (await source.findCandidates([{ ...item(), ...saved }], control.signal))
          .items[0];
        assert.equal(reset.searchState, "pending");
        assert.deepEqual(reset.candidates, []);
        assert.equal(reset.searchCursor.restartCount, 1);
        let rebuilt = reset;
        for (let round = 0; round < 4 && rebuilt.searchState === "pending"; round++)
          rebuilt = (await source.findCandidates([{ ...item(), ...rebuilt }], control.signal))
            .items[0];
        assert.equal(rebuilt.searchState, "completed");
        assert.deepEqual(
          rebuilt.candidates.map((value) => new URL(value.url).searchParams.get("eid")),
          ["prefix-new", "prefix-18", "prefix-19", "prefix-20", "prefix-21"],
        );
      },
    );
  });

  await check("玉魄相近查价通过专用表单放宽基础下限，保护加成与槽位", () => {
    const name = "上古玉魄·阴",
      description = "防御 +25\n耐久度 102\n抵抗封印等级 +13 [+48]\n气血 +67 [+168]\n奇袭道具: [空]";
    return withSource(
      { jade: true, pages: [[{ eid: "jade-near", name, modelId: "61717" }]] },
      {
        name,
        modelId: 61717,
        description: description.replace("+13 [+48]", "+15 [+48]"),
        renderedPanel: true,
        selling: 1,
        price: 250,
      },
      async ({ source, searchPage, control }) => {
        const result = await source.findCandidates(
          [item({ name, category: "上古玉魄", modelId: "61717", level: null, description })],
          control.signal,
        );
        assert.equal(result.items[0].searchState, "completed", result.items[0].note);
        assert.equal(result.items[0].candidates[0].matchType, "similar");
        const calls = await searchPage.evaluate(() => window.calls);
        assert.equal(calls[0].init_attrs, '{"102":"25"}');
        assert.equal(calls.at(-1).init_attrs, '{"102":"20"}');
        assert.ok(calls.every((call) => call.server_type === "3" && call.level_min === undefined));
      },
    );
  });

  await check("零样本首屏立即切换阶段，不为行预算继续翻页", () =>
    withSource(
      {
        pages: Array.from({ length: 6 }, (_, page) =>
          Array.from({ length: 30 }, (_, row) => ({ eid: `${page}-${row}`, name: "其他装备" })),
        ),
      },
      {},
      async ({ source, searchPage, control }) => {
        const result = await source.findCandidates(
          [item({ description: "等级100" })],
          control.signal,
        );
        assert.ok((await searchPage.evaluate(() => window.calls)).every((call) => call.page === 1));
        assert.equal(result.items[0].samplingStopped, true);
        assert.deepEqual(detailVisits, []);
      },
    ),
  );
  await check("最多读取一百个详情，达到五件有效同配报价立即停", async () => {
    await withSource(
      {
        pages: Array.from({ length: 1 }, (_, page) =>
          Array.from({ length: 105 }, (_, row) => ({
            eid: `${page}-${row}`,
            name: equipmentName,
          })),
        ),
      },
      { description: equipmentDescription.replace("防御：50", "防御：99") },
      async ({ source, searchPage, control }) => {
        const input = item({ description: "等级100" });
        const result = await source.findCandidates([input], control.signal);
        assert.equal(detailVisits.length, 100);
        assert.match(result.items[0].note, /100个详情/);
        assert.equal(result.items[0].searchState, "pending");
        assert.equal(result.items[0].searchCursor.rowIndex, 100);
        const resumed = await source.findCandidates(
          [{ ...input, ...result.items[0] }],
          control.signal,
        );
        assert.equal(resumed.searchItems[0].details, 5);
        assert.equal(resumed.items[0].searchState, "completed");
        assert.equal(detailVisits.length, 105);
        assert.equal(new Set(detailVisits).size, 105);
        assert.deepEqual(
          (await searchPage.evaluate(() => window.calls)).map((x) => x.page),
          [1],
        );
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
        assert.equal(detailVisits.length, 5);
        assert.equal(result.items[0].candidates.length, 5);
      },
    );
  });

  await check("单页11条取到5件早停，不能误报所有商品已读完", () =>
    withSource(
      {
        pages: [
          Array.from({ length: 11 }, (_, row) => ({
            eid: "four-" + row,
            name: equipmentName,
          })),
        ],
      },
      {},
      async ({ source, control }) => {
        const result = await source.findCandidates([item()], control.signal);
        assert.equal(detailVisits.length, 5);
        assert.equal(result.items[0].candidates.length, 5);
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
