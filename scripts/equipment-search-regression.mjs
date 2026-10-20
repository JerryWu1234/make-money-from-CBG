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
    let body,
      status = 200;
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
      status = settings.httpStatus || 200;
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
      await route.fulfill({ status, contentType: "text/html; charset=utf-8", body });
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
      "1",
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

  await check(
    "初始值升序592：忽略表单和隐藏副本、兼容排序箭头、扣宝石填写下限、反向切换升序、固定前五条最低价",
    async () => {
      const description = "等级：100\n伤害：632\n宝石：太阳石\n锻炼等级：5\n耐久：300\n修理失败：0";
      const values = [650, 592, 592, 592, 592, 592, 592, 580];
      const rows = values.map((value, index) => ({
        eid: "initial-" + index,
        name: "测试剑",
        kindId: 6,
        rawAttributes: { init_damage_raw: value, init_damage: value },
      }));
      await withSource(
        {
          initialSort: true,
          initialSortArrows: true,
          duplicateInitialHeaders: true,
          pages: [rows],
        },
        (eid) => ({
          name: "测试剑",
          kindId: 6,
          price: 100 + Number(eid.split("-")[1]),
          description:
            description.replace("伤害：632", "伤害：" + (values[Number(eid.split("-")[1])] + 40)) +
            (eid === "initial-1" ? "\n特技：破血狂攻" : ""),
        }),
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
                      name: "测试剑",
                      category: "人物装备 · 剑",
                      kindId: "6",
                      description,
                    },
                  ],
                },
              ],
            },
          };
          const result = await searchEquipmentPrices(record, control.signal, source);
          assert.equal(result.searchComplete, true);
          assert.equal(result.items[0].referencePrice, 102);
          assert.equal(result.items[0].candidates.filter((row) => row.verified).length, 4);
          assert.deepEqual(detailVisits, [
            "initial-7",
            "initial-1",
            "initial-2",
            "initial-3",
            "initial-4",
          ]);
          const calls = await searchPage.evaluate(() => window.calls);
          assert.ok(calls.every((call) => call.init_damage_raw === 0));
          assert.equal(calls.at(-1).order_by, "init_damage ASC");
          const ui = result.searchItems.find((record) => record.uiQueries)?.uiQueries[0];
          assert.deepEqual(
            ui.actions.filter((action) => action.control === "初伤").map((action) => action.value),
            ["DESC", "ASC"],
          );
          assert.deepEqual(
            ui.sortRequests.map((request) => request.orderBy),
            ["init_damage DESC", "init_damage ASC"],
          );
          assert.equal(
            result.searchItems.find((record) => record.modes)?.modes[0].samplingBasis,
            "first-candidates",
          );
          assert.ok(
            result.searchItems.some((record) =>
              record.scopeEvidence?.some((e) => e.request.orderBy === "init_damage ASC"),
            ),
          );
        },
      );
    },
  );

  await check("武器初伤宽搜：初伤值为0，详情核验扣宝石后的基础属性不高于目标", () =>
    withSource(
      {
        initialSort: true,
        initialSortArrows: true,
        pages: [
          Array.from({ length: 6 }, (_, index) => ({
            eid: "hit-four-" + index,
            name: "测试剑",
            kindId: 6,
            rawAttributes: {
              init_damage_raw: 388,
              all_damage: index ? 500.75 : 500.5,
              init_damage: 600 + index,
            },
          })),
        ],
      },
      (eid) => ({
        name: "测试剑",
        kindId: 6,
        price: 100,
        description: "等级100\n伤害388\n命中" + (eid.endsWith("-0") ? 450 : 451),
      }),
      async ({ source, searchPage, control }) => {
        const result = await source.findCandidates(
          [
            item({
              name: "测试剑",
              category: "人物装备 · 剑",
              kindId: "6",
              description: "等级100\n伤害428\n命中451\n宝石：太阳石\n锻炼等级5",
              comparisonPolicy: "core-initial-first-five-v3",
            }),
          ],
          control.signal,
        );
        const calls = await searchPage.evaluate(() => window.calls);
        assert.ok(
          calls.every(
            (call) =>
              call.all_damage === undefined &&
              call.init_damage_raw === 0 &&
              call.init_damage === undefined,
          ),
        );
        assert.equal(await searchPage.locator("#txt_all_damage").inputValue(), "");
        assert.equal(await searchPage.locator("#txt_init_damage").inputValue(), "");
        assert.equal(await searchPage.locator("#txt_init_damage_raw").inputValue(), "0");
        assert.equal(
          result.items[0].candidates.filter((candidate) => candidate.verified).length,
          5,
        );
        assert.equal(detailVisits.length, 5);
      },
    ),
  );

  for (const requiredSuit of [false, true])
    await check(
      `前五条固定范围：${requiredSuit ? "相同套装参与筛选，名称不同的套装拒绝" : "属性相等或低于目标才可参考"}`,
      () =>
        withSource(
          {
            initialSort: true,
            initialSortArrows: true,
            suitTransformSkills: { 如意仙子: 1030 },
            pages: [
              Array.from({ length: 6 }, (_, i) => ({
                eid: "bounded-" + i,
                name: equipmentName,
                level: 70,
                kindId: 20,
                rawAttributes: { init_hp: 140 },
              })),
              [
                {
                  eid: "second-page",
                  name: equipmentName,
                  level: 70,
                  kindId: 20,
                  rawAttributes: { init_hp: 140 },
                },
              ],
            ],
          },
          (eid) => {
            const i = Number(eid.split("-")[1]);
            return {
              name: equipmentName,
              kindId: 20,
              price: [60, 40, 55, 20, 30, 1][i],
              description:
                `等级70\n气血140\n防御${38 - i}` +
                (requiredSuit ? `\n套装效果：变身术之${i === 0 ? "鬼将" : "如意仙子"}` : ""),
            };
          },
          async ({ source, searchPage, control }) => {
            const result = await source.findCandidates(
              [
                item({
                  level: 70,
                  kindId: "20",
                  comparisonPolicy: "base-upper-bound-v1",
                  description:
                    "等级70\n气血140\n防御38" +
                    (requiredSuit ? "\n套装效果：变身术之如意仙子" : ""),
                }),
              ],
              control.signal,
            );
            assert.equal(result.items[0].searchState, "completed", result.items[0].note);
            const valid = result.items[0].candidates.filter((c) => c.verified);
            assert.equal(valid.length, requiredSuit ? 4 : 5);
            assert.equal(Math.min(...valid.map((c) => c.price)), 20);
            assert.deepEqual(
              detailVisits,
              Array.from({ length: 5 }, (_, i) => "bounded-" + i),
            );
            const calls = await searchPage.evaluate(() => window.calls);
            assert.ok(
              calls.every(
                (call) =>
                  call.page === 1 &&
                  call.level_min === 70 &&
                  call.level_max === 70 &&
                  call.init_hp === 0,
              ),
            );
            assert.ok(
              calls.every((call) =>
                requiredSuit ? String(call.suit_effect) === "1030" : !call.suit_effect,
              ),
            );
            assert.equal(calls.at(-1).order_by, "init_hp ASC");
            const record = result.searchItems.find((r) => r.modes);
            assert.equal(record.modes[0].sampled, 5);
            assert.equal(record.modes[0].samplingComplete, true);
            assert.equal(record.exhausted, false);
          },
        ),
    );

  for (const missingSort of [false, true])
    await check(
      `初始值升序592：${missingSort ? "缺少排序控件停止，不采用报价" : "最低595超出2点范围仍拒绝，泛称装备也不误采较高初伤"}`,
      () =>
        withSource(
          {
            initialSort: true,
            missingInitialSort: missingSort,
            namedModels: { "100_6": [{ value: 1234, label: "测试剑" }] },
            pages: [
              [
                {
                  eid: "no-equal",
                  name: "测试剑",
                  kindId: 6,
                  rawAttributes: { init_damage_raw: 595, init_damage: 595 },
                },
              ],
            ],
          },
          { name: "测试剑", kindId: 6, description: "等级100\n伤害595", price: 100 },
          async ({ source, control }) => {
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
                        name: "测试剑",
                        category: "人物装备",
                        description: "等级100\n伤害592",
                      },
                    ],
                  },
                ],
              },
            };
            const pending = searchEquipmentPrices(record, control.signal, source);
            if (missingSort) await assert.rejects(pending, /排序表头.*未采用报价/);
            else {
              const result = await pending;
              assert.equal(result.items[0].referencePrice, null);
              assert.equal(result.items[0].searchState, "skipped");
              assert.ok(result.items[0].candidates.every((row) => !row.verified));
              assert.equal(result.knownTotal, 0);
            }
          },
        ),
    );

  await check("核心初始值无法还原的泛称装备按官网类型跳过，后件继续取得最低价", () =>
    withSource(
      {
        namedModels: { "100_6": [{ value: 1234, label: "混合宝石剑" }] },
        pages: [[{ eid: "core-good", name: equipmentName }]],
      },
      { price: 123 },
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
                    name: "混合宝石剑",
                    category: "人物装备",
                    description:
                      "等级100\n伤害581\n命中750\n气血0\n锻炼等级10\n宝石：太阳石 红玛瑙",
                  },
                  {
                    index: 1,
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
        assert.equal(result.searchComplete, true);
        assert.equal(result.items[0].searchState, "skipped");
        assert.match(result.items[0].skipReason, /初始伤害/);
        assert.equal(result.items[0].referencePrice, null);
        assert.deepEqual(result.items[0].candidates, []);
        assert.equal(result.items[1].referencePrice, 123);
        assert.equal(result.knownTotal, 123);
        assert.deepEqual(detailVisits, ["core-good"]);
        const calls = await searchPage.evaluate(() => window.calls);
        assert.ok(
          calls.every(
            (call) => call.kindid === "20" && call.init_hp === 0 && call.serverid === "1",
          ),
        );
        assert.ok(!result.queries.some((query) => query.includes("混合宝石剑")));
        if (process.env.CBG_CORE_PROOF)
          await writeFile(
            process.env.CBG_CORE_PROOF,
            JSON.stringify(
              {
                state: "passed",
                at: new Date().toISOString(),
                snapshot: result,
                calls,
                detailVisits,
              },
              null,
              2,
            ),
          );
      },
    ),
  );

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

  await check("普通无匹配装备在单服单条件读完后跳过，仍没有0元价格", () =>
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
      assert.equal(result.items[0].searchState, "skipped");
      assert.equal(result.items[0].referencePrice, null);
      assert.equal(result.total, null);
      assert.ok(result.searchItems[0].modes.every((stage) => stage.exhausted));
    }),
  );

  await check("前五件最低价完整经过表单提交、翻页、详情核验和计价，不读取第六件", () => {
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
        assert.equal(result.total, 100, JSON.stringify(result));
        assert.equal(result.searchComplete, true);
        assert.equal(result.items[0].referencePrice, 100);
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
          [1, 1, 1],
        );
        assert.ok(
          calls.every(
            (call) =>
              call.serverid === "1" && call.server_type === undefined && call.level_min === 100,
          ),
        );
        assert.equal(result.searchItems[0].uiQueries[0].submittedArgs.gem_level, undefined);
      },
    );
  });

  await check("前五条仅三件可核验时取最低价，不补第六条", () =>
    withSource(
      {
        pages: [
          Array.from({ length: 6 }, (_, i) => ({ eid: "bounded-" + i, name: equipmentName })),
        ],
      },
      (id) => ({
        description: [1, 3].includes(Number(id.split("-")[1]))
          ? equipmentDescription.replace("气血：250", "气血：251")
          : equipmentDescription,
        price: [300, 1, 200, 1, 400, 1][Number(id.split("-")[1])],
      }),
      async ({ source, control }) => {
        const capturedAt = new Date().toISOString();
        const record = {
          listing: { serverId: "1" },
          detail: {
            collectedAt: capturedAt,
            equipmentCapture: { version: 1, collectedAt: capturedAt, complete: true, issues: [] },
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
        assert.equal(result.searchComplete, true);
        assert.equal(result.total, 200);
        assert.deepEqual(
          result.items[0].candidates.filter((c) => c.verified).map((c) => c.price),
          [300, 200, 400],
        );
        assert.deepEqual(
          detailVisits,
          Array.from({ length: 5 }, (_, i) => "bounded-" + i),
        );
        assert.deepEqual(result.searchItems[0].modes[0], {
          ...result.searchItems[0].modes[0],
          sampleLimit: 5,
          sampled: 5,
          samplingComplete: true,
          exhausted: false,
        });
        await mkdir("data/pr27-fix-validation", { recursive: true });
        await writeFile(
          "data/pr27-fix-validation/equipment-first-five-minimum.json",
          JSON.stringify(
            {
              simulated: true,
              scenario: "仅核验排序后前五条商品，其中三条可核验取最低价，不读第六条",
              result,
              detailVisits,
            },
            null,
            2,
          ),
        );
      },
    ),
  );

  await check("前五件相近报价保留官网顺序，不按属性距离重新挑样本", () => {
    const prices = [145, 100, 130, 110, 120, 101, 102, 103, 104, 105, 1];
    const defenses = [45, 49, 44, 48, 41, 42, 43, 49, 47, 46, 50];
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

  await check("官方列表仅查询目标服，取实际href、主商品价格和查询记录", () =>
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
      assert.equal(query.serverid, "1");
      assert.equal(query.server_type, undefined);
      assert.equal(result.searchItems[0].serverId, "1");
      assert.equal(
        result.searchItems[0].searchUrl,
        "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=show_overall_search_equip",
      );
      assert.equal(result.searchItems[0].uiQueries[0].submittedArgs.gem_level, undefined);
      assert.deepEqual(result.searchItems[0].scopeEvidence, [
        {
          mode: "base-attributes",
          request: {
            endpoint: "https://xyq.cbg.163.com/cgi-bin/recommend.py",
            act: "recommd_by_role",
            searchType: "overall_search_equip",
            serverType: "",
            page: 1,
            orderBy: "init_hp ASC",
            restrictions: { serverid: "1" },
          },
          rowCount: 1,
          candidateServers: { 1: 1 },
        },
      ]);
      assert.equal(await searchPage.evaluate(() => window.historyWrites), 1);
      const events = await searchPage.evaluate(() => window.uiEvents);
      assert.ok(
        events.some(
          (event) =>
            event.type === "change" && event.id === "ovarall_sel_server" && event.value === "1",
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
    { category: "剑", field: "伤害", parameter: "init_damage_raw", raw: 300, melting: -10 },
    { category: "饰品", field: "灵力", parameter: "init_wakan", raw: 100, melting: -5 },
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
          assert.equal(query[sample.parameter], 0);
          assert.equal(
            query.attr_without_melt,
            1,
            JSON.stringify({
              request: marketRequests[0],
              rows: result.searchItems[0].scopeEvidence[0].rowCount,
            }),
          );
          assert.equal(query.attr_with_melt, undefined);
          assert.equal(marketRequests[0][sample.parameter], "0");
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
      expected: {},
    },
    {
      label: "简易灵饰",
      input: item({
        name: "芙蓉戒",
        category: "人物装备 · 戒指",
        kindId: "61",
        level: 80,
        description:
          "等级80\n防御21\n精炼等级5\n附加属性：\n法术伤害8[+20]\n速度8[+15]\n特效：健步如飞（2级）\n速度+2\n特效：简易",
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
      expected: { kindid: "19", level_min: 70, level_max: 70 },
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
      settings: { dropUiField: "kindid" },
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

  await check("官网组件丢失目标服务器参数时拒绝使用报价", () =>
    withSource({ dropServerId: true }, {}, async ({ source, control }) => {
      await assert.rejects(source.findCandidates([item()], control.signal), /单服|服务器/);
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
          /单服|服务器|请求|限制/,
        );
        assert.deepEqual(detailVisits, []);
      }),
    );

  await check("目标单服请求保留逐页证据，不从其他服务器读取详情", () =>
    withSource(
      {
        marketOverrides: { area_id: "" },
        pages: [
          [{ eid: "other-server", name: equipmentName, serverId: "33" }],
          [{ eid: "target-server", name: equipmentName }],
        ],
      },
      {},
      async ({ source, control }) => {
        const result = await source.findCandidates([item()], control.signal);
        assert.deepEqual(
          result.searchItems[0].scopeEvidence.map((entry) => entry.request.page),
          [1, 2],
        );
        assert(
          result.searchItems[0].scopeEvidence.every(
            (entry) =>
              entry.request.restrictions.serverid === "1" && entry.request.serverType === "",
          ),
        );
        assert.deepEqual(detailVisits, ["target-server"]);
        assert.equal(result.items[0].candidates[0].verified, true);
      },
    ),
  );

  for (const missingConfig of [false, true])
    await check(
      `普通套装映射${missingConfig ? "缺失阻止提交不完整条件" : "存在时提交实际套装条件"}`,
      () => {
        const name = "风月宝链",
          description = "等级60\n灵力56\n耐久126\n套装效果：附加状态炼气化神\n装备条件：等级60";
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
            if (missingConfig) {
              assert.deepEqual(calls, []);
              assert.deepEqual(marketRequests, []);
              assert.deepEqual(detailVisits, []);
              assert.equal(result.items[0].searchState, "read_failed");
              assert.match(result.items[0].note, /套装.*唯一.*官网/);
              assert.equal(result.searchItems[0].failure.stage, "configuration");
            } else {
              assert.equal(calls[0].suit_effect, "4013");
              assert.equal(result.searchItems[0].args.suit_effect, "4013");
              assert.equal(result.searchItems[0].modes[0].args.suit_effect, "4013");
              assert.equal(result.items[0].candidates[0].verified, true);
              const actions = result.searchItems[0].uiQueries[0].actions;
              assert.ok(
                actions.some(
                  (action) => action.control === "radio_added_status" && action.method === "check",
                ),
              );
              assert.ok(
                actions.some(
                  (action) => action.control === "txt_added_status" && action.value === "炼气化神",
                ),
              );
            }
          },
        );
      },
    );

  for (const sample of [
    {
      label: "附加状态变身",
      suit: "附加状态变身",
      actual: "附加状态变身",
      id: "4011",
      control: "added_status",
      value: "变身",
      valid: true,
    },
    {
      label: "变身术之鬼将",
      suit: "变身术之鬼将",
      actual: "变身术之鬼将",
      id: "1061",
      control: "transform_skill",
      value: "鬼将",
      valid: true,
    },
    {
      label: "变身术之鬼将不能替代附加状态变身",
      suit: "附加状态变身",
      actual: "变身术之鬼将",
      id: "4011",
      control: "added_status",
      value: "变身",
      valid: false,
    },
    {
      label: "无套装目标拒绝额外套装",
      actual: "附加状态变身",
      valid: false,
    },
  ])
    await check("实际完整套装及特技控件核验：" + sample.label, () => {
      const description = equipmentDescription + "\n特技：破血狂攻";
      return withSource(
        { pages: [[{ eid: "actual-suit", name: equipmentName }]] },
        { description: description + "\n套装效果：" + sample.actual, kindId: "20" },
        async ({ source, searchPage, control }) => {
          const result = await source.findCandidates(
            [
              item({
                description: description + (sample.suit ? "\n套装效果：" + sample.suit : ""),
              }),
            ],
            control.signal,
          );
          const [query] = await searchPage.evaluate(() => window.calls);
          assert.equal(query.special_skill, "1036");
          assert.equal(query.suit_effect, sample.id);
          assert.equal(marketRequests[0].special_skill, "1036");
          assert.equal(marketRequests[0].suit_effect, sample.id);
          const actions = result.searchItems[0].uiQueries[0].actions;
          if (sample.control) {
            assert.ok(
              actions.some(
                (action) =>
                  action.control === "radio_" + sample.control && action.method === "check",
              ),
            );
            assert.ok(
              actions.some(
                (action) =>
                  action.control === "txt_" + sample.control && action.value === sample.value,
              ),
            );
            assert.ok(!actions.some((action) => action.control === "radio_short_cut"));
          }
          assert.equal(
            result.items[0].candidates.some((candidate) => candidate.verified),
            sample.valid,
          );
          await mkdir("data/pr27-fix-validation", { recursive: true });
          await writeFile(
            "data/pr27-fix-validation/actual-suit-" +
              (sample.id || "none") +
              "-" +
              sample.valid +
              ".json",
            JSON.stringify({ simulated: true, sample, query, marketRequests, result }, null, 2),
          );
        },
      );
    });

  for (const sample of [
    {
      suit: "变身术之黑熊",
      type: "transform_skill",
      setting: "suitTransformSkills",
      id: "1016",
      values: { 黑熊: 1016, 黑熊精: 1027 },
    },
    {
      suit: "变化咒之黑熊",
      type: "transform_charm",
      setting: "suitTransformCharms",
      id: "2010",
      values: { 黑熊: 2010, 黑熊精: 2021 },
    },
    {
      suit: "追加法术烈火",
      type: "append_skill",
      setting: "suitAppendSkills",
      id: "3039",
      values: { 烈火: 3039, 地狱烈火: 3043 },
    },
  ])
    for (const shortcut of [true, false])
      await check("套装子串冲突使用同ID实际快捷选项：" + sample.suit + " / " + shortcut, () => {
        const description = equipmentDescription + "\n套装效果：" + sample.suit;
        return withSource(
          {
            [sample.setting]: sample.values,
            // A global ID is insufficient: the selected option must really exist in the DOM.
            suitEffects: [[Number(sample.id), sample.suit]],
            suitShortcutOptions: shortcut ? [[Number(sample.id), sample.suit]] : [[4005, "逆鳞"]],
            pages: [[{ eid: "substring-suit", name: equipmentName }]],
          },
          { description, kindId: "20" },
          async ({ source, searchPage, control }) => {
            const result = await source.findCandidates([item({ description })], control.signal);
            const calls = await searchPage.evaluate(() => window.calls);
            if (shortcut) {
              assert.equal(calls[0].suit_effect, sample.id);
              assert.equal(marketRequests[0].suit_effect, sample.id);
              assert.equal(result.items[0].candidates[0].verified, true);
              const actions = result.searchItems[0].uiQueries[0].actions;
              assert.ok(
                actions.some(
                  (action) => action.control === "radio_short_cut" && action.method === "check",
                ),
              );
              assert.ok(
                actions.some(
                  (action) => action.control === "sel_short_cut" && action.value === sample.id,
                ),
              );
              assert.ok(!actions.some((action) => action.control === "txt_" + sample.type));
            } else {
              assert.deepEqual(calls, []);
              assert.deepEqual(marketRequests, []);
              assert.deepEqual(detailVisits, []);
              assert.equal(result.items[0].searchState, "read_failed");
              assert.match(result.items[0].note, /文本控件.*无法精确/);
              assert.equal(result.searchItems[0].failure.stage, "configuration");
            }
            await mkdir("data/pr27-fix-validation", { recursive: true });
            await writeFile(
              "data/pr27-fix-validation/suit-substring-" + sample.id + "-" + shortcut + ".json",
              JSON.stringify(
                { simulated: true, sample, shortcut, calls, marketRequests, result },
                null,
                2,
              ),
            );
          },
        );
      });

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

  await check("无宝石装备填写核心初血，详情仍逐项核对基础值上限", () => {
    const description = "等级 100\n气血 +176 防御 +50\n耐久度 435";
    return withSource(
      {},
      { renderedPanel: true, selling: 1, description },
      async ({ source, searchPage, control }) => {
        const result = await source.findCandidates([item({ description })], control.signal);
        const [query] = await searchPage.evaluate(() => window.calls);
        assert.equal(query.init_hp, 0);
        assert.equal(query.init_defense, undefined);
        assert.equal(query.attr_without_melt, 1);
        assert.equal(query.hp, undefined);
        assert.equal(query.defense, undefined);
        assert.equal(result.items[0].candidates[0].verified, true);
      },
    );
  });
  await check("初防衣服全流程：目标单服填写初防、翻页、基础值上限核验与最低价", async () => {
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
        assert.equal(snapshot.total, 600);
        assert.equal(snapshot.items[0].referencePrice, 600);
        assert.deepEqual(
          snapshot.items[0].candidates.map((value) => new URL(value.url).searchParams.get("eid")),
          ["initial-1", "initial-2"],
        );
        const calls = await searchPage.evaluate(() => window.calls);
        assert.deepEqual(
          calls.map((call) => call.page),
          [1, 1, 1, 2],
        );
        for (const call of calls) {
          assert.equal(call.kindid, "18");
          assert.equal(call.init_defense, 0);
          assert.equal(call.attr_without_melt, 1);
          assert.equal(call.attr_with_melt, undefined);
        }
        const events = await searchPage.evaluate(() => window.uiEvents);
        assert.ok(
          events.some(
            (event) =>
              event.type === "change" && event.id === "ovarall_sel_server" && event.value === "1",
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

  for (const sample of [
    {
      category: "剑",
      field: "伤害",
      gem: "太阳石",
      shown: 581,
      base: 501,
      param: "init_damage_raw",
    },
    { category: "饰品", field: "灵力", gem: "舍利子", shown: 232, base: 172, param: "init_wakan" },
    { category: "腰带", field: "气血", gem: "光芒石", shown: 576, base: 176, param: "init_hp" },
  ])
    await check("扣宝石基础值进入实际填写与详情核验：" + sample.category, () => {
      const name = "模拟基础值" + sample.category;
      const description = `等级100\n${sample.field}${sample.shown}\n耐久300\n锻炼等级10\n镶嵌宝石 ${sample.gem}\n熔炼效果：\n+10${sample.field}`;
      return withSource(
        { pages: [[{ eid: "base-gem", name, rawAttributes: { [sample.param]: sample.base } }]] },
        { name, description },
        async ({ source, searchPage, control }) => {
          const result = await source.findCandidates(
            [item({ name, category: "人物装备 · " + sample.category, description })],
            control.signal,
          );
          const [query] = await searchPage.evaluate(() => window.calls);
          assert.equal(query[sample.param], 0);
          assert.equal(query.attr_without_melt, 1);
          assert.equal(result.items[0].candidates[0].verified, true);
          assert.equal(
            result.searchItems[0].uiQueries[0].actions.some(
              (a) => a.control === "txt_" + sample.param,
            ),
            true,
          );
          await mkdir("data/pr27-fix-validation", { recursive: true });
          await writeFile(
            "data/pr27-fix-validation/base-gem-" + sample.param + ".json",
            JSON.stringify(
              { simulated: true, description, expectedBase: sample.base, query, result },
              null,
              2,
            ),
          );
        },
      );
    });

  await check("混合宝石无法还原核心初始值时明确跳过、不提交搜索", () =>
    withSource({}, {}, async ({ source, control }) => {
      const result = await source.findCandidates(
        [
          item({
            category: "人物装备 · 剑",
            description: "等级100\n伤害581\n耐久300\n锻炼等级10\n镶嵌宝石 太阳石、红玛瑙",
          }),
        ],
        control.signal,
      );
      assert.equal(result.items[0].searchState, "skipped");
      assert.match(result.items[0].skipReason, /初始伤害无法可靠还原/);
      assert.deepEqual(marketRequests, []);
      assert.deepEqual(detailVisits, []);
    }),
  );

  await check("前五条列表均不匹配时不补第六条及后排商品", () => {
    const description = "等级 100\n气血 +176 防御 +50\n锻炼等级0\n耐久度 435";
    const wrong = Array.from({ length: 10 }, (_, i) => ({
      eid: "wrong-list-" + i,
      name: equipmentName,
      kindId: "20",
      level: "100",
      description: description.replace("气血 +176", "气血 +475") + (i % 2 ? "\n特效：简易" : ""),
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
        assert.equal(
          result.items[0].candidates.some((candidate) => candidate.verified),
          false,
        );
        assert.deepEqual(detailVisits, []);
        assert.ok(
          result.searchItems[0].modes.every(
            (stage) => stage.sampled === 5 && stage.samplingComplete && !stage.exhausted,
          ),
        );
        assert.match(result.items[0].note, /前5条/);
      },
    );
  });

  await check("单条件宽搜不按宝石段数排除，双方基础属性核验后采用", () =>
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
        assert.deepEqual(detailVisits, ["other-gem", "matching"]);
        assert.equal(result.items[0].candidates[0].verified, true);
        assert.equal(result.items[0].candidates.length, 2);
        const [query] = await searchPage.evaluate(() => window.calls);
        assert.equal(query.gem_level, undefined);
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

  await check("灵饰只按独立分类宽搜，列表拒绝高于目标的基础词条", () => {
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
        assert.equal(query.magic_damage, undefined);
        assert.equal(query.basic_attr_value, 0);
        assert.equal(query["added_attr.4"], 2);
        assert.equal(query["added_attr.3"], 1);
        assert.equal(query.added_attr_num, "3");
        assert.deepEqual(detailVisits, ["matching"]);
        assert.equal(result.items[0].candidates[0].verified, true);
      },
    );
  });

  await check("同等级灵饰低于目标可报价，高于目标或不同等级拒绝", () => {
    const name = "悦碧水";
    const target =
      "等级120\n防御+24\n精炼等级3\n附加属性：\n速度+12[+9]\n固定伤害+14[+12]\n特效：健步如飞（2级）\n速度+2";
    const lower = target
      .replace("防御+24", "防御+23")
      .replace("速度+12", "速度+10")
      .replace("固定伤害+14", "固定伤害+12");
    const higher = target.replace("防御+24", "防御+25");
    const other = lower.replace("等级120", "等级130");
    return withSource(
      {
        jewelry: true,
        pages: [
          [
            {
              eid: "lower-base",
              name,
              kindId: "61",
              level: "120",
              description: lower,
              rawAttributes: { defense: 23 },
            },
            {
              eid: "higher-base",
              name,
              kindId: "61",
              level: "120",
              description: higher,
              rawAttributes: { defense: 25 },
            },
            {
              eid: "other-level",
              name,
              kindId: "61",
              level: "130",
              description: other,
              rawAttributes: { defense: 23 },
            },
          ],
        ],
      },
      (eid) => ({
        name,
        description: eid === "lower-base" ? lower : eid === "higher-base" ? higher : other,
        modelId: 27004,
        kindId: 61,
        renderedPanel: true,
        selling: 1,
        price: eid === "lower-base" ? 25 : 1,
      }),
      async ({ source, searchPage, control }) => {
        const result = await source.findCandidates(
          [item({ name, category: "灵饰 · 戒指", kindId: "61", level: 120, description: target })],
          control.signal,
        );
        const [query] = await searchPage.evaluate(() => window.calls);
        assert.equal(query.equip_level_min, 120);
        assert.equal(query.equip_level_max, 120);
        assert.equal(query.defense, undefined);
        assert.equal(query.basic_attr_value, 0);
        assert.equal(query.suit_effect, "4");
        assert.equal(query.suit_effect_level, 2);
        assert.deepEqual(detailVisits, ["lower-base"]);
        assert.deepEqual(
          result.items[0].candidates.filter((c) => c.verified).map((c) => c.price),
          [25],
        );
        const dir = "data/upper-bound-validation";
        await mkdir(dir, { recursive: true });
        await writeFile(
          path.join(dir, "jewelry-lower-base-e2e.json"),
          JSON.stringify({ simulated: true, target, lower, higher, other, query, result }, null, 2),
        );
        await searchPage.screenshot({
          path: path.join(dir, "jewelry-lower-base-e2e.png"),
          fullPage: true,
        });
      },
    );
  });

  await check("保存的芙蓉戒属性不含整套生效速度时仍取得五件相近参考", () => {
    const name = "芙蓉戒";
    const description =
      "等级 80\n防御 +21\n耐久度 84\n精炼等级 5\n附加属性：\n法术伤害结果 +8 [+15]\n法术伤害 +8 [+20]\n法术暴击等级 +10 [+20]\n特效：健步如飞（2级）\n速度 +2\n速度+7（已生效）\n装备条件：等级80";
    const standalone = description
      .replace("速度+7（已生效）\n", "")
      .replace("法术伤害 +8 [+20]", "法术伤害 +6 [+20]");
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
          assert.ok(candidate.differences.includes("法术伤害：+8 [+20] → +6 [+20]"));
          assert.equal(
            candidate.price,
            [1000, 1100, 1200, 1300, 1450][Number(candidate.url.slice(-1))],
          );
        }
        const [query] = await searchPage.evaluate(() => window.calls);
        assert.equal(query.server_type, undefined);
        assert.equal(query.kindid, "61");
        assert.equal(query.jinglian_level, undefined);
        assert.equal(query.suit_effect, "4");
        assert.equal(query.suit_effect_level, 2);
        assert.equal(detailVisits.length, 5);
        assert.equal(buildEquipmentEstimate(result.items[0].candidates).average, 1210);
        assert.equal(
          result.searchItems[0].scopeEvidence[0].request.searchType,
          "overall_search_lingshi",
        );
        assert.equal(result.searchItems[0].scopeEvidence[0].request.serverType, "");
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
        assert.equal(query.server_type, undefined);
        assert.equal(result.items[0].searchState, "completed");
        assert.equal(result.items[0].candidates.length, 4);
        assert.deepEqual(detailVisits, ["ear-0", "ear-1", "ear-2", "ear-3"]);
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
        assert.match(rejected[0].reason, /法术伤害.*高于目标/);
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

  for (const sample of [
    { label: "同种类不同名称型号", rowKind: "11", detailKind: "11", valid: true },
    { label: "列表明确不同种类", rowKind: "6", detailKind: "11", valid: false },
    { label: "列表缺种类但详情不同种类", detailKind: "6", valid: false },
    { label: "详情缺官方种类", detailKind: null, valid: false },
  ])
    await check("官网目录补目标种类后核验：" + sample.label, () => {
      const name = "目标魔棒",
        candidateName = "另一把魔棒",
        description = "等级130\n伤害500\n锻炼等级0\n耐久300";
      return withSource(
        {
          namedModels: { "130_11": [{ label: name, value: 1101 }] },
          pages: [
            [
              {
                eid: "same-kind-other-model",
                name: candidateName,
                modelId: "1102",
                kindId: sample.rowKind,
              },
            ],
          ],
        },
        {
          name: candidateName,
          modelId: "1102",
          kindId: sample.detailKind,
          description,
          renderedPanel: true,
          selling: 1,
        },
        async ({ source, searchPage, control }) => {
          const target = item({
            name,
            category: "人物装备",
            level: 130,
            modelId: "1101",
            description,
          });
          const result = await source.findCandidates([target], control.signal);
          const [query] = await searchPage.evaluate(() => window.calls);
          assert.equal(query.kindid, "11");
          assert.equal(target.kindId, undefined);
          assert.equal(result.items[0].kindId, "11");
          assert.equal(
            result.items[0].candidates.some((candidate) => candidate.verified),
            sample.valid,
          );
          if (sample.valid) {
            const candidate = result.items[0].candidates[0];
            assert.equal(candidate.title, candidateName);
            assert.match(candidate.quote, new RegExp(candidateName));
            assert.deepEqual(detailVisits, ["same-kind-other-model"]);
          } else if (sample.rowKind === "6") assert.deepEqual(detailVisits, []);
          else assert.deepEqual(detailVisits, ["same-kind-other-model"]);
          await mkdir("data/pr27-fix-validation", { recursive: true });
          await writeFile(
            "data/pr27-fix-validation/same-kind-" +
              (sample.rowKind || "missing") +
              "-" +
              sample.detailKind +
              ".json",
            JSON.stringify({ simulated: true, sample, query, result }, null, 2),
          );
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
        const result = await source.findCandidates(
          [item({ name, category: "人物装备", level: 90, description })],
          control.signal,
        );
        assert.equal(result.items[0].searchState, "read_failed");
        assert.match(result.items[0].note, /装备类型无法对应官网筛选/);
        assert.deepEqual(await searchPage.evaluate(() => window.calls), []);
        assert.deepEqual(detailVisits, []);
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
        await assert.rejects(source.findCandidates([item()], control.signal), (error) => {
          assert.match(error.message, /当前商品ID.*报价未采用/);
          assert.equal(error.equipmentDiagnostics.product.id, "wrong-product");
          assert.equal(error.equipmentDiagnostics.panels.length, 1);
          return true;
        });
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
      (eid) => ({
        renderedPanel: true,
        selling: 1,
        modelId: 2912,
        description:
          eid === "near"
            ? equipmentDescription.replace("防御：50", "防御：49")
            : equipmentDescription,
      }),
      async ({ source, control }) => {
        const result = await source.findCandidates([item({ modelId: "2912" })], control.signal);
        assert.deepEqual(detailVisits, ["near", "exact-0", "exact-1", "exact-2"]);
        assert(result.items[0].candidates.every((candidate) => candidate.verified));
        assert.equal(result.items[0].candidates[0].matchType, "similar");
      },
    ),
  );

  await check("单服核心初血176接受小于或等于176，拒绝更高值且不读取第六条", () => {
    const description = "等级100\n气血176 防御50\n耐久300\n修理失败0";
    const health = [175, 176, 177, 178, 179, 176];
    return withSource(
      {
        pages: [
          health.map((value, index) => ({
            eid: "bounded-" + index,
            name: equipmentName,
            modelId: "2912",
          })),
        ],
      },
      (eid) => ({
        renderedPanel: true,
        selling: 1,
        modelId: 2912,
        description: description.replace("气血176", "气血" + health[Number(eid.slice(-1))]),
        price: [1000, 900, 1100, 1, 2, 3][Number(eid.slice(-1))],
      }),
      async ({ source, searchPage, control }) => {
        const result = await source.findCandidates(
          [item({ description, modelId: "2912" })],
          control.signal,
        );
        const calls = await searchPage.evaluate(() => window.calls);
        assert.equal(calls.length, 3);
        assert.equal(calls[0].serverid, "1");
        assert.equal(calls[0].init_hp, 0);
        assert.deepEqual(detailVisits, [
          "bounded-0",
          "bounded-1",
          "bounded-2",
          "bounded-3",
          "bounded-4",
        ]);
        assert.deepEqual(
          result.items[0].candidates.filter((c) => c.verified).map((c) => c.price),
          [1000, 900],
        );
        assert.equal(result.searchItems[0].modes[0].mode, "base-attributes");
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
        assert.equal(result.searchItems[0].scopeEvidence[0].request.serverType, "");
        assert.deepEqual(result.searchItems[0].scopeEvidence[0].candidateServers, { 1: 1 });
        assert.equal(call.equip_type, "61717");
        assert.equal(call.level_min, undefined);
        assert.equal(result.items[0].candidates[0].verified, true);
      },
    );
  });

  await check("前5条低于目标的样本保留官网顺序，不读取后页", () => {
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
          eid.startsWith("distant-") ? "防御：45" : "防御：49",
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

  await check("已读完三件时保留实际数量及审计均值，排除项不纳入", () =>
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
          if (options.rawEid) {
            await assert.rejects(
              source.findCandidates([item()], control.signal),
              /当前商品ID.*报价未采用/,
            );
            return;
          }
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
      {
        pages: [
          [{ eid: "first", name: "其他装备", kindId: "6" }],
          [{ eid: "last", name: equipmentName }],
        ],
      },
      {},
      async ({ source, searchPage, control }) => {
        const input = item();
        const result = await source.findCandidates([input], control.signal);
        assert.equal(result.items[0].searchState, "completed");
        assert.deepEqual(
          (await searchPage.evaluate(() => window.calls)).map((x) => x.page),
          [1, 1, 1, 2],
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
          [1, 1, 1, 2],
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
        assert.equal(entry.request.serverType, "");
        assert.equal(entry.rowCount, 0);
        assert.deepEqual(entry.candidateServers, {});
      }
    }),
  );

  // Failure case: a valid earlier price must not hide a later access restriction
  // inside detailFailures or let the two-failure exclusion rule consume it.
  await check("前1条有效而第2条权限拒绝时上抛暂停，不当作无样本跳过", () =>
    withSource(
      {
        pages: [
          [
            { eid: "accepted-first", name: equipmentName },
            { eid: "permission-denied", name: equipmentName },
            { eid: "must-not-read", name: equipmentName },
          ],
        ],
      },
      (eid) => ({ httpStatus: eid === "permission-denied" ? 403 : 200 }),
      async ({ source, searchPage, control }) => {
        let failure;
        await assert.rejects(source.findCandidates([item()], control.signal), (error) => {
          failure = error.message;
          return /403|权限/.test(error.message);
        });
        assert.deepEqual(detailVisits, ["accepted-first", "permission-denied"]);
        await mkdir("data/pr27-fix-validation", { recursive: true });
        await writeFile(
          "data/pr27-fix-validation/equipment-permission-gate.json",
          JSON.stringify(
            {
              simulated: true,
              targetServerId: "1",
              failure,
              detailVisits,
              requests: marketRequests,
              calls: await searchPage.evaluate(() => window.calls),
            },
            null,
            2,
          ),
        );
      },
    ),
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

  await check("第一页前五条类型均不匹配即停止，不读后页", () =>
    withSource(
      {
        pages: [
          Array.from({ length: 5 }, (_, i) => ({
            eid: "wrong-" + i,
            name: "其他装备",
            kindId: "6",
          })),
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
        assert.deepEqual(
          calls.map((call) => call.page),
          [1, 1, 1],
        );
        assert.deepEqual(detailVisits, []);
        assert.notEqual(result.items[0].samplingStopped, true);
        assert.equal(result.items[0].searchState, "completed");
        assert.match(result.items[0].note, /前5条/);
        assert.ok(
          result.searchItems[0].modes.every(
            (mode) => mode.sampled === 5 && mode.samplingComplete && !mode.exhausted,
          ),
        );
      },
    ),
  );
  await check("第一页前五条均拒绝也不翻后页", () =>
    withSource(
      {
        pages: [
          Array.from({ length: 5 }, (_, i) => ({ eid: "rejected-" + i, name: equipmentName })),
          [{ eid: "later-match", name: equipmentName }],
        ],
      },
      (id) => ({
        description: id.startsWith("rejected-")
          ? equipmentDescription.replace("气血：250", "气血：251")
          : equipmentDescription,
      }),
      async ({ source, searchPage, control }) => {
        const result = await source.findCandidates([item()], control.signal);
        assert.deepEqual(
          (await searchPage.evaluate(() => window.calls)).map((call) => call.page),
          [1, 1, 1],
        );
        assert.deepEqual(
          detailVisits,
          Array.from({ length: 5 }, (_, i) => "rejected-" + i),
        );
        assert.notEqual(result.items[0].samplingStopped, true);
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
          [1, 1, 1, 2],
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
        eid === "saved-1" ? "防御：49" : "防御：50",
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
        const untouched = item({
          key: "later-item",
          candidates: saved.candidates,
          searchCursor: saved.searchCursor,
        });
        const result = await source.findCandidates(
          [
            item({ kindId: "20", candidates: saved.candidates, searchCursor: saved.searchCursor }),
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
        const second = (
          await source.findCandidates(
            [item({ candidates: first.candidates, searchCursor: first.searchCursor })],
            control.signal,
          )
        ).items[0];
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

  for (const matchesAfterRetry of [true, false])
    await check(
      `第5条装备详情失败先保留待查，恢复后${matchesAfterRetry ? "匹配即满五件" : "拒绝后按四条报价、不读第六条"}`,
      () =>
        withSource(
          {
            pages: [
              Array.from({ length: 6 }, (_, i) => ({ eid: "fifth-" + i, name: equipmentName })),
            ],
          },
          (id) => ({ tooltipMissing: id === "fifth-4" }),
          async ({ source, control }) => {
            const first = (await source.findCandidates([item()], control.signal)).items[0];
            assert.equal(first.searchState, "read_failed");
            assert.equal(first.candidates.filter((c) => c.verified).length, 4);
            assert.ok(first.searchCursor.failed.length);
            detailOptions = (id) => ({
              description:
                id === "fifth-4" && !matchesAfterRetry
                  ? equipmentDescription.replace("气血：250", "气血：251")
                  : equipmentDescription,
            });
            const second = (
              await source.findCandidates(
                [item({ candidates: first.candidates, searchCursor: first.searchCursor })],
                control.signal,
              )
            ).items[0];
            assert.equal(second.searchState, "completed", second.note);
            assert.deepEqual(
              second.candidates
                .filter((c) => c.verified)
                .map((c) => new URL(c.url).searchParams.get("eid")),
              matchesAfterRetry
                ? Array.from({ length: 5 }, (_, i) => "fifth-" + i)
                : ["fifth-0", "fifth-1", "fifth-2", "fifth-3"],
            );
            assert.equal(detailVisits.includes("fifth-5"), false);
          },
        ),
    );

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
        assert.ok(
          calls.every(
            (call) =>
              call.serverid === "1" &&
              call.server_type === undefined &&
              call.level_min === undefined,
          ),
        );
      },
    );
  });

  await check("前五条类型不匹配即结束，后页再多也不扫描", () =>
    withSource(
      {
        pages: Array.from({ length: 6 }, (_, page) =>
          Array.from({ length: 30 }, (_, row) => ({
            eid: `${page}-${row}`,
            name: "其他装备",
            kindId: "6",
          })),
        ),
      },
      {},
      async ({ source, searchPage, control }) => {
        const result = await source.findCandidates(
          [item({ description: "等级100\n防御50\n气血250" })],
          control.signal,
        );
        assert.ok((await searchPage.evaluate(() => window.calls)).every((call) => call.page === 1));
        assert.equal(result.items[0].searchState, "completed");
        assert.equal(result.items[0].searchCursor, undefined);
        assert.notEqual(result.items[0].samplingStopped, true);
        assert.deepEqual(detailVisits, []);
      },
    ),
  );
  await check("前五条均拒绝不读第六条，保留未知价格", async () => {
    await withSource(
      { pages: [Array.from({ length: 6 }, (_, i) => ({ eid: "cap-" + i, name: equipmentName }))] },
      (id) => ({
        description:
          id === "cap-5"
            ? equipmentDescription
            : equipmentDescription.replace("气血：250", "气血：251"),
      }),
      async ({ source, control }) => {
        const result = await source.findCandidates([item()], control.signal);
        assert.equal(result.items[0].searchState, "completed");
        assert.equal(
          result.items[0].candidates.some((candidate) => candidate.verified),
          false,
        );
        assert.deepEqual(
          detailVisits,
          Array.from({ length: 5 }, (_, i) => "cap-" + i),
        );
        assert.ok(
          result.searchItems[0].modes.every(
            (stage) => stage.sampled === 5 && stage.samplingComplete && !stage.exhausted,
          ),
        );
        assert.match(result.items[0].note, /前5条/);
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
