import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { chromium } from "playwright-core";
import {
  petGearSearchDocument,
  petGearDetailDocument,
} from "../tests/fixtures/pet-gear-search-site.mjs";

// Isolated temporary profile, intercepted requests, production DOM helpers. No market evidence.
const inline = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const modules = new Map();
async function moduleUrl(relative) {
  const file = path.resolve(relative);
  if (modules.has(file)) return modules.get(file);
  if (file.endsWith("/server/session.ts")) {
    const url = inline(
      "export async function getBrowser(){return globalThis.petGearRegressionContext}export async function createHiddenPage(){return globalThis.petGearRegressionContext.newPage()}",
    );
    modules.set(file, url);
    return url;
  }
  if (file.endsWith("/server/crawler/controller.ts")) {
    const url = inline(
      "export function crawlDatabase(){throw Error('Fixture must not read app DB')}export function savedDetail(){throw Error('Fixture must not read app DB')}",
    );
    modules.set(file, url);
    return url;
  }
  let source = ts.transpileModule(await readFile(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  if (file.endsWith("/server/crawler/page.ts")) {
    source = source.replace(
      /export async function pace\([\s\S]*?\n\}\n(?=export async function assertAvailable)/,
      "export async function pace(signal){signal.throwIfAborted()}\n",
    );
  }
  for (const specifier of new Set(
    [...source.matchAll(/from ["']([^"']+)["']/g)].map((match) => match[1]),
  )) {
    if (!specifier.startsWith(".")) continue;
    const target = path.resolve(path.dirname(file), specifier + ".ts");
    const url = await moduleUrl(target);
    source = source
      .replaceAll(`from "${specifier}"`, `from "${url}"`)
      .replaceAll(`from '${specifier}'`, `from '${url}'`);
  }
  const url = inline(source);
  modules.set(file, url);
  return url;
}

const { createPetGearSource, PET_GEAR_SEARCH_URL } = await import(
  await moduleUrl("server/analysis/browser-pet-gear-source.ts")
);
const { petGearReference } = await import(await moduleUrl("server/analysis/pet-gear-inventory.ts"));
const profile = await mkdtemp(path.join(os.tmpdir(), "cbg-pet-gear-ui-regression-"));
let context,
  passed = 0;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath:
      process.env.CBG_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    viewport: { width: 1400, height: 1200 },
    serviceWorkers: "block",
    args: ["--disable-background-networking", "--disable-component-update", "--disable-sync"],
  });
  globalThis.petGearRegressionContext = context;
  let settings = {},
    detailSettings = {},
    requests = [],
    formStates = [],
    detailVisits = [],
    navigationCount = 0;
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://xyq.cbg.163.com") return route.abort();
    if (url.pathname === "/cgi-bin/recommend.py") {
      requests.push(Object.fromEntries(url.searchParams));
      formStates.push(
        await route
          .request()
          .frame()
          .page()
          .evaluate(() => ({
            area: document.getElementById("overall_sel_area").value,
            server: document.getElementById("ovarall_sel_server").value,
            noSuit: document.getElementById("no_suit_effect").checked,
            coverSuit: document.getElementById("has_suit_effect").checked,
            includeDamage: document.getElementById("addon_sum_include_damage").checked,
            priceMin: document.getElementById("price_min").value,
            priceMax: document.getElementById("price_max").value,
          })),
      );
      return route.fulfill({ contentType: "application/json", body: "{}" });
    }
    if (url.pathname === "/cgi-bin/xyq_overall_search.py") {
      navigationCount++;
      const publicLogin =
        settings.failLoginAtNavigation && navigationCount >= settings.failLoginAtNavigation ? 0 : 1;
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: petGearSearchDocument({ ...settings, publicLogin }),
      });
    }
    if (url.pathname === "/equip") {
      const id = url.searchParams.get("eid");
      detailVisits.push(id);
      const price = settings.prices?.[id] ?? { one: 200, two: 220, three: 240 }[id] ?? 100;
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        // Simulate the final URL/identity of a redirect without allowing redirect-chain network traffic.
        body:
          (settings.detailLogin === id
            ? "<script>history.replaceState(null,'','/cgi-bin/show_login.py');window.IsLogin=0</script>"
            : "") +
          (settings.redirectFrom === id
            ? "<script>history.replaceState(null,'','/equip?s=1&eid=redirected-product')</script>"
            : "") +
          petGearDetailDocument({
            ...settings,
            price,
            ...detailSettings,
            ...(settings.descriptions?.[id] ? { description: settings.descriptions[id] } : {}),
          }),
      });
    }
    return route.abort();
  });
  const item = (slot, level, description) => ({
    key: "模拟宝宝:1:gear:0",
    petKey: "模拟宝宝:1",
    petName: "模拟宝宝",
    name: "测试" + slot,
    level,
    category: "召唤兽装备",
    description,
    accessory: false,
    rawItem: { index: 0, kindId: "29", attributes: { 装备类型: slot } },
    query: "",
    status: "no_match",
    referencePrice: null,
    candidates: [],
    issues: [],
  });
  const run = async (target, overrides = {}, details = {}, budgets = {}) => {
    settings = {
      name: target.name,
      level: target.level,
      description: target.description,
      pages: [["one"], ["two", "three"]],
      ...overrides,
    };
    detailSettings = details;
    requests = [];
    formStates = [];
    detailVisits = [];
    navigationCount = 0;
    const source = await createPetGearSource(new AbortController().signal, budgets);
    try {
      return await source.findCandidates([target], new AbortController().signal);
    } finally {
      await source.close();
    }
  };
  const check = async (name, callback) => {
    if (process.env.CBG_OFFLINE_FILTER && !name.includes(process.env.CBG_OFFLINE_FILTER)) return;
    await callback();
    passed++;
    console.log("PASS (SIMULATED): " + name);
  };
  await check("模拟旧条件确实会污染请求，地区与复选框初始有残留", async () => {
    settings = {};
    requests = [];
    formStates = [];
    const page = await context.newPage();
    try {
      await page.goto(PET_GEAR_SEARCH_URL);
      await page.locator("#btn_do_query").click();
      await page.waitForFunction(() => !!document.querySelector("#soldList"));
      assert.equal(requests.length, 1);
      const request = requests[0];
      assert.equal(request.include_no_skill, "1");
      assert.equal(request.include_can_cover_skill, "1");
      assert.equal(request.addon_sum_include_damage, "1");
      assert.equal(request.serverid, "1");
      assert.equal(request.cross_buy_serverid, "33");
      assert.equal(request.price_min, "9900");
      assert.equal(request.price_max, "99900");
      assert.deepEqual(formStates[0], {
        area: "33",
        server: "1",
        noSuit: true,
        coverSuit: true,
        includeDamage: true,
        priceMin: "99",
        priceMax: "999",
      });
    } finally {
      await page.close();
    }
  });
  const queryFields = [
    "speed",
    "fangyu",
    "mofa",
    "shanghai",
    "hp",
    "hit_ratio",
    "xiang_qian_level",
    "xiangqian_stone_attr",
    "addon_fali",
    "addon_liliang",
    "addon_lingli",
    "addon_minjie",
    "addon_naili",
    "addon_tizhi",
    "addon_sum_min",
    "addon_minjie_reduce",
    "addon_status",
    "repair_failed_times",
  ];
  const assertQueryFields = (request, expected) => {
    assert.deepEqual(
      Object.fromEntries(
        queryFields.filter((key) => Object.hasOwn(request, key)).map((key) => [key, request[key]]),
      ),
      expected,
    );
  };
  const assertClearedFilters = () => {
    for (const request of requests) {
      for (const key of [
        "cross_buy_serverid",
        "serverid",
        "areaid",
        "addon_sum_include_damage",
        "include_no_skill",
        "include_can_cover_skill",
        "price_min",
        "price_max",
      ])
        assert.equal(request[key], undefined, "残留条件未清空：" + key);
    }
    assert.equal(formStates.length, requests.length);
    for (const state of formStates)
      assert.deepEqual(state, {
        area: "",
        server: "",
        noSuit: false,
        coverSuit: false,
        includeDamage: false,
        priceMin: "",
        priceMax: "",
      });
  };
  for (const { target, expected } of [
    {
      target: item(
        "护腕",
        95,
        "等级 95\n命中率 +13%\n耐久度 113\n耐力 +14 魔力 +13\n套装效果：附加状态高级神佑复生\n镶嵌效果\n+28灵力 镶嵌等级：7",
      ),
      expected: {
        hit_ratio: "13",
        addon_naili: "1",
        addon_fali: "1",
        addon_sum_min: "27",
        xiangqian_stone_attr: "2",
        xiang_qian_level: "7",
        addon_status: "高级神佑复生",
      },
    },
    {
      target: item(
        "项圈",
        25,
        "等级 25\n速度 +20\n耐久度 120\n耐力 +8 魔力 +8\n镶嵌效果\n+24速度 镶嵌等级：4",
      ),
      expected: {
        speed: "20",
        addon_naili: "1",
        addon_fali: "1",
        addon_sum_min: "16",
        xiangqian_stone_attr: "3",
        xiang_qian_level: "4",
      },
    },
    {
      target: item(
        "铠甲",
        115,
        "等级 115\n气血 +150 防御 +110\n耐久度 200\n魔力 +20\n镶嵌效果\n+64防御 镶嵌等级：8",
      ),
      expected: {
        hp: "150",
        fangyu: "110",
        addon_fali: "1",
        addon_sum_min: "20",
        xiangqian_stone_attr: "6",
        xiang_qian_level: "8",
      },
    },
  ]) {
    await check(
      target.level +
        "级" +
        target.rawItem.attributes.装备类型 +
        "真实填框/多选/拖动/按钮/翻页/主商品",
      async () => {
        const result = await run(target);
        assert.equal(result.items[0].searchStatus, "completed", result.items[0].note);
        assert.equal(
          result.items[0].candidates.filter((candidate) => candidate.verified).length,
          3,
        );
        assert.equal(petGearReference(result.items[0].candidates).referencePrice, 200);
        assert.deepEqual(
          requests.map((request) => request.page),
          ["1", "2"],
        );
        for (const request of requests) {
          assert.equal(request.server_type, "3");
          assert.equal(request.level_min, String(target.level));
          assert.equal(request.level_max, String(target.level));
          assert.equal(
            request.equip_pos,
            { 项圈: "2", 铠甲: "1", 护腕: "3" }[target.rawItem.attributes.装备类型],
          );
          assertQueryFields(request, expected);
        }
        assertClearedFilters();
        assert.equal(result.items[0].scopeEvidence.length, 2);
        assert.equal(result.searchItems[0].searchUrl, PET_GEAR_SEARCH_URL);
        assert.equal(result.searchItems[0].query.level, target.level);
        assert.equal(result.searchItems[0].submittedArgs.level_min, target.level);
        assert.equal(result.searchItems[0].submittedArgs.level_max, target.level);
        assert.ok(result.searchItems[0].actions.some((action) => action.method === "drag"));
        assert.ok(result.searchItems[0].actions.some((action) => action.method === "fill"));
      },
    );
  }
  const target = item("项圈", 25, "等级 25\n速度 +20\n耐久度 120");
  await check("详情跳转登录时停止查询，保留失败断点，不按无样本跳过", async () => {
    const target = item("护腕", 85, "等级 85\n装备对象 召唤兽\n防御 +45\n耐久度 100");
    const result = await run(target, { detailLogin: "one" });
    assert.equal(result.items[0].searchStatus, "read_failed");
    assert.match(result.items[0].note, /登录/);
    assert.equal(result.items[0].searchCursor.failed.length, 1);
    assert.equal(result.items[0].candidates.filter((candidate) => candidate.verified).length, 0);
    assert.deepEqual(detailVisits, ["one"]);
  });
  await check("详情跳转到另一商品不能作为原链接报价", async () => {
    const result = await run(target, { pages: [["one"]], redirectFrom: "one" });
    assert.equal(result.items[0].searchStatus, "read_failed");
    assert.match(result.items[0].note, /另一商品/);
    assert.equal(result.items[0].candidates.length, 0);
    assert.equal(petGearReference(result.items[0].candidates).referencePrice, null);
    assert.deepEqual(detailVisits, ["one"]);
    const directory = "data/pr27-fix-validation";
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "pet-gear-redirect.json"),
      JSON.stringify(
        {
          simulated: true,
          scenario: "final product URL differs from requested listing",
          detailVisits,
          requests,
          result,
        },
        null,
        2,
      ),
    );
  });
  await check("前五件宝宝装备跨页去重取最低价，不采用第六件低价", async () => {
    const prices = [100, 110, 120, 130, 140, 150, 160, 170, 180, 900, 1];
    const ids = prices.map((_, index) => `ten-${index}`);
    const result = await run(target, {
      pages: [ids.slice(0, 5), [ids[0], ...ids.slice(5)]],
      prices: Object.fromEntries(ids.map((id, index) => [id, prices[index]])),
    });
    assert.equal(result.items[0].searchStatus, "completed", result.items[0].note);
    assert.deepEqual(detailVisits, ids.slice(0, 5));
    assert.deepEqual(
      result.items[0].candidates.map(({ price }) => price),
      prices.slice(0, 5),
    );
    assert.equal(petGearReference(result.items[0].candidates).referencePrice, 100);
    assert.deepEqual(
      requests.map(({ page }) => page),
      ["1"],
    );
  });
  await check("游标续查：详情预算保留当前页行位置与候选", async () => {
    const first = await run(target, { pages: [["one", "two", "three"]] }, {}, { maxDetails: 2 });
    assert.equal(first.items[0].searchStatus, "pending");
    assert.equal(first.items[0].searchCursor.pageNumber, 1);
    assert.equal(first.items[0].searchCursor.rowIndex, 2);
    assert.equal(first.items[0].candidates.filter((candidate) => candidate.verified).length, 2);
    const second = await run(
      { ...target, ...first.items[0] },
      { pages: [["one", "two", "three"]] },
    );
    assert.equal(second.items[0].searchStatus, "completed", second.items[0].note);
    assert.equal(second.items[0].searchCursor, undefined);
    assert.deepEqual(detailVisits, ["one", "two", "three"]);
    assert.equal(petGearReference(second.items[0].candidates).referencePrice, 200);
    assertClearedFilters();
  });
  await check("无样本第一页停止翻页，未读完页面变动后仍完整重读当前条件", async () => {
    const ids = ["empty-one", "empty-two", "empty-three"];
    const overrides = {
      pages: [ids, ["later-valid"]],
      descriptions: Object.fromEntries(
        ids.map((id) => [id, target.description.replace("+20", "+100")]),
      ),
    };
    const first = await run(target, overrides, {}, { maxDetails: 2 });
    assert.equal(first.items[0].searchStatus, "pending");
    assert.equal(first.items[0].searchCursor.rowIndex, 2);
    assert.equal(
      first.items[0].candidates.some((candidate) => candidate.verified),
      false,
    );
    const second = await run(
      { ...target, ...first.items[0] },
      { ...overrides, pages: [[...ids].reverse(), ["later-valid"]] },
    );
    assert.equal(second.items[0].samplingStopped, true, second.items[0].note);
    assert.equal(second.items[0].searchStatus, "pending");
    assert.equal(
      second.items[0].candidates.some((candidate) => candidate.verified),
      false,
    );
    assert.ok(requests.every((request) => request.page === "1"));
    assert.equal(
      second.searchItems.some((record) => record.reason === "result_order_changed"),
      false,
    );
    assert.ok(second.items[0].note.includes("市场售价未知"));
    await mkdir("data/pr27-fix-validation", { recursive: true });
    await writeFile(
      "data/pr27-fix-validation/pet-gear-empty-first-page.json",
      JSON.stringify({ simulated: true, first, second, requests, detailVisits }, null, 2),
    );
  });

  await check("游标续查：页面重排或清空时废弃旧取样组，从第一页重建", async () => {
    const first = await run(target, { pages: [["one", "two", "three"]] }, {}, { maxDetails: 2 });
    for (const changed of [["three", "one", "two"], []]) {
      const second = await run({ ...target, ...first.items[0] }, { pages: [changed] });
      const reset = second.items[0];
      assert.equal(reset.searchStatus, "pending", reset.note);
      assert.deepEqual(reset.candidates, []);
      assert.equal(reset.searchCursor.rowIndex, 0);
      assert.equal(reset.searchCursor.pageNumber, 1);
      assert.equal(reset.searchCursor.restartCount, 1);
      assert.deepEqual(reset.searchCursor.seen, []);
      assert.ok(second.searchItems.some((x) => x.reason === "result_order_changed"));
      if (changed.length) {
        const rebuilt = await run({ ...target, ...reset }, { pages: [changed] });
        assert.equal(rebuilt.items[0].searchStatus, "completed", rebuilt.items[0].note);
        assert.deepEqual(
          rebuilt.items[0].candidates.map((x) => new URL(x.url).searchParams.get("eid")),
          changed,
        );
        assert.equal(petGearReference(rebuilt.items[0].candidates).referencePrice, 200);
      }
    }
  });

  await check("游标续查：翻页重放有审计且预算后推进下一页", async () => {
    const overrides = {
      pages: [["badOne"], ["badTwo"], ["good"]],
      descriptions: {
        badOne: target.description,
        badTwo: target.description.replace("+20", "+100"),
      },
    };
    const first = await run(target, overrides, {}, { maxPages: 1 });
    assert.equal(first.items[0].searchStatus, "pending");
    assert.equal(first.items[0].searchCursor.pageNumber, 2);
    const second = await run({ ...target, ...first.items[0] }, overrides, {}, { maxPages: 1 });
    assert.equal(second.items[0].searchStatus, "pending");
    assert.equal(second.items[0].searchCursor.pageNumber, 3);
    assert.deepEqual(
      requests.map((request) => request.page),
      ["1", "2"],
    );
    assert.deepEqual(detailVisits, ["badOne", "badTwo"]);
    assert.equal(second.searchItems[0].replay, true);
    assert.equal(second.searchItems[1].page, 2);
    assertClearedFilters();
  });
  await check("官网顺序只取前五件相近报价最低价，不因距离或价差删除有效样本", async () => {
    const ids = ["farOne", "farTwo", "farThree", "nearOne", "nearTwo", "nearThree"];
    const result = await run(target, {
      pages: [ids],
      prices: Object.fromEntries(
        ids.map((id, index) => [id, [100, 300, 500, 220, 230, 240][index]]),
      ),
      descriptions: Object.fromEntries(
        ids.map((id, index) => [id, target.description.replace("+20", index < 3 ? "+16" : "+19")]),
      ),
    });
    assert.equal(result.items[0].searchStatus, "completed", result.items[0].note);
    assert.deepEqual(detailVisits, ids.slice(0, 5));
    assert.equal(petGearReference(result.items[0].candidates).referencePrice, 100);
    assert.equal(result.items[0].candidates.filter((candidate) => candidate.verified).length, 5);
  });
  await check("游标续查：失败详情先重试，再继续保存行之后的商品", async () => {
    const first = await run(target, {}, { kindId: 1 });
    assert.equal(first.items[0].searchStatus, "read_failed");
    assert.equal(first.items[0].searchCursor.rowIndex, 1);
    assert.equal(first.items[0].searchCursor.failed.length, 1);
    const second = await run({ ...target, ...first.items[0] });
    assert.equal(second.items[0].searchStatus, "completed", second.items[0].note);
    assert.deepEqual(detailVisits, ["one", "two", "three"]);
    assert.equal(second.items[0].searchCursor, undefined);
    assertClearedFilters();
  });
  await check("游标续查：属性计划变化不能复用旧报价与已读位置", async () => {
    const first = await run(target, { pages: [["one", "two", "three"]] }, {}, { maxDetails: 2 });
    const second = await run({
      ...target,
      ...first.items[0],
      description: target.description.replace("+20", "+40"),
    });
    assert.equal(second.items[0].searchStatus, "completed", second.items[0].note);
    assert.deepEqual(detailVisits, ["one", "two", "three"]);
    assert.ok(second.items[0].candidates.every((candidate) => candidate.quote.includes("+40")));
  });
  await check("套装前缀空白不会污染官网精确技能目录", async () => {
    const suit = item("护腕", 95, "等级95\n命中率+13%\n耐久113\n套装效果：附加状态 高级神佑复生");
    const result = await run(suit);
    assert.equal(result.items[0].searchStatus, "completed", result.items[0].note);
    assert.equal(result.items[0].candidates.filter((candidate) => candidate.verified).length, 3);
    for (const request of requests)
      assertQueryFields(request, { hit_ratio: "13", addon_status: "高级神佑复生" });
    assertClearedFilters();
  });
  await check("负敏捷实际填写减少控件、不误选正敏捷", async () => {
    const negative = item("项圈", 115, "等级 115\n伤害 +65\n力量 +10 敏捷 -5\n耐久度 200");
    const result = await run(negative);
    assert.equal(result.items[0].candidates.filter((candidate) => candidate.verified).length, 3);
    for (const request of requests)
      assertQueryFields(request, {
        shanghai: "65",
        addon_minjie_reduce: "5",
        addon_liliang: "1",
        addon_sum_min: "5",
      });
    assertClearedFilters();
  });
  await check("无附加属性无需调用不存在的空菜单ID", async () => {
    const result = await run(target);
    assert.equal(result.items[0].candidates.filter((candidate) => candidate.verified).length, 3);
  });
  for (const extraUiFilters of [{ price_max: 10000 }, { speed: 999 }]) {
    await check(
      "官网恢复额外宝宝装备条件时停止取价：" + JSON.stringify(extraUiFilters),
      async () => {
        const result = await run(target, { extraUiFilters });
        assert.equal(result.items[0].searchStatus, "read_failed");
        assert.match(result.items[0].note, /筛选条件|字段未生效/);
        assert.equal(result.items[0].candidates.length, 0);
        assert.equal(detailVisits.length, 0);
        assert.ok(result.searchItems[0].submittedArgs);
      },
    );
  }
  for (const scopeOverrides of [{ server_type: "2" }, { serverid: "33" }, { areaid: "33" }]) {
    await check("拒绝实际请求的服龄/单服限制：" + JSON.stringify(scopeOverrides), async () => {
      const result = await run(target, { scopeOverrides });
      assert.equal(result.items[0].searchStatus, "read_failed");
      assert.match(result.items[0].note, /三年以上|单服或地区/);
      assert.equal(result.items[0].candidates.length, 0);
      assert.equal(detailVisits.length, 0);
    });
  }
  await check("后续登录失效保留已完成gear，并停止未查询gear", async () => {
    settings = {
      name: target.name,
      level: target.level,
      description: target.description,
      pages: [["one", "two", "three"]],
      failLoginAtNavigation: 2,
    };
    detailSettings = {};
    navigationCount = 0;
    requests = [];
    const source = await createPetGearSource(new AbortController().signal);
    try {
      const result = await source.findCandidates(
        [target, { ...target, key: "second" }, { ...target, key: "third" }],
        new AbortController().signal,
      );
      assert.deepEqual(
        result.items.map((item) => item.searchStatus),
        ["completed", "read_failed", "pending"],
      );
      assert.equal(result.items[0].candidates.filter((candidate) => candidate.verified).length, 3);
      assert.equal(result.items[1].candidates.length, 0);
      assert.equal(result.items[2].scopeEvidence.length, 0);
      assert.match(result.items[1].note, /登录/);
      assert.equal(requests.length, 2);
    } finally {
      await source.close();
    }
  });
  await check("拒绝普通人物装备作为宝宝装备报价", async () => {
    const result = await run(target, {}, { kindId: 1 });
    assert.equal(result.items[0].candidates.length, 0);
    assert.equal(result.items[0].searchStatus, "read_failed");
  });
  await check("下架保留为拒绝证据，不形成价格", async () => {
    const result = await run(target, {}, { status: "已下架", selling: 0 });
    assert.equal(result.items[0].candidates.filter((candidate) => candidate.verified).length, 0);
    assert.equal(petGearReference(result.items[0].candidates).referencePrice, null);
    assert.ok(result.items[0].candidates.every((candidate) => candidate.reason.includes("下架")));
  });
  console.log("SIMULATED total: " + passed + " passed");
} finally {
  await context?.close();
  delete globalThis.petGearRegressionContext;
  await rm(profile, { recursive: true, force: true });
}
