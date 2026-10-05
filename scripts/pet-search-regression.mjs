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
const integrity = await moduleUrl("server/analysis/pricing-integrity.ts");
const estimate = await moduleUrl("server/analysis/pricing-estimate.ts", {
  "./pricing-integrity": integrity,
});
const matcher = await moduleUrl("server/analysis/equipment-match.ts", {
  "./equip-attributes": attributes,
});
const pricing = await moduleUrl("server/analysis/equipment-pricing.ts", {
  "./pricing-estimate": estimate,
  "./pricing-integrity": integrity,
  "./equipment-match": matcher,
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
const petPricing = await moduleUrl("server/analysis/pet-pricing.ts", {
  "./pricing-estimate": estimate,
  "./pricing-integrity": integrity,
  "../crawler/compact": compact,
  "./equipment-pricing": pricing,
  "./valuation-calculator": await moduleUrl("server/analysis/valuation-calculator.ts", {
    "./valuation-facts": await moduleUrl("server/analysis/valuation-facts.ts"),
  }),
});
const { searchPetPricing } = await import(petPricing);
const { petSourceFromPages } = await import(
  await moduleUrl("server/analysis/browser-pet-source.ts", {
    "../session": session,
    "../crawler/controller": inline(
      "export function crawlDatabase(){throw new Error('Fixture must not open the application database');}",
    ),
    "../crawler/page": pacedPage,
    "../page-state": pageState,
    "../workflow": workflow,
    "../crawler/compact": compact,
    "./equipment-pricing": pricing,
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
        return (fn, arg, options = {}) =>
          target.waitForFunction(fn, arg, {
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
  await check("source→adapter完整核对全服宝宝，正确读取元价格且排除推荐/跨服费", () =>
    withSource({}, {}, async ({ source, searchPage, control }) => {
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
      assert.equal(query.server_type, undefined);
      assert.equal(await searchPage.evaluate(() => window.historyWrites), 0);
      assert.equal(
        await role.evaluate(() => localStorage.getItem("saved_overall_search_pet_query")),
        "kept",
      );
      assert.equal(result.items[0].candidates[0].sourceHash.length, 64);
      assert.equal(result.queries.length, 1);
    }),
  );
  await check("技能/内丹/随身装备不完整或主JSON缺失不产出价格", async () => {
    for (const detail of [
      { missingSkill: true },
      { missingInner: true },
      { incompleteJson: true },
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
        assert.match(result.items[0].candidates[0].reason, /赐福配置/);
      });
    await withSource({}, {}, async ({ source, control }) => {
      const input = record();
      input.detail.tabs[0].pets[0].fields = [...petFields, { name: "赐福", value: "须弥真言" }];
      const result = await searchPetPricing(input, control.signal, source);
      assert.equal(result.total, null);
      assert.match(result.items[0].issues.join("；"), /赐福字段/);
      assert.deepEqual(detailVisits, []);
    });
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
    ])
      await withSource({}, detail, async ({ source, control }) => {
        const result = await searchPetPricing(record(), control.signal, source);
        assert.equal(result.total, null);
        assert.equal(result.items[0].candidates[0].verified, false);
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
  await check("分页结果去重后用独立样本中位数，所有候选都经过主详情核对", () =>
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
  `SIMULATED DOM SUMMARY: ${passed} passed, ${failed} failed; no real browser/session/market used.`,
);
if (failed) process.exitCode = 1;
