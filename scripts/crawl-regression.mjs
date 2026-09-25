import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { chromium } from "playwright-core";
import {
  detailDocument,
  listDocument,
  listHtml,
  petBody,
  primaryPetSkill,
  tabContent,
} from "../tests/fixtures/crawl-site.mjs";
async function moduleUrl(file, replacements = {}) {
  let source = ts.transpileModule(await readFile(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const [name, url] of Object.entries(replacements))
    source = source.replaceAll(`from "${name}"`, `from "${url}"`);
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}
const listingUrl = await moduleUrl("server/crawler/listing.ts");
const viewportUrl = await moduleUrl("server/viewport.ts");
const compactUrl = await moduleUrl("server/crawler/compact.ts");
const typesUrl = await moduleUrl("server/crawler/types.ts");
const pageUrl = await moduleUrl("server/crawler/page.ts", {
  "./listing": listingUrl,
  "./types": typesUrl,
  "../viewport": viewportUrl,
});
const petsUrl = await moduleUrl("server/crawler/pets.ts", { "../viewport": viewportUrl });
const { collectPets } = await import(petsUrl);
const { collectDetail, MAIN_TABS } = await import(
  await moduleUrl("server/crawler/detail.ts", {
    "./page": pageUrl,
    "../viewport": viewportUrl,
    "./compact": compactUrl,
    "./pets": petsUrl,
  })
);
const { prepareList, gotoPage, hoverListing, readListings } = await import(pageUrl);
const { CrawlStore } = await import(
  await moduleUrl("server/crawler/store.ts", { "./compact": compactUrl })
);
const { crawl } = await import(
  await moduleUrl("server/crawler/runner.ts", {
    "./resume": await moduleUrl("server/crawler/resume.ts"),
    "./types": typesUrl,
  })
);
const { createHiddenPage } = await import(
  await moduleUrl("server/session.ts", {
    "./chrome": await moduleUrl("server/chrome.ts"),
    "./work-transport": await moduleUrl("server/work-transport.ts"),
    "./diagnostics": await moduleUrl("server/diagnostics.ts"),
    "./viewport": await moduleUrl("server/viewport.ts"),
    "./config": await moduleUrl("server/config.ts"),
    "playwright-core": import.meta.resolve("playwright-core"),
  })
);
const directory = await mkdtemp(path.join(os.tmpdir(), "cbg-crawl-regression-"));
let persistent, browser, store;
try {
  persistent = await chromium.launchPersistentContext(directory, {
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--remote-debugging-port=0"],
  });
  const [port, endpoint] = (await readFile(path.join(directory, "DevToolsActivePort"), "utf8"))
    .trim()
    .split("\n");
  browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${endpoint}`, {
    noDefaults: true,
  });
  const context = browser.contexts()[0];
  let detailRequests = 0;
  // 仅本地路由数据；不访问真实藏宝阁，不读取日常浏览器配置。
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://xyq.cbg.163.com") {
      await route.abort();
      return;
    }
    let body = listDocument;
    if (url.pathname === "/equip") {
      detailRequests++;
      body = detailDocument(url.searchParams.get("eid") === "missing", MAIN_TABS);
    } else if (url.pathname === "/mock-list") {
      await new Promise((resolve) => setTimeout(resolve, 250));
      body = listHtml(Number(url.searchParams.get("page")));
    } else if (url.pathname === "/mock-pet") {
      await new Promise((resolve) => setTimeout(resolve, 100));
      body = petBody(Number(url.searchParams.get("n")));
    } else if (url.pathname === "/mock-tab") {
      await new Promise((resolve) => setTimeout(resolve, 250));
      body = tabContent[url.searchParams.get("name")];
    }
    await route.fulfill({ contentType: "text/html; charset=utf-8", body });
  });
  const listPage = await createHiddenPage(browser),
    detailPage = await createHiddenPage(browser);
  // 重现旧工作页保留了错误视口的情况，prepareList 应自动修复。
  await listPage.setViewportSize({ width: 1, height: 1 });
  await listPage.goto("https://xyq.cbg.163.com/list");
  const control = new AbortController();
  const first = await prepareList(listPage, control.signal);
  assert.deepEqual(listPage.viewportSize(), { width: 1440, height: 1080 });
  assert.equal(first.items[0].summary.iExptSki1, 20);
  assert.equal(first.items[0].sellingTime, "2026-09-07T04:00:00.000Z");
  assert.ok(first.items[0].orderTime);
  store = new CrawlStore(path.join(directory, "test.sqlite"));
  const second = await gotoPage(listPage, 2, control.signal);
  for (const item of second.items) {
    store.observe(item);
    store.save(
      item,
      {
        captureVersion: 3,
        url: item.url,
        collectedAt: new Date().toISOString(),
        tabs: [],
        raw: {},
      },
      {
        key: item.key,
        time: item.orderTime,
        order: second.order,
        page: 2,
        savedAt: new Date().toISOString(),
      },
    );
  }
  const states = [];
  const progress = [];
  const source = {
    prepare: () => prepareList(listPage, control.signal),
    page: (number) => gotoPage(listPage, number, control.signal),
    onShelf: async () => true,
    hover: (item) => hoverListing(listPage, item, control.signal),
    detail: (item) =>
      collectDetail(detailPage, item, control.signal, (message) => progress.push(message)),
  };
  await crawl(source, store, control.signal, (state) => states.push(state));
  assert.equal(detailRequests, 1);
  assert.equal(store.count(), 3);
  const saved = store.detail("367:a");
  assert.ok(MAIN_TABS.every((name) => saved.detail.tabs.some((tab) => tab.name === name)));
  assert.ok(saved.detail.tabs.some((tab) => tab.text.includes("法术抗性：999")));
  const petTab = saved.detail.tabs.find((t) => t.name === "召唤兽/孩子");
  assert.equal(petTab.petCount, 8);
  assert.equal(petTab.pets.length, 8);
  for (let n = 0; n < 8; n++) {
    assert.equal(petTab.pets[n].name, "测试宝宝" + (n + 1));
    assert.equal(petTab.pets[n].fields.find((f) => f.name === "攻击资质").value, String(1400 + n));
    assert.deepEqual(
      petTab.pets[n].skills.map((s) => s.name),
      [primaryPetSkill, "技能" + (n + 1)],
    );
    assert.ok(petTab.pets[n].equipment[0].description.includes("速度：" + (20 + n)));
    assert.equal(petTab.pets[n].innerSkills[0].level, "5");
  }
  assert.equal(await detailPage.evaluate(() => window.gearHovers), 0);
  assert.ok(!JSON.stringify(saved).includes("通用功效"));
  assert.deepEqual(saved.detail.raw, {});
  assert.ok(!JSON.stringify(saved).includes("private-login-should-not-be-collected"));
  assert.ok(
    saved.detail.tabs.some((tab) =>
      tab.items.some((item) => item.description?.includes("罗汉金钟")),
    ),
  );
  const gearItems = saved.detail.tabs.find((tab) => tab.name === "道具/法宝").items;
  assert.equal(gearItems.length, 2);
  assert.equal(gearItems[0].name, "测试刀");
  assert.ok(gearItems[0].description.includes("伤害：500"));
  assert.ok(gearItems[0].description.includes("罗汉金钟"));
  assert.equal(gearItems[1].name, "测试头盔");
  assert.ok(gearItems[1].description.includes("防御：90"));
  assert.ok(!JSON.stringify(saved.detail).includes("encoded-source"));
  assert.ok(
    store.db
      .prepare("SELECT length(source_gzip) AS n FROM role_sources WHERE listing_key=?")
      .get("367:a").n > 0,
  );
  assert.ok(states.some((state) => state.strategy?.includes("继续补齐后段历史商品")));
  assert.ok(states.some((state) => state.page === 2 && state.itemsOnPage === 2));
  assert.ok(states.some((state) => state.itemIndex === 2));
  assert.ok(MAIN_TABS.every((name) => progress.some((message) => message.endsWith(`：${name}`))));
  const hovered = await listPage.evaluate(() => window.hovered);
  assert.ok(["a", "b", "c"].every((id) => hovered.includes(id)));
  assert.ok(hovered.filter((id) => id === "b").length >= 2);
  assert.equal(saved.listing.attrs.mouse_over_begin, undefined);
  console.log(
    "PASS: actual hidden pages hover list metadata, visit seven tabs + subtabs + all eight pets, read gear core attributes without hover, follow pagination and commit SQLite",
  );
  await crawl(source, store, control.signal, () => {});
  assert.equal(detailRequests, 1);
  assert.equal(store.count(), 3);
  console.log("PASS: rerun reads durable checkpoint and skips all already completed details");
  await detailPage.setContent(
    '<div data-cbg-detail-root>召唤兽(8/10)<img data_idx="0" src="/images/pets/small/1.gif" width="50" height="50"></div>',
  );
  await assert.rejects(
    collectPets(
      detailPage,
      control.signal,
      async () => null,
      async () => {},
      async () => {},
      () => {},
    ),
    /标注 8 只，召唤兽区域识别到 1/,
  );
  const portrait = (index, extra = "") =>
    `<img data_idx="${index}" src="/images/pets/small/${index}.gif" width="50" height="50" ${extra}>`;
  const collectFixture = () =>
    collectPets(
      detailPage,
      control.signal,
      async () => ({
        name: "宝宝",
        text: "详细信息\n类型：测试宝宝\n等级：100\n技能",
        fields: [],
        tables: [],
        elements: [],
        tooltips: [],
        items: [],
      }),
      async () => {},
      async () => {},
      () => {},
    );
  await detailPage.setContent(
    `<div data-cbg-detail-root><section><h3>召唤兽(1/10)</h3>${portrait(0)}</section><section><h3>孩子</h3>${[0, 1, 2, 3].map((index) => portrait(index)).join("")}</section></div>`,
  );
  assert.equal(await detailPage.locator('img[data_idx][src*="/pets/"]').count(), 5);
  assert.equal((await collectFixture()).pets.length, 1);
  await detailPage.setContent(
    `<div data-cbg-detail-root><div><strong>召唤兽</strong><span>(1/8)</span><div>${portrait(0)}</div><b>孩子</b><div>${portrait(0)}</div><b>特殊宠物</b><table><tr><td>${portrait(0)}</td></tr></table></div></div>`,
  );
  assert.equal((await collectFixture()).pets.length, 1);
  await detailPage.setContent(
    `<div data-cbg-detail-root><h3>召唤兽(1/10)</h3>${portrait(0)}${portrait(1, 'style="visibility:hidden"')}${portrait(2, 'style="opacity:0"')}<div role="tooltip">${portrait(3)}</div><img data_idx="4" src="/images/pets/big/0.gif" width="50" height="50"></div>`,
  );
  assert.equal((await collectFixture()).pets.length, 1);
  await detailPage.setContent(
    `<div data-cbg-detail-root><section><h3>召唤兽(0/10)</h3>无</section><section><h3>孩子</h3>${portrait(0)}</section></div>`,
  );
  assert.equal((await collectFixture()).pets.length, 0);
  // Shared wrapper and bare text headings: one pet, one child and the pet preview
  // used to be counted as three pet entries (two DIVs and a TD).
  await detailPage.setContent(
    `<div data-cbg-detail-root><div>召唤兽(1/8)<div>${portrait(0)}</div>孩子<div>${portrait(1)}</div>特殊宠物<div>无</div><table><tr><td>${portrait(0)}</td></tr></table></div></div>`,
  );
  assert.equal((await collectFixture()).pets.length, 1);
  await detailPage.setContent(
    `<div data-cbg-detail-root><div>召唤兽(0/8)无<br>孩子<div>${portrait(0)}</div>特殊宠物<div>无</div></div></div>`,
  );
  assert.equal((await collectFixture()).pets.length, 0);
  await detailPage.setContent(
    `<div data-cbg-detail-root><div>召唤兽(8/8)${Array.from({ length: 8 }, (_, i) => `<div>${portrait(i)}</div>`).join("")}孩子<div>${portrait(0)}</div>特殊宠物<table><tr><td>${portrait(0)}</td></tr></table></div></div>`,
  );
  assert.equal((await collectFixture()).pets.length, 8);
  await detailPage.setContent(
    `<div data-cbg-detail-root><div>召唤兽(1/8)${portrait(0)}${portrait(1)}孩子<div>无</div></div></div>`,
  );
  await assert.rejects(collectFixture(), /标注 1 只，召唤兽区域识别到 2/);
  console.log(
    "PASS: section boundaries exclude child and preview icons in a shared wrapper; zero and eight pets remain accurate; true mismatches remain incomplete",
  );
  await detailPage.setContent(
    `<div data-cbg-detail-root><h3>召唤兽(1/10)</h3>${portrait(0)}${portrait(1)}</div>`,
  );
  await assert.rejects(collectFixture(), /标注 1 只，召唤兽区域识别到 2/);
  console.log(
    "PASS: one pet plus four unrelated icons counts as one; hidden/transparent/tooltip/preview images excluded; genuinely ambiguous counts still stop",
  );
  await assert.rejects(
    collectDetail(
      detailPage,
      { ...first.items[0], url: "https://xyq.cbg.163.com/equip?s=367&eid=missing" },
      control.signal,
    ),
    /玩家之家/,
  );
  await listPage.evaluate(() => {
    window.CaptchaCheck = { need_captcha: true };
  });
  await assert.rejects(readListings(listPage), /安全验证/);
  console.log(
    "PASS: missing detail tabs and site verification stop collection instead of marking partial data complete",
  );
  await detailPage.close();
  await listPage.close();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  store?.close();
  await browser?.close();
  await persistent?.close();
  await rm(directory, { recursive: true, force: true });
}
