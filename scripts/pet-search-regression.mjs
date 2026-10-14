import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { chromium } from "playwright-core";
import {
  petSearchDocument,
  petDetailDocument,
  petFields,
  petSkills,
  petGear,
  roleSentinelDocument,
} from "../tests/fixtures/pet-search-site.mjs";

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
const matcher = await moduleUrl("server/analysis/equipment-match.ts", {
  "./equip-attributes": attributes,
});
const marketScope = await moduleUrl("server/analysis/market-scope.ts");
const specialMatcher = await moduleUrl("server/analysis/special-asset-match.ts", {
  "../crawler/compact": compact,
  "./equipment-match": matcher,
});
const pricing = await moduleUrl("server/analysis/equipment-pricing.ts", {
  "./market-scope": marketScope,
  "./pricing-progress": progress,
  "./equipment-baseline": await moduleUrl("server/analysis/equipment-baseline.ts", {
    "../crawler/compact": compact,
    "./equip-attributes": attributes,
  }),
  "./pricing-estimate": estimate,
  "./pricing-integrity": integrity,
  "./equipment-match": matcher,
  "./special-asset-match": specialMatcher,
  "./equipment-exclusion": exclusion,
  "../crawler/compact": compact,
  "./equip-attributes": attributes,
  "./valuation-calculator": await moduleUrl("server/analysis/valuation-calculator.ts", {
    "./valuation-facts": await moduleUrl("server/analysis/valuation-facts.ts"),
  }),
});
// Pace is skipped only in this offline fixture run; availability checks are production code.
const pacedPage = inline(
  `export {assertAvailable} from ${JSON.stringify(crawlerPage)};export async function pace(signal){signal.throwIfAborted();}`,
);
const petMatcher = await moduleUrl("server/analysis/pet-match.ts");
const petPricing = await moduleUrl("server/analysis/pet-pricing.ts", {
  "./pet-gear-match": await moduleUrl("server/analysis/pet-gear-match.ts", {
    "../crawler/compact": compact,
  }),
  "./market-scope": marketScope,
  "./pet-match": petMatcher,
  "./pricing-progress": progress,
  "./pricing-estimate": estimate,
  "./pricing-integrity": integrity,
  "../crawler/compact": compact,
  "./equipment-pricing": pricing,
  "./valuation-calculator": await moduleUrl("server/analysis/valuation-calculator.ts", {
    "./valuation-facts": await moduleUrl("server/analysis/valuation-facts.ts"),
  }),
});
const { searchPetPricing } = await import(petPricing);
const { petSourceFromPages, fillPetSearchForm, petQuery, petQueries, assertPetUIArguments } =
  await import(
    await moduleUrl("server/analysis/browser-pet-source.ts", {
      "./pricing-integrity": integrity,
      "./pet-match": petMatcher,
      "./market-scope": marketScope,
      "../session": session,
      "../viewport": viewport,
      "../crawler/controller": inline(
        "export function crawlDatabase(){throw new Error('Fixture must not open the application database');}",
      ),
      "../crawler/page": pacedPage,
      "../page-state": pageState,
      "../workflow": workflow,
      "../crawler/compact": compact,
      "./equipment-pricing": pricing,
      "./pricing-estimate": estimate,
      "./pricing-progress": progress,
      "./pet-pricing": petPricing,
    })
  );
const { createHiddenPage } = await import(session);
// Every request is intercepted. This is a simulated DOM regression, not a market query.
const profile = await mkdtemp(path.join(os.tmpdir(), "cbg-pet-regression-"));
let persistent,
  browser,
  passed = 0,
  failed = 0;
const check = async (name, run) => {
  // Optional focused rerun; every selected check retains its production assertions.
  if (process.env.CBG_PET_DOM_FILTER && !name.includes(process.env.CBG_PET_DOM_FILTER)) return;
  try {
    await run();
    passed++;
    console.log("PASS (SIMULATED): " + name);
  } catch (error) {
    failed++;
    console.error("FAIL: " + name + " — " + error.message);
  }
};
const record = (gear = []) => ({
  status: "complete",
  error: null,
  listing: { key: "1:role", serverId: "1" },
  detail: {
    collectedAt: "fixture-time",
    petCapture: { version: 1, collectedAt: "fixture-time", complete: true, issues: [] },
    tabs: [
      {
        name: "召唤兽/孩子",
        petCount: 1,
        pets: [
          {
            index: 1,
            name: "宝宝昵称",
            fields: petFields,
            skills: petSkills.map((name, index) => ({ name, index, kind: "skill" })),
            innerSkills: [{ index: 0, name: "催心浪", level: "5", kind: "innerSkill" }],
            equipment: gear.map((value, index) => ({ ...value, index, kind: "equipment" })),
          },
        ],
      },
    ],
  },
});
const bounded = (page) =>
  new Proxy(page, {
    get(target, key) {
      if (key === "waitForFunction")
        return async (fn, arg, options = {}) => {
          // Search callbacks await an intercepted fetch; keep broken-detail checks at 1s.
          const searchWait = options.timeout >= 15000;
          const fixtureLimit = searchWait ? 3000 : 1000;
          try {
            return await target.waitForFunction(fn, arg, {
              ...options,
              timeout: Math.min(options.timeout || fixtureLimit, fixtureLimit),
            });
          } catch (error) {
            if (searchWait)
              error.message += ` (offline ${options.timeout === 20000 ? "search response" : "search component"} wait)`;
            throw error;
          }
        };
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
    detailVisits = [];
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://xyq.cbg.163.com") return route.abort();
    if (url.pathname.startsWith("/images/"))
      return route.fulfill({
        contentType: "image/gif",
        body: Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
      });
    let body;
    if (url.pathname === "/sentinel-role-list") body = roleSentinelDocument;
    else if (url.pathname === "/equip") {
      detailVisits.push(url.searchParams.get("eid"));
      body = petDetailDocument(
        typeof detailOptions === "function"
          ? detailOptions(url.searchParams.get("eid"))
          : detailOptions,
      );
    } else if (url.pathname.startsWith("/cgi-bin/")) body = petSearchDocument(searchOptions);
    else return route.abort();
    try {
      await route.fulfill({ contentType: "text/html; charset=utf-8", body });
    } catch (error) {
      if (!route.request().isNavigationRequest()) throw error;
    }
  });
  const role = await context.newPage();
  await role.goto("https://xyq.cbg.163.com/sentinel-role-list");
  const before = await role.evaluate(() => ({
    url: location.href,
    args: window.QueryArgs,
    checkpoint: window.checkpoint,
  }));
  await role.evaluate(() => localStorage.setItem("saved_overall_search_pet_query", "kept"));
  const withSource = async (search, detail, run) => {
    searchOptions = search;
    detailOptions = detail;
    detailVisits = [];
    const searchPage = await createHiddenPage(browser),
      detailPage = await createHiddenPage(browser),
      control = new AbortController();
    const source = petSourceFromPages(bounded(searchPage), bounded(detailPage), control.signal);
    try {
      await run({ source, searchPage, detailPage, control });
    } finally {
      await source.close();
    }
    assert.equal(searchPage.isClosed(), true);
    assert.equal(detailPage.isClosed(), true);
  };
  await check("宝宝结果等待超时能区分回调缺失与加载图标不消失", async () => {
    for (const settings of [{ mode: "stalled" }, { keepLoading: true }]) {
      await withSource(settings, {}, async ({ source, control }) => {
        await assert.rejects(
          () => searchPetPricing(record(), control.signal, source),
          (error) => {
            assert.equal(error.name, "TimeoutError");
            assert.equal(error.code, "PET_SEARCH_RESULT_TIMEOUT");
            assert.match(error.message, /宝宝搜索结果等待超时/);
            assert.match(
              error.message,
              settings.keepLoading ? /回调已收到.*加载图标仍显示/ : /回调未收到.*加载图标已消失/,
            );
            return true;
          },
        );
        assert.deepEqual(detailVisits, []);
      });
    }
  });
  await check("成长浮点截断边界通过真实表单提交，条件校验不放宽", async () => {
    await withSource({}, {}, async ({ searchPage, control }) => {
      await searchPage.goto(
        "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=show_overall_search_pet",
      );
      const target = {
        ...record().detail.tabs[0].pets[0],
        name: "画魂",
        level: 119,
        skills: petSkills,
      };
      for (const growth of [1001, 1003, 1009, 1039, 1250, 1280]) {
        const args = {
          ...petQuery(target, {
            names: { 2001: "画魂" },
            skills: [
              [1, "须弥真言"],
              [2, "高级法术暴击"],
            ],
            highNeidans: [[9, "催心浪"]],
            lowNeidans: [],
          }),
          growth,
        };
        const evidence = await fillPetSearchForm(searchPage, target, args, control.signal);
        await searchPage.locator("#btn_pet_search").click();
        const actual = await searchPage.evaluate(() => window.CurSearchValue.arg);
        assert.equal(actual.growth, growth);
        assertPetUIArguments(args, actual);
        assert.equal(parseInt(parseFloat(evidence.inputs.txt_growth) * 1000, 10), growth);
        assert.throws(
          () => assertPetUIArguments(args, { ...actual, growth: growth - 1 }),
          /growth/,
        );
      }
    });
  });
  await check("成长1.009宝宝完整查价通过表单并取得可核验模拟样本", async () => {
    const growthFields = petFields.map((field) =>
      field.name === "成长" ? { ...field, value: "1.009" } : field,
    );
    const targetRecord = record();
    targetRecord.detail.tabs[0].pets[0].fields = growthFields;
    await withSource(
      {},
      { fields: growthFields, rawGrowth: 1.009 },
      async ({ source, control }) => {
        const result = await searchPetPricing(targetRecord, control.signal, source);
        assert.equal(result.searchComplete, true);
        assert.equal(result.items[0].referencePrice, 368.6);
        assert.ok(result.items[0].candidates.every((candidate) => candidate.verified));
        const item = result.searchItems.find((entry) => entry.uiEvidence?.length);
        assert.equal(item.uiEvidence[0].submittedArgs.growth, 1009);
      },
    );
  });
  await check("相近分组保留须弥法宠核心，每组都有有限附近等级且同级优先", async () => {
    const skills = ["须弥真言", "高级法术连击", "高级魔之心", "法术暴击", "地狱烈火", "慧根"];
    const choices = skills.map((name, index) => [index + 1, name]);
    const target = {
      ...record().detail.tabs[0].pets[0],
      name: "画魂",
      level: 99,
      skills,
      innerSkills: [],
      equipment: [],
    };
    const plans = petQueries(target, {
      names: { 2001: "画魂" },
      skills: choices,
      highNeidans: [],
      lowNeidans: [],
    });
    const similar = plans.filter(({ matchType }) => matchType === "similar");
    for (const { args } of similar) {
      assert.ok(["1", "2", "3"].every((id) => String(args.skill).split(",").includes(id)));
      assert.equal(args.skill_num, undefined);
      assert.equal(args.high_neidan, undefined);
    }
    assert.deepEqual(
      similar.filter(({ args }) => args.level_min === 99).map(({ args }) => args.skill),
      similar.filter(({ args }) => args.level_min === 94).map(({ args }) => args.skill),
    );
    await withSource({ petSkillChoices: choices }, {}, async ({ searchPage, control }) => {
      await searchPage.goto(
        "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=show_overall_search_pet",
      );
      const plan = similar.find(
        ({ args }) => args.level_min === 94 && String(args.skill).split(",").length === 4,
      );
      await fillPetSearchForm(searchPage, target, plan.args, control.signal);
      await searchPage.locator("#btn_pet_search").click();
      assertPetUIArguments(plan.args, await searchPage.evaluate(() => window.CurSearchValue.arg));
    });
  });
  await check("详情预算耗尽自动保存官方表单游标，恢复后读取后面的有效宝宝报价", async () => {
    const rows = Array.from({ length: 9 }, (_, index) => ({
      eid: `sample-${index}`,
      name: "画魂",
      type: "2001",
    }));
    const detail = (id) => {
      const index = Number(id.split("-").at(-1));
      return {
        price: 300 + index * 10,
        rawPrice: 300 + index * 10,
        ...(index < 6 ? { skills: [], parsedSkillIds: [] } : {}),
      };
    };
    const target = {
      ...record().detail.tabs[0].pets[0],
      key: "pet",
      name: "画魂",
      level: 119,
      fields: petFields,
      skills: petSkills,
      innerSkills: [{ name: "催心浪", level: "5" }],
      equipment: [],
      description: "模拟宝宝",
      candidates: [],
      status: "no_match",
      referencePrice: null,
      issues: [],
      query: "",
    };
    let cursor;
    await withSource({ pages: [rows] }, detail, async ({ source, control }) => {
      const result = await source.findCandidates([target], control.signal);
      assert.equal(result.items[0].searchState, "pending");
      cursor = result.items[0].searchCursor;
      assert.equal(cursor.rowIndex, 6);
      assert.equal(detailVisits.length, 6);
    });
    await withSource({ pages: [rows] }, detail, async ({ source, control }) => {
      const result = await source.findCandidates(
        [{ ...target, searchCursor: cursor }],
        control.signal,
      );
      assert.equal(result.items[0].searchState, "completed");
      assert.deepEqual(detailVisits, ["sample-6", "sample-7", "sample-8"]);
      assert.deepEqual(
        result.items[0].candidates.map(({ price }) => price),
        [360, 370, 380],
      );
      assert.ok(result.items[0].candidates.every(({ verified }) => verified));
    });
  });
  await check("续查宝宝页面重排或清空时清除旧候选，重新按官网顺序收集", async () => {
    const rows = Array.from({ length: 9 }, (_, index) => ({
      eid: `order-${index}`,
      name: "画魂",
      type: "2001",
    }));
    const detail = (id) => {
      const index = Number(id.split("-").at(-1));
      return {
        price: 300 + index,
        rawPrice: 300 + index,
        ...(index > 0 && index < 6 ? { skills: [], parsedSkillIds: [] } : {}),
      };
    };
    const target = {
      ...record().detail.tabs[0].pets[0],
      key: "pet",
      name: "画魂",
      level: 119,
      fields: petFields,
      skills: petSkills,
      innerSkills: [{ name: "催心浪", level: "5" }],
      equipment: [],
      description: "模拟宝宝",
      candidates: [],
      status: "no_match",
      referencePrice: null,
      issues: [],
      query: "",
    };
    let saved;
    await withSource({ pages: [rows] }, detail, async ({ source, control }) => {
      saved = (await source.findCandidates([target], control.signal)).items[0];
      assert.equal(saved.searchState, "pending");
      assert.equal(saved.candidates.filter((x) => x.verified).length, 1);
    });
    for (const changed of [[rows[8], ...rows.slice(0, 8)], []]) {
      await withSource({ pages: [changed] }, detail, async ({ source, control }) => {
        const result = await source.findCandidates([{ ...target, ...saved }], control.signal);
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
          for (let round = 0; round < 3 && rebuilt.searchState === "pending"; round++)
            rebuilt = (await source.findCandidates([{ ...target, ...rebuilt }], control.signal))
              .items[0];
          assert.equal(rebuilt.searchState, "completed", rebuilt.note);
          assert.deepEqual(
            rebuilt.candidates
              .filter((x) => x.verified)
              .map((x) => new URL(x.url).searchParams.get("eid")),
            ["order-8", "order-0", "order-6", "order-7"],
          );
        }
      });
    }
  });

  await check("续查宝宝当前页未变也核验已读完前页", async () => {
    const rows = Array.from({ length: 9 }, (_, index) => ({
      eid: `prefix-${index}`,
      name: "画魂",
      type: "2001",
    }));
    const detail = (id) => ({
      price: 300,
      rawPrice: 300,
      ...(id !== "prefix-new" && Number(id.split("-").at(-1)) < 6
        ? { skills: [], parsedSkillIds: [] }
        : {}),
    });
    const target = {
      ...record().detail.tabs[0].pets[0],
      key: "pet",
      name: "画魂",
      level: 119,
      fields: petFields,
      skills: petSkills,
      innerSkills: [{ name: "催心浪", level: "5" }],
      equipment: [],
      description: "模拟宝宝",
      candidates: [],
      status: "no_match",
      referencePrice: null,
      issues: [],
      query: "",
    };
    let saved;
    await withSource(
      { pages: [rows.slice(0, 6), rows.slice(6)] },
      detail,
      async ({ source, control }) => {
        saved = (await source.findCandidates([target], control.signal)).items[0];
        assert.equal(saved.searchCursor.pageNumber, 2);
      },
    );
    await withSource(
      {
        pages: [
          [{ eid: "prefix-new", name: "画魂", type: "2001" }, ...rows.slice(1, 6)],
          rows.slice(6),
        ],
      },
      detail,
      async ({ source, control }) => {
        const reset = (await source.findCandidates([{ ...target, ...saved }], control.signal))
          .items[0];
        assert.equal(reset.searchState, "pending");
        assert.deepEqual(reset.candidates, []);
        assert.equal(reset.searchCursor.restartCount, 1);
        assert.equal(reset.searchCursor.pageNumber, 1);
      },
    );
  });

  await check("动态类型/等级/技能都经官网输入、菜单选择和搜索按钮，旧服与购入服清除", async () => {
    const names = { 2001: "画魂", 3001: "幽灵", 4001: "泪妖", 5001: "毗舍童子" };
    const skillChoices = [
      [1, "须弥真言"],
      [2, "高级法术暴击"],
      [3, "高级魔之心"],
      [4, "高级法术连击"],
      [5, "高级必杀"],
      [6, "高级偷袭"],
    ];
    for (const [name, level, skills] of [
      ["幽灵", 45, ["须弥真言", "高级魔之心"]],
      ["泪妖", 99, ["须弥真言", "高级法术连击", "高级魔之心"]],
      ["毗舍童子", 160, ["高级必杀", "高级偷袭"]],
    ])
      await withSource(
        { petNames: names, petSkillChoices: skillChoices },
        {},
        async ({ searchPage, control }) => {
          await searchPage.goto(
            "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=show_overall_search_pet",
          );
          const target = {
            ...record().detail.tabs[0].pets[0],
            name,
            level,
            fields: petFields.map((field) =>
              field.name === "类型"
                ? { ...field, value: name }
                : field.name === "等级"
                  ? { ...field, value: String(level) }
                  : field,
            ),
            skills,
            innerSkills: [],
            equipment: [],
          };
          const args = petQuery(target, {
            names,
            skills: skillChoices,
            highNeidans: [],
            lowNeidans: [],
          });
          const evidence = await fillPetSearchForm(searchPage, target, args, control.signal);
          await searchPage.locator("#btn_pet_search").click();
          const actual = await searchPage.evaluate(() => window.CurSearchValue.arg);
          assertPetUIArguments(args, actual);
          assert.equal(await searchPage.locator("#pet_select_box").inputValue(), name);
          assert.equal(await searchPage.locator("#txt_level_min").inputValue(), String(level));
          assert.equal(actual.level_min, level);
          assert.equal(actual.level_max, level);
          assert.equal(actual.server_type, "3");
          assert.equal(actual.serverid, undefined);
          assert.equal(actual.cross_buy_serverid, undefined);
          assert.equal(evidence.inputs.pet_select_box, name);
          assert.equal(
            (await searchPage.evaluate(() => window.uiActions)).filter(
              (value) => value.action === "search-click",
            ).length,
            1,
          );
        },
      );
  });
  await check("神兽星级与唯一特性经真实复选框和菜单提交，0星不与缺失混用", async () => {
    const names = { 6001: "超级神羊", 6002: "超级神狗" };
    const traits = [
      [718, "灵刃"],
      [712, "顺势"],
    ];
    await withSource(
      { petNames: names, petTraitChoices: traits },
      {},
      async ({ searchPage, control }) => {
        await searchPage.goto(
          "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=show_overall_search_pet",
        );
        for (const [name, level, star, expectedStar, trait, expectedTrait] of [
          ["超级神羊", 99, "0", "0", "灵刃", "718"],
          ["超级神狗", 119, "一星", "1", "顺势", "712"],
          ["超级神羊", 159, "二星", "2", "灵刃", "718"],
          ["超级神狗", 175, "3星", "3", "顺势", "712"],
        ]) {
          const target = {
            ...record().detail.tabs[0].pets[0],
            name,
            level,
            skills: [],
            innerSkills: [],
            fields: [
              { name: "神兽星级", value: star },
              { name: "特性类型", value: trait },
              { name: "特性概率", value: "12%" },
            ],
          };
          for (const mode of ["exact", "similar", "diagnostic"]) {
            const args = petQuery(
              target,
              { names, skills: [], highNeidans: [], lowNeidans: [], traits },
              mode,
            );
            const evidence = await fillPetSearchForm(searchPage, target, args, control.signal);
            await searchPage.locator("#btn_pet_search").click();
            const actual = await searchPage.evaluate(() => window.CurSearchValue.arg);
            assertPetUIArguments(args, actual);
            assert.equal(actual.super_sum_star, expectedStar);
            assert.equal(actual.texing, expectedTrait);
            assert.equal(actual.level_min, level);
            assert.equal(actual.server_type, "3");
            assert.equal(actual.positive_effect, undefined);
            assert.equal(actual.negative_effect, undefined);
            assert.deepEqual(evidence.selections.super_sum_star, [expectedStar]);
            assert.deepEqual(evidence.selections.texing_panel, [expectedTrait]);
            assert.equal(
              await searchPage.locator(`.js_super_sum_star[value="${expectedStar}"]`).isChecked(),
              true,
            );
            assert.equal(await searchPage.locator(".js_super_sum_star:checked").count(), 1);
            await searchPage.waitForFunction(
              () => !document.querySelector("#loading_img")?.checkVisibility(),
            );
          }
        }
        const target = {
          ...record().detail.tabs[0].pets[0],
          name: "超级神羊",
          level: 99,
          fields: [],
          skills: [],
          innerSkills: [],
        };
        const args = petQuery(target, {
          names,
          skills: [],
          highNeidans: [],
          lowNeidans: [],
          traits,
        });
        await fillPetSearchForm(searchPage, target, args, control.signal);
        await searchPage.locator("#btn_pet_search").click();
        const actual = await searchPage.evaluate(() => window.CurSearchValue.arg);
        assertPetUIArguments(args, actual);
        assert.equal(actual.super_sum_star, undefined);
        assert.equal(actual.texing, undefined);
        assert.equal(await searchPage.locator(".js_super_sum_star:checked").count(), 0);
        const actions = await searchPage.evaluate(() => window.uiActions);
        assert.ok(
          actions.some(
            (action) => action.action === "star-check" && action.value === "0" && action.checked,
          ),
        );
        assert.ok(
          actions.some(
            (action) =>
              action.action === "choice" &&
              action.panel === "texing_panel" &&
              action.value === "718",
          ),
        );
        assert.equal(actions.filter((action) => action.action === "search-click").length, 13);
      },
    );
  });
  await check("神兽星级控件缺失和特性目录未确认时不宽泛查询或读报价", async () => {
    const target = {
      ...record().detail.tabs[0].pets[0],
      key: "pet",
      name: "画魂",
      level: 119,
      skills: petSkills,
    };
    await withSource({ petStarChoices: [0, 2, 3] }, {}, async ({ source, control }) => {
      await assert.rejects(
        () =>
          source.findCandidates(
            [{ ...target, fields: [...petFields, { name: "神兽星级", value: "1" }] }],
            control.signal,
          ),
        /神兽星级控件缺失/,
      );
      assert.equal(detailVisits.length, 0);
    });
    await withSource({ petTraitChoices: [] }, {}, async ({ source, searchPage, control }) => {
      const result = await source.findCandidates(
        [{ ...target, fields: [...petFields, { name: "特性类型", value: "灵刃" }] }],
        control.signal,
      );
      assert.equal(result.items[0].searchState, "unsupported");
      assert.match(result.items[0].note, /特性名称没有唯一官网筛选定义/);
      assert.equal(result.items[0].candidates.length, 0);
      assert.equal(detailVisits.length, 0);
      assert.equal(
        (await searchPage.evaluate(() => window.uiActions)).filter(
          (action) => action.action === "search-click",
        ).length,
        0,
      );
    });
  });
  await check(
    "公开发现读取官方储值菜单，不输出隐藏凭据；公开IsLogin0不能作为价格证据",
    async () => {
      await withSource({ publicLogin: 0 }, {}, async ({ source, control }) => {
        const form = await source.discover();
        assert.ok(form.controls.some((value) => value.id === "txt_level_min" && value.visible));
        assert.deepEqual(
          form.menus
            .find((value) => value.id === "server_type_panel")
            .choices.map((value) => value.value),
          ["1", "2", "3"],
        );
        assert.ok(
          form.menus
            .find((value) => value.id === "pet_skill_special_panel")
            .choices.some((value) => value.label === "须弥真言"),
        );
        assert.equal(JSON.stringify(form).includes("do-not-export"), false);
        await assert.rejects(
          () => source.findCandidates([{ name: "画魂", fields: [] }], control.signal),
          /登录/,
        );
      });
      for (const discoveryExtra of [
        '<div id="qrcode">扫码</div>',
        '<div id="captcha_container">验证码</div>',
      ])
        await withSource({ discoveryExtra }, {}, async ({ source }) => {
          await assert.rejects(() => source.discover(), /登录面板|安全验证/);
        });
    },
  );
  await check("界面保留额外价格过滤或未清购入服时，停止且不读取报价详情", async () => {
    for (const search of [{ uiOverrides: { price_max: 100 } }, { stickyBuyServer: true }])
      await withSource(search, {}, async ({ source, control }) => {
        await assert.rejects(
          () =>
            source.findCandidates(
              [
                {
                  ...record().detail.tabs[0].pets[0],
                  key: "pet",
                  name: "画魂",
                  level: 119,
                  skills: petSkills,
                  innerSkills: [],
                  equipment: [],
                },
              ],
              control.signal,
            ),
          /未计划|全服|限定|单服|地区限制/,
        );
        assert.equal(detailVisits.length, 0);
      });
  });
  await check("source→adapter等待主区域/主价/JSON，绑定新容器并排除先出现的同名推荐", async () => {
    for (const detail of [
      {},
      { noPanelId: true },
      { noPanelId: true, recommendationFirst: true, recommendationMainIds: true },
      { wrapperClass: "product-detail", footerStatus: "状态：已下架" },
      { panelDelay: 100 },
      { infoDelay: 100 },
      { priceDelay: 100 },
      { jsonDelay: 100 },
      { recommendationFirst: true, recommendationMainIds: true },
    ])
      await withSource({}, detail, async ({ source, searchPage, control }) => {
        const result = await searchPetPricing(record(), control.signal, source);
        assert.equal(result.provider, "browser");
        assert.equal(result.total, 368.6);
        assert.equal(result.items[0].candidates[0].verified, true);
        assert.equal(result.items[0].candidates[0].price, 368.6);
        assert.equal(
          result.items[0].candidates[0].url,
          "https://xyq.cbg.163.com/equip?s=1&eid=primary",
        );
        const [query] = await searchPage.evaluate(() => window.calls);
        assert.equal(query.act, "overall_search_pet");
        assert.equal(query.type, "2001");
        assert.equal(query.growth, 1280);
        assert.equal(query.attack_aptitude, 1550);
        assert.equal(query.skill, "1,2");
        assert.equal(query.serverid, undefined);
        assert.equal(query.server_type, "3");
        assert.equal(await searchPage.evaluate(() => window.historyWrites), 1);
        assert.equal(
          await role.evaluate(() => localStorage.getItem("saved_overall_search_pet_query")),
          "kept",
        );
        assert.equal(result.items[0].candidates[0].sourceHash.length, 64);
        assert.equal(result.queries.length, 1);
        assert.equal(result.searchItems[0].uiEvidence[0].method, "official-ui");
        assert.equal(result.searchItems[0].uiEvidence[0].searchButton, "btn_pet_search");
        assert.equal(
          (await searchPage.evaluate(() => window.uiActions)).filter(
            (value) => value.action === "search-click",
          ).length,
          result.queries.length,
        );
        const [scope] = result.searchItems[0].scopeEvidence;
        assert.equal(scope.request.serverType, "3");
        assert.equal(scope.request.searchType, "overall_search_pet");
        assert.deepEqual(scope.request.restrictions, {});
        assert.deepEqual(scope.candidateServers, { 1: 1 });
      });
  });
  await check("最终市场请求仍为三年以上全服，helper污染、漏请求或错误页码拒绝计价", async () => {
    for (const search of [
      { dropServerType: true },
      { marketOverrides: { server_type: "2" } },
      { marketOverrides: { serverid: "33" } },
      { marketOverrides: { area_id: "1" } },
      { omitMarketRequest: true },
      { marketPageOverride: 2 },
    ])
      await withSource(search, {}, async ({ source, control }) => {
        await assert.rejects(() => searchPetPricing(record(), control.signal, source));
        assert.deepEqual(detailVisits, []);
      });
  });
  await check("官网编码描述经页面解码器再解析，仍绑定可见主属性与价格", async () => {
    for (const detail of [
      { encodedJson: true },
      {
        encodedJson: true,
        noPanelId: true,
        recommendationFirst: true,
        recommendationMainIds: true,
      },
    ])
      await withSource({}, detail, async ({ source, detailPage, control }) => {
        const result = await searchPetPricing(record(), control.signal, source);
        assert.equal(result.total, 368.6);
        assert.equal(result.items[0].candidates[0].verified, true);
        assert.ok(await detailPage.evaluate(() => window.decodeCalls > 0));
      });
  });
  await check("官网分号描述经页面属性解析器读取，仍核对完整可见属性与随身装备", async () => {
    for (const detail of [
      { legacyDescription: true },
      { legacyDescription: true, encodedJson: true, noPanelId: true, equipment: petGear },
    ])
      await withSource({}, detail, async ({ source, detailPage, control }) => {
        const result = await searchPetPricing(
          record(detail.equipment || []),
          control.signal,
          source,
        );
        assert.equal(result.total, 368.6);
        assert.equal(result.items[0].candidates[0].verified, true);
        assert.ok(await detailPage.evaluate(() => window.petParseCalls > 0));
      });
  });
  await check("绑定的商品信息区提供等级，基础资质与换行加成只读取一次", async () => {
    for (const detail of [
      { legacyDescription: true, noPanelId: true, panelLevel: null },
      { legacyDescription: true, noPanelId: true, bonusLineBreak: true },
      { legacyDescription: true, noPanelId: true, panelLevel: null, bonusLineBreak: true },
    ])
      await withSource({}, detail, async ({ source, control }) => {
        const result = await searchPetPricing(record(), control.signal, source);
        assert.equal(result.total, 368.6);
        assert.equal(result.items[0].candidates[0].verified, true);
        assert.equal(result.searchItems[0].detailFailures.length, 0);
        assert.match(result.items[0].candidates[0].quote, /攻击资质：1550 \+22/);
      });
  });
  await check("商品信息等级或重复的结构化资质冲突仍拒绝采用", async () => {
    for (const detail of [
      { panelLevel: null, infoLevel: "120" },
      { panelLevel: null, infoLevel: "" },
      { panelLevel: "120", infoLevel: "119" },
      { duplicateFields: [{ name: "攻击资质", value: "1551 +22" }] },
    ])
      await withSource({}, detail, async ({ source, control }) => {
        const result = await searchPetPricing(record(), control.signal, source);
        assert.equal(result.total, null);
        assert.equal(result.items[0].candidates[0].verified, false);
        assert.ok(result.searchItems[0].detailFailures.length > 0);
      });
  });
  await check("分号描述缺少官网解析器、解析失败或完整列表缺失时保留读取失败", async () => {
    for (const detail of [
      { legacyDescription: true, missingPetParser: true },
      { legacyDescription: true, petParserFailure: true },
      { legacyDescription: true, incompleteJson: true },
    ])
      await withSource({}, detail, async ({ source, control }) => {
        const result = await searchPetPricing(record(), control.signal, source);
        assert.equal(result.total, null);
        assert.ok(result.searchItems[0].detailFailures.length > 0);
        assert.equal(result.items[0].candidates[0].verified, false);
      });
  });

  await check("缺少解码器、解码失败或解码后JSON损坏保留读取失败", async () => {
    for (const detail of [
      { encodedJson: true, missingDecoder: true },
      { encodedJson: true, decoderFailure: true },
      { encodedJson: true, malformedDecoded: true },
    ])
      await withSource({}, detail, async ({ source, control }) => {
        const result = await searchPetPricing(record(), control.signal, source);
        assert.equal(result.total, null);
        assert.match(result.items[0].candidates[0].reason, /描述详情未识别/);
        const failure = result.searchItems[0].detailFailures[0];
        assert.ok(failure);
        assert.deepEqual(failure.diagnostics.descriptionFormat, [
          {
            length: "@Sfixture@".length,
            semicolonFields: 1,
            attributeParserAvailable: false,
            encoded: true,
            decoderAvailable: !detail.missingDecoder,
          },
        ]);
      });
  });
  await check("技能/内丹/随身装备不完整或主JSON缺失不产出价格", async () => {
    for (const detail of [
      { missingSkill: true },
      { missingInner: true },
      { incompleteJson: true },
      { noPanelId: true, incompleteJson: true },
      { equipment: petGear, missingGear: true },
    ])
      await withSource({}, detail, async ({ source, control }) => {
        const result = await searchPetPricing(
          record(detail.equipment || []),
          control.signal,
          source,
        );
        assert.equal(result.total, null);
        assert.equal(result.items[0].candidates[0].verified, false);
        assert.match(result.items[0].candidates[0].reason, /完整|未确认|未显示|不一致/);
      });
  });
  await check("未证实独立模板的赐福配置保留明确拒绝理由，不混用永久技能相同报价", async () => {
    for (const detail of [
      { evolSkills: [{ skill_type: "1", name: "须弥真言" }] },
      { evolSkillMap: { 1: 1 } },
    ])
      await withSource({}, detail, async ({ source, control }) => {
        const result = await searchPetPricing(record(), control.signal, source);
        assert.equal(result.total, null);
        assert.match(result.items[0].candidates[0].reason, /未来\/赐福技能描述结构/);
        assert.equal(result.items[0].searchState, "unsupported");
        assert.equal(result.items[0].status, "unsupported");
        assert.equal(result.searchComplete, true);
        assert.equal(result.items[0].referencePrice, null);
        assert.ok(!result.items[0].similarEstimate?.range);
        assert.ok(result.searchItems.some((item) => item.unsupportedDetails.length > 0));
        assert.ok(result.searchItems.every((item) => item.detailFailures.length === 0));
      });
    await withSource({}, {}, async ({ source, control }) => {
      const input = record();
      input.detail.tabs[0].pets[0].fields = [...petFields, { name: "赐福", value: "须弥真言" }];
      const result = await searchPetPricing(input, control.signal, source);
      assert.equal(result.total, null);
      assert.match(result.items[0].issues.join("；"), /存在赐福配置.*完整赐福技能/);
      assert.deepEqual(detailVisits, []);
    });
  });
  await check("进化后获得的预览技能与当前技能分别核验，未支持配置保留未知价", async () => {
    for (const detail of [
      { evolSkills: [{ skill_type: "1" }] },
      { legacyDescription: true, noPanelId: true, panelLevel: null, bonusLineBreak: true },
    ])
      await withSource(
        {},
        {
          ...detail,
          previewSkills: [
            "高级吸血（进化后获得）",
            "高级偷袭（进化后获得）",
            "超级奔雷咒（进化后获得）",
          ],
        },
        async ({ source, control }) => {
          const result = await searchPetPricing(record(), control.signal, source);
          assert.equal(result.total, null);
          assert.equal(result.items[0].referencePrice, null);
          assert.equal(result.items[0].searchState, "unsupported");
          assert.equal(result.searchComplete, true);
          assert.ok(result.searchItems.some((item) => item.unsupportedDetails.length > 0));
          assert.ok(result.searchItems.every((item) => item.detailFailures.length === 0));
        },
      );
  });
  await check("明确无赐福与有效赐福数0经实际表单搜索和独立详情正常定价", async () => {
    for (const [target, sourceField] of [
      [
        { name: "赐福", value: "无" },
        { name: "有效赐福技能数", value: "0" },
      ],
      [
        { name: "有效赐福技能数", value: "0" },
        { name: "赐福", value: "无" },
      ],
    ])
      await withSource({}, { fields: [...petFields, sourceField] }, async ({ source, control }) => {
        const input = record();
        input.detail.tabs[0].pets[0].fields = [...petFields, target];
        const result = await searchPetPricing(input, control.signal, source);
        assert.equal(result.total, 368.6);
        assert.ok(result.items[0].candidates.some((candidate) => candidate.verified));
        assert.ok(detailVisits.length > 0);
      });
  });
  await check(
    "官网legacy的EvolSkill管道字符串与parser对象核对未来预览后采用同配置价格",
    async () => {
      const name = "超级法术暴击（进化后获得）";
      const configuration = {
        parsedSkillIds: [661, 577],
        evolRaw: "577",
        evolSkillMap: ["577"],
        evolSkills: [{ skill_type: "577", level: 1, evol_type: "577", name, hlightLight: true }],
        previewSkills: [name],
        skillDirectory: {
          661: { name: "须弥真言" },
          577: { name: "高级法术暴击" },
          575: { name: "法术暴击" },
          55577: { name: "超级法术暴击" },
          56230: { name: "未明之赐" },
        },
        evolMappings: {
          577: { high_skill: 577, low_skill: 575, super_skill: 55577, name: "超级法术暴击" },
        },
      };
      for (const legacyDescription of [false, true])
        await withSource(
          {},
          { ...configuration, legacyDescription },
          async ({ source, control }) => {
            const input = record();
            input.detail.tabs[0].pets[0].skills.push({ name, index: 2, kind: "skill" });
            const result = await searchPetPricing(input, control.signal, source);
            assert.equal(result.total, 368.6);
            assert.ok(result.items[0].candidates.some((candidate) => candidate.verified));
            assert.match(
              result.items[0].candidates[0].quote,
              /未来技能：超级法术暴击（进化后获得）/,
            );
            assert.ok(!result.searchItems.some((item) => item.unsupportedDetails.length > 0));
          },
        );
      for (const broken of [
        { evolSkillMap: ["577", "661"] },
        { evolSkills: [{ ...configuration.evolSkills[0], hlightLight: false }] },
        { evolSkills: [{ ...configuration.evolSkills[0], name: "伪造（进化后获得）" }] },
      ])
        await withSource({}, { ...configuration, ...broken }, async ({ source, control }) => {
          const result = await searchPetPricing(record(), control.signal, source);
          assert.equal(result.total, null);
          assert.equal(result.items[0].searchState, "unsupported");
        });
      await withSource(
        {},
        { ...configuration, evolRaw: "577|56230", evolSkillMap: ["577", "56230"] },
        async ({ source, control }) => {
          const result = await searchPetPricing(record(), control.signal, source);
          assert.equal(result.total, null);
          assert.equal(result.items[0].searchState, "unsupported");
          assert.match(result.items[0].candidates[0].reason, /未明之赐占位尚未揭示技能/);
        },
      );
    },
  );
  await check("未来预览不能补足缺失的当前技能，额外当前技能仍拒绝", async () => {
    for (const detail of [
      { previewSkills: ["须弥真言（进化后获得）"], missingSkill: true },
      { previewSkills: ["额外当前技能"] },
    ])
      await withSource(
        {},
        { evolSkills: [{ skill_type: "1" }], ...detail },
        async ({ source, control }) => {
          const result = await searchPetPricing(record(), control.signal, source);
          assert.equal(result.total, null);
          assert.equal(result.searchComplete, false);
          assert.equal(result.items[0].searchState, "read_failed");
          assert.ok(result.searchItems.some((item) => item.detailFailures.length > 0));
        },
      );
  });
  await check("同一赐福详情必须先通过商品绑定、完整字段和可见价格核验", async () => {
    for (const broken of [
      { missingPayloadField: "all_skills" },
      { missingPayloadField: "neidan" },
      { missingPayloadField: "equip_list" },
      { rawEid: "another-product" },
      { rawName: "另一商品" },
      { rawPrice: "999" },
      { panelLevel: "120" },
      { missingSkill: true },
      { duplicateFields: [{ name: "攻击资质", value: "1551 +22" }] },
    ])
      await withSource(
        {},
        { evolSkills: [{ skill_type: "1" }], previewSkills: ["须弥真言（进化后获得）"], ...broken },
        async ({ source, control }) => {
          const result = await searchPetPricing(record(), control.signal, source);
          assert.equal(result.total, null);
          assert.equal(result.searchComplete, false);
          assert.equal(result.items[0].searchState, "read_failed");
          assert.ok(result.searchItems.some((item) => item.detailFailures.length > 0));
          assert.ok(result.searchItems.every((item) => item.unsupportedDetails.length === 0));
        },
      );
  });
  await check("前排配置不支持或详情损坏时停止读取后排商品，分别保留具体原因", async () => {
    const cifu = { eid: "cifu", name: "宝宝昵称", type: "2001" };
    const broken = { eid: "broken", name: "宝宝昵称", type: "2001" };
    for (const rows of [
      [cifu, broken],
      [broken, cifu],
    ]) {
      await withSource(
        { pages: [rows] },
        (id) => (id === "cifu" ? { evolSkills: [{ skill_type: "1" }] } : { incompleteJson: true }),
        async ({ source, control }) => {
          const result = await searchPetPricing(record(), control.signal, source);
          const unsupported = rows[0].eid === "cifu";
          assert.equal(result.total, null);
          assert.equal(result.items[0].referencePrice, null);
          assert.equal(result.items[0].searchState, unsupported ? "unsupported" : "read_failed");
          assert.equal(result.searchComplete, unsupported);
          assert.deepEqual(detailVisits, [rows[0].eid]);
          assert.ok(
            result.searchItems.some(
              (x) => (unsupported ? x.unsupportedDetails : x.detailFailures)?.length > 0,
            ),
          );
        },
      );
    }
  });
  await check("明确base+bonus与合计不同，资质冲突不套价", () =>
    withSource(
      {},
      {
        fields: petFields.map((field) =>
          field.name === "攻击资质" ? { ...field, value: "1572" } : field,
        ),
      },
      async ({ source, control }) => {
        const result = await searchPetPricing(record(), control.signal, source);
        assert.equal(result.total, null);
        assert.match(result.items[0].candidates[0].reason, /可见属性不一致/);
      },
    ),
  );
  await check("独立宝宝装备通过悬停显示后核对名称、属性和饰品身份", async () => {
    for (const gear of [
      petGear,
      [
        ...petGear,
        { name: "画魂饰品", description: "玄天灵力 529", shipin: true, location: "RolePetShipin" },
      ],
    ])
      for (const detail of [{}, { legacyDescription: true, noPanelId: true, panelLevel: null }])
        await withSource(
          {},
          { ...detail, equipment: gear, lazyGear: true },
          async ({ source, control }) => {
            const result = await searchPetPricing(record(gear), control.signal, source);
            assert.equal(result.total, 368.6, JSON.stringify(result.searchItems));
            assert.equal(result.searchComplete, true);
            assert.equal(result.items[0].candidates[0].verified, true);
          },
        );
  });
  await check("装备仅内联等级时仍悬停补齐完整属性", () =>
    withSource(
      {},
      { equipment: petGear, lazyGear: true, partialInlineGear: true },
      async ({ source, control }) => {
        const result = await searchPetPricing(record(petGear), control.signal, source);
        assert.equal(result.total, 368.6, JSON.stringify(result.searchItems));
        assert.equal(result.searchComplete, true);
        assert.equal(result.items[0].candidates[0].verified, true);
      },
    ),
  );
  await check("仅CSS类名的装备提示也与宝宝主属性隔离", async () => {
    for (const partialInlineGear of [false, true])
      await withSource(
        {},
        { equipment: petGear, lazyGear: true, classOnlyGearTooltip: true, partialInlineGear },
        async ({ source, control }) => {
          const result = await searchPetPricing(record(petGear), control.signal, source);
          assert.equal(result.total, 368.6, JSON.stringify(result.searchItems));
          assert.equal(result.searchComplete, true);
          assert.equal(result.items[0].candidates[0].verified, true);
        },
      );
  });
  await check("装备提示不完整时仍保留读取失败，不用隐藏描述代替可见资料", () =>
    withSource(
      {},
      { equipment: petGear, lazyGear: true, brokenGearTooltip: true },
      async ({ source, control }) => {
        const result = await searchPetPricing(record(petGear), control.signal, source);
        assert.equal(result.total, null);
        assert.equal(result.searchComplete, false);
        assert.equal(result.items[0].searchState, "read_failed");
      },
    ),
  );
  await check("装备背景说明不作为镶嵌属性，官网装备仍逐项核验", async () => {
    const gear = [
      {
        name: "嵌宝金环",
        description:
          "等级 95\n速度 +29 伤害 +45\n耐久度 307 修理失败 1次\n镶嵌效果\n+30速度 镶嵌等级：5",
      },
    ];
    for (const detail of [{}, { legacyDescription: true, lazyGear: true }])
      await withSource(
        {},
        { ...detail, equipment: gear, gearFlavor: "镶嵌着宝物的金环，可以提高速度。\n" },
        async ({ source, control }) => {
          const result = await searchPetPricing(record(gear), control.signal, source);
          assert.equal(result.total, 368.6, JSON.stringify(result.searchItems));
          assert.equal(result.searchComplete, true);
          assert.equal(result.items[0].candidates[0].verified, true);
        },
      );
  });
  await check("相同宝宝装备包价只计一次，饰品保留身份和可见描述不补战斗属性", async () => {
    for (const gear of [
      petGear,
      [
        {
          name: "吸血鬼饰品",
          description: "修理失败 2次\n外观说明：红色披风",
          shipin: true,
          location: "RolePetShipin",
        },
      ],
    ])
      await withSource({}, { equipment: gear }, async ({ source, control }) => {
        const result = await searchPetPricing(record(gear), control.signal, source);
        assert.equal(result.total, 368.6);
        assert.equal(result.knownTotal, 368.6);
        assert.equal(result.items[0].referencePrice, 368.6);
      });
  });
  await check("另一商品ID、主名称冲突、原价单位错或下架均拒绝", async () => {
    for (const detail of [
      { rawEid: "other" },
      { rawName: "其他宝宝" },
      { rawPrice: 36860 },
      { status: "已下架", selling: 1 },
      { splitRegions: true },
      { duplicatePanel: true },
      { noPanelId: true, splitRegions: true },
      { noPanelId: true, duplicatePanel: true },
    ])
      await withSource({}, detail, async ({ source, control }) => {
        const result = await searchPetPricing(record(), control.signal, source);
        assert.equal(result.total, null);
        assert.equal(result.items[0].candidates[0].verified, false);
        if (detail.splitRegions || detail.duplicatePanel) {
          const failure = result.searchItems[0].detailFailures[0];
          assert.ok(failure.diagnostics);
          assert.ok(Array.isArray(failure.diagnostics.panels));
          assert.equal(failure.diagnostics.jsonInputs, 1);
          if (detail.duplicatePanel)
            assert.equal(failure.diagnostics.panels.length, detail.noPanelId ? 0 : 2);
        }
      });
  });
  await check("不支持类型只留本项缺价，后续宝宝仍可查", () =>
    withSource({}, {}, async ({ source, control }) => {
      const result = await source.findCandidates(
        [
          {
            ...record().detail.tabs[0].pets[0],
            key: "unknown",
            name: "目录外宝宝",
            fields: [],
            skills: [],
            innerSkills: [],
            equipment: [],
          },
          {
            key: "valid",
            name: "画魂",
            level: 119,
            fields: petFields,
            skills: petSkills,
            innerSkills: [{ name: "催心浪", level: "5" }],
            equipment: [],
          },
        ],
        control.signal,
      );
      assert.match(result.items[0].note, /类型目录未识别/);
      assert.equal(result.items[1].candidates[0].verified, true);
      assert.equal(result.queries.length, 1);
    }),
  );
  await check("分页结果不足十件时去重后用实际样本均价，所有候选都经过主详情核对", () =>
    withSource(
      {
        pages: [
          [{ eid: "a", name: "昵称A" }],
          [
            { eid: "a", name: "昵称A" },
            { eid: "b", name: "昵称B" },
          ],
        ],
      },
      (eid) => ({ price: eid === "a" ? 1000 : 1400, rawPrice: eid === "a" ? "1000" : "1400" }),
      async ({ source, control }) => {
        const result = await searchPetPricing(record(), control.signal, source);
        assert.equal(result.total, 1200);
        assert.deepEqual(detailVisits, ["a", "b"]);
        assert.equal(result.items[0].candidates.filter((value) => value.verified).length, 2);
      },
    ),
  );
  await check("前五件宝宝跨页去重和断点续查后计算均价，不采用第六件低价", async () => {
    const prices = [100, 110, 120, 130, 140, 150, 160, 170, 180, 900, 1];
    const rows = prices.map((_, index) => ({ eid: `ten-${index}`, name: "宝宝昵称" }));
    const pages = [rows.slice(0, 5), [rows[0], ...rows.slice(5)]];
    const detail = (eid) => {
      const price = prices[Number(eid.split("-").at(-1))];
      return { price, rawPrice: price };
    };
    let previous;
    const visits = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      await withSource({ pages }, detail, async ({ source, control }) => {
        previous = await searchPetPricing(record(), control.signal, source, previous);
        visits.push(...detailVisits);
      });
      if (previous.searchComplete) break;
      assert.equal(previous.total, null);
      assert.equal(previous.items[0].searchState, "pending");
    }
    assert.equal(previous.searchComplete, true);
    assert.equal(previous.items[0].searchState, "completed");
    assert.equal(previous.total, 120);
    assert.equal(previous.items[0].priceMethod, "first-five-average-v3");
    assert.deepEqual(
      previous.items[0].candidates.map(({ price }) => price),
      prices.slice(0, 5),
    );
    assert.ok(previous.items[0].candidates.every(({ verified }) => verified));
    assert.ok(!visits.includes("ten-5"));
  });
  await check("官网空结果保留未定价，验证码/查询失败中止而非伪造无匹配", async () => {
    await withSource({ pages: [[]] }, {}, async ({ source, control }) => {
      const result = await searchPetPricing(record(), control.signal, source);
      assert.equal(result.total, null);
      assert.deepEqual(detailVisits, []);
    });
    for (const mode of ["guard", "error", "transport_failure"])
      await withSource({ mode }, {}, async ({ source, control }) => {
        await assert.rejects(searchPetPricing(record(), control.signal, source));
      });
  });
  await check("取消自动关闭自有页，原角色列表和分页/检查点保持", () =>
    withSource({}, {}, async ({ source, control, searchPage, detailPage }) => {
      control.abort(new Error("用户暂停"));
      await source.close();
      assert.equal(searchPage.isClosed(), true);
      assert.equal(detailPage.isClosed(), true);
      assert.deepEqual(
        await role.evaluate(() => ({
          url: location.href,
          args: window.QueryArgs,
          checkpoint: window.checkpoint,
        })),
        before,
      );
    }),
  );
} finally {
  await browser?.close().catch(() => {});
  await persistent?.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
console.log(
  `SIMULATED DOM SUMMARY: ${passed} passed, ${failed} failed; isolated Chrome with intercepted fixtures, no real market or user session used.`,
);
if (failed) process.exitCode = 1;
