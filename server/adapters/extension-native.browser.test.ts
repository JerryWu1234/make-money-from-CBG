import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { chromium, type Browser, type Page } from "playwright-core";
import { itemFromAttributes } from "../crawler/compact";
import { MAIN_TABS } from "../crawler/detail-tabs";
import { nativePlans } from "./native-market-source";
import type { EquipmentPricingItem } from "../analysis/equipment-pricing";
import type { PageSnapshot } from "./contracts";
import { readFileSync } from "node:fs";
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
afterAll(async () => {
  await browser?.close();
});
const script = (name: string) =>
  readFileSync(new URL(`../../extension/cbg-access/${name}`, import.meta.url), "utf8");
async function fixture(body: string, query = "act=show_overall_search_equip") {
  const page = await browser.newPage();
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><body>${body}</body></html>`,
    }),
  );
  await page.goto(`https://xyq.cbg.163.com/cgi-bin/equipquery.py?${query}`);
  await page.evaluate(() => {
    const g = window as unknown as Record<string, any>;
    g.__snapshots = [];
    g.__listeners = [];
    g.chrome = {
      runtime: {
        id: "test-extension",
        sendMessage: async (message: unknown) => {
          g.__snapshots.push(message);
        },
        onMessage: { addListener: (listener: unknown) => g.__listeners.push(listener) },
      },
    };
  });
  await page.addScriptTag({ content: script("market-config.js") });
  await page.addScriptTag({ content: script("market-rules.js") });
  await page.addScriptTag({ content: script("pet-product-observation.js") });
  await page.addScriptTag({ content: script("isolated.js") });
  await page.evaluate(async () => {
    const g = window as unknown as Record<string, any>;
    g.__bound = await new Promise((resolve) =>
      g.__listeners[0]({ kind: "bind" }, { id: "test-extension" }, resolve),
    );
  });
  await page.bringToFront();
  return page;
}
async function prepare(
  page: Page,
  target: Record<string, unknown>,
  actionId = "action",
  queryId = "query",
) {
  return page.evaluate(
    async ({ target, actionId, queryId }) => {
      const g = window as unknown as Record<string, any>;
      const bound = g.__bound;
      const plan = {
        runId: "run",
        queryId,
        actionId,
        ...bound,
        browserSessionEpoch: "epoch",
        stopEpoch: 0,
        target,
        expected: { kind: "changed" },
      };
      return new Promise<any>((resolve) =>
        g.__listeners[0]({ kind: "prepare", plan }, { id: "test-extension" }, resolve),
      );
    },
    { target, actionId, queryId },
  );
}
describe("isolated extension observation and semantic targeting", () => {
  it("resolves actual public market controls while rejecting a different sensitive control", async () => {
    const page = await fixture(
      '<input id="txt_damage" aria-label="伤害" value="100"><input id="password" type="password"><button id="btn_equip_search">搜索</button>',
    );
    try {
      expect(
        (await prepare(page, { kind: "market-field", field: "txt_damage", value: "130" })).ok,
      ).toBe(true);
      expect(
        (await prepare(page, { kind: "market-field", field: "password", value: "123" })).ok,
      ).toBe(false);
      expect(
        (await prepare(page, { kind: "market-field", field: "txt_damage", value: "1\n2" })).ok,
      ).toBe(false);
      await page.evaluate(() => {
        const input = document.getElementById("txt_damage")!;
        input.style.position = "absolute";
        input.style.left = "-500px";
      });
      expect(
        (await prepare(page, { kind: "market-field", field: "txt_damage", value: "130" })).ok,
      ).toBe(false);
    } finally {
      await page.close();
    }
  });
  it("does not trust MAIN-supplied coordinates, and rejects an incorrect product identity", async () => {
    const page = await fixture(
      '<div id="soldList"><a class="soldImg" href="/equip?s=299&eid=actual">商品</a></div>',
      "act=role-search",
    );
    try {
      await page.evaluate(() =>
        window.postMessage(
          {
            channel: "cbg-passive-v1",
            observerToken: (window as unknown as Record<string, any>).__bound.observerToken,
            value: {
              kind: "render",
              globals: {
                QueryArgs: { page: 1, server_type: "1,2,3" },
                fakeRect: { x: 0, y: 0, width: 900, height: 900 },
              },
            },
          },
          location.origin,
        ),
      );
      expect(
        (await prepare(page, { kind: "listing-detail", serverId: "299", eid: "wrong" })).ok,
      ).toBe(false);
      const result = await prepare(page, {
        kind: "listing-detail",
        serverId: "299",
        eid: "actual",
      });
      expect(result.ok).toBe(true);
      expect(result.proof.rect.width).toBeLessThan(900);
      const markup = await page.locator("#soldList").evaluate((node) => node.outerHTML);
      expect(markup).not.toContain("data-cbg-");
    } finally {
      await page.close();
    }
  });
  it("extracts actual public suit/name/jewelry directories through MAIN and builds native plans", async () => {
    const page = await fixture(
      '<select id="sel_short_cut"><option value="0">不限</option><option value="1">附加状态巨力金刚</option></select><select id="sel_suit_effect"><option value="2">钟灵石套装</option></select><select id="sel_basic_attr_type"><option value="defense">戒指·防御</option></select><select id="sel_add_attr1"><option value="3">速度</option></select>',
    );
    try {
      await page.evaluate(() => {
        const g = window as unknown as Record<string, any>;
        g.EquipKinds = [[20, "腰带"]];
        g.SpecialEffects = [];
        g.SpecialSkills = [];
        g.Gems = [];
        g.SuitAddedStatus = { 巨力金刚: 1 };
        g.SuitAppendSkills = { 神针撼海: 2 };
        g.SuitTransformSkills = { 满天花雨: 3 };
        g.SuitTransformCharms = { 如意仙子: 4 };
        g.AUTO_SEARCH_CONFIG = { wjd_equip_equip_type: { "70_20": [{ label: "百窜云" }] } };
      });
      await page.addScriptTag({ content: script("main.js") });
      await expect
        .poll(async () =>
          page.evaluate(
            () =>
              (window as unknown as { __snapshots: any[] }).__snapshots.at(-1)?.payload.market
                ?.config?.suits?.length,
          ),
        )
        .toBe(1);
      const market = (await page.evaluate(
        () => (window as unknown as { __snapshots: any[] }).__snapshots.at(-1).payload.market,
      )) as NonNullable<PageSnapshot["market"]>;
      expect(market.config?.suitTypes).toEqual({
        added_status: [[1, "巨力金刚"]],
        append_skill: [[2, "神针撼海"]],
        transform_skill: [[3, "满天花雨"]],
        transform_charm: [[4, "如意仙子"]],
      });
      expect(market.config?.jewelryPrimaryAttrs).toEqual([["defense", "戒指·防御"]]);
      expect(market.config?.jewelryAddedAttrs).toEqual([["3", "速度"]]);
      const item: EquipmentPricingItem = {
        key: "synthetic-belt",
        name: "百窜云",
        category: "人物装备 · 腰带",
        level: 70,
        description: "等级70\n防御30 气血300\n耐久度300\n套装效果：附加状态巨力金刚",
        status: "no_match",
        query: "",
        referencePrice: null,
        candidates: [],
        issues: [],
      };
      const plans = await nativePlans("equipment", item, "299", market);
      expect(plans).toHaveLength(1);
      expect(plans[0].args.kindid).toBe("20");
      expect(plans[0].args.suit_effect).toBeDefined();
      expect(plans[0].actions.some((target) => target.kind === "market-reset-server")).toBe(true);
      expect(market.form?.controls.some((control) => control.id === "sel_short_cut")).toBe(true);
    } finally {
      await page.close();
    }
  });
  it("cross-checks stored MooTools menu values against actual DOM nodes and locates offscreen targets without scrolling the page", async () => {
    const page = await fixture(
      '<div id="special_effect_panel"><li>愤怒</li></div><div style="height:1800px"></div><input id="txt_damage" aria-label="伤害">',
    );
    try {
      await page.evaluate(() => {
        const node = document.querySelector("#special_effect_panel li") as HTMLElement & {
          retrieve: (key: string) => unknown;
        };
        node.retrieve = (key) => (key === "value" ? 3 : undefined);
      });
      await page.addScriptTag({ content: script("main.js") });
      await expect
        .poll(async () =>
          page.evaluate(
            () =>
              (window as unknown as { __snapshots: any[] }).__snapshots
                .at(-1)
                ?.payload.market?.menus?.find((menu: any) => menu.id === "special_effect_panel")
                ?.choices[0]?.value,
          ),
        )
        .toBe("3");
      expect(
        (
          await prepare(page, {
            kind: "market-choice",
            panel: "special_effect_panel",
            values: ["3"],
          })
        ).ok,
      ).toBe(true);
      const location = await page.evaluate(async () => {
        const g = window as unknown as Record<string, any>;
        const bound = await new Promise<any>((resolve) =>
          g.__listeners[0]({ kind: "bind" }, { id: "test-extension" }, resolve),
        );
        return new Promise<any>((resolve) =>
          g.__listeners[0](
            {
              kind: "locate",
              plan: { ...bound, target: { kind: "market-field", field: "txt_damage", value: "1" } },
            },
            { id: "test-extension" },
            resolve,
          ),
        );
      });
      expect(location.ok).toBe(true);
      expect(location.location.needsScroll).toBe(true);
      expect(location.location.deltaY).toBeGreaterThan(0);
      expect(await page.evaluate(() => scrollY)).toBe(0);
      const denied = await prepare(page, {
        kind: "scroll",
        deltaY: 999999,
        toward: { kind: "market-field", field: "txt_damage", value: "1" },
      });
      expect(denied.ok).toBe(false);
    } finally {
      await page.close();
    }
  });
  it("requires positive server authentication plus a real logout control, and keeps missing login evidence unknown", async () => {
    const page = await fixture('<a href="/cgi-bin/login.py?act=logout">退出</a>');
    try {
      await page.addScriptTag({ content: script("main.js") });
      await page.waitForTimeout(50);
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { __snapshots: any[] }).__snapshots.at(-1)?.payload.authenticated,
        ),
      ).toBeUndefined();
      await page.evaluate(() => {
        (window as unknown as { IsLogin: number }).IsLogin = 1;
      });
      await expect
        .poll(async () =>
          page.evaluate(
            () =>
              (window as unknown as { __snapshots: any[] }).__snapshots.at(-1)?.payload
                .authenticated,
          ),
        )
        .toBe(true);
      await page.evaluate(() => {
        (window as unknown as { LoginInfo: { login: number } }).LoginInfo = { login: 0 };
      });
      await expect
        .poll(async () =>
          page.evaluate(
            () =>
              (window as unknown as { __snapshots: any[] }).__snapshots.at(-1)?.payload
                .authenticated,
          ),
        )
        .toBe(false);
    } finally {
      await page.close();
    }
  });
  it.each([{}, { cross_buy_serverid: 33 }])(
    "reads and clears actual hidden cross-server fields independently of old submitted conditions %j",
    async (conditions) => {
      const page = await fixture(
        `<input type="hidden" id="user_serverid" value="33"><button id="btn_reset_user_server" onclick="document.getElementById('user_serverid').value='0'">清除跨服</button>`,
        "act=show_overall_search_pet",
      );
      try {
        await page.evaluate((conditions) => {
          (window as unknown as Record<string, any>).CurSearchValue = { arg: conditions };
        }, conditions);
        await page.addScriptTag({ content: script("main.js") });
        await expect
          .poll(async () =>
            page.evaluate(
              () =>
                (window as unknown as { __snapshots: any[] }).__snapshots.at(-1)?.payload.formValues
                  .user_serverid,
            ),
          )
          .toBe("33");
        const form = await page.evaluate(
          () =>
            (window as unknown as { __snapshots: any[] }).__snapshots.at(-1).payload.market.form,
        );
        expect(form.hiddenControls).toContainEqual({ id: "user_serverid", name: "", value: "33" });
        expect((await prepare(page, { kind: "market-reset-server" })).ok).toBe(true);
        await page.locator("#btn_reset_user_server").click();
        await expect
          .poll(async () =>
            page.evaluate(
              () =>
                (window as unknown as { __snapshots: any[] }).__snapshots.at(-1)?.payload.formValues
                  .user_serverid,
            ),
          )
          .toBe("0");
        expect(
          await page.evaluate(
            () =>
              (window as unknown as { __snapshots: any[] }).__snapshots.at(-1).payload.market
                .conditions,
          ),
        ).toEqual(conditions);
      } finally {
        await page.close();
      }
    },
  );
  it("expands a clipped official skill panel before target preparation and observes high/low stored inner-skill values", async () => {
    const page = await fixture(
      `<div id="pet_skill_wrap" style="height:20px;overflow:hidden"><ul style="margin:0"><li style="height:30px" data-skill_id="1">技能甲</li><li style="height:30px" data-skill_id="2">技能乙</li></ul></div><button id="btn_all_skill" onclick="document.getElementById('pet_skill_wrap').style.height='auto'">展开全部技能</button><ul id="high_neidan_panel"><li>催心浪</li></ul><ul id="low_neidan_panel"><li>迅敏</li></ul>`,
      "act=show_overall_search_pet",
    );
    try {
      await page.evaluate(() => {
        (document.querySelector("#high_neidan_panel li") as any).retrieve = () => 9;
        (document.querySelector("#low_neidan_panel li") as any).retrieve = () => 10;
      });
      await page.addScriptTag({ content: script("main.js") });
      await expect
        .poll(async () =>
          page.evaluate(
            () =>
              (window as unknown as { __snapshots: any[] }).__snapshots
                .at(-1)
                ?.payload.market?.menus.find((menu: any) => menu.id === "high_neidan_panel")
                ?.choices[0]?.value,
          ),
        )
        .toBe("9");
      expect(
        (await prepare(page, { kind: "market-choice", panel: "pet_skill_wrap", values: ["2"] })).ok,
      ).toBe(false);
      expect((await prepare(page, { kind: "market-expand", panel: "pet-skills" })).ok).toBe(true);
      await page.locator("#btn_all_skill").click();
      await expect
        .poll(async () =>
          page.evaluate(
            () =>
              (window as unknown as { __snapshots: any[] }).__snapshots.at(-1)?.payload.market
                .expanded["pet-skills"],
          ),
        )
        .toBe(true);
      expect(
        (await prepare(page, { kind: "market-choice", panel: "pet_skill_wrap", values: ["2"] })).ok,
      ).toBe(true);
      expect(
        (await prepare(page, { kind: "market-choice", panel: "high_neidan_panel", values: ["9"] }))
          .ok,
      ).toBe(true);
      expect(
        (await prepare(page, { kind: "market-choice", panel: "low_neidan_panel", values: ["10"] }))
          .ok,
      ).toBe(true);
    } finally {
      await page.close();
    }
  });
  it("preserves pet permanent, evolution-preview and blessing skill sections in plain attributes", async () => {
    const nav = MAIN_TABS.map(
      (name) => `<a class="${name === "召唤兽/孩子" ? "active" : ""}">${name}</a>`,
    ).join("");
    const page = await fixture(
      `<section><nav>${nav}</nav><p>${"公开角色详情说明".repeat(30)}</p><div>召唤兽（1/20）</div><div>详细信息</div><div>技能</div><img width="24" height="24" data_skill_type="cifu" data_equip_name="高级法术暴击"><img width="24" height="24" data_skill_type="cifu" data_equip_name="超级法术暴击（进化后获得）"><div>赐福技能</div><img width="24" height="24" data_skill_type="cifu" data_equip_name="须弥真言"><div>内丹</div></section>`,
      "act=role-search",
    );
    try {
      await prepare(page, { kind: "detail-tab", name: "召唤兽/孩子" });
      const elements = (await page.evaluate(
        () =>
          (window as unknown as { __snapshots: any[] }).__snapshots.at(-1)?.payload.petProof
            ?.elements,
      )) as Record<string, string>[];
      expect(elements).toHaveLength(3);
      expect(
        elements.map((attrs, index) => itemFromAttributes(attrs, index).skillObservation?.state),
      ).toEqual(["current", "future", "conditional"]);
      expect(await page.locator("section").evaluate((node) => node.outerHTML)).not.toContain(
        "data-cbg-",
      );
    } finally {
      await page.close();
    }
  });
  it("preserves JSONP callbacks and records endpoint summaries without calling the website itself", async () => {
    const page = await fixture('<div id="soldList"></div>');
    try {
      await page.evaluate(() => {
        const g = window as unknown as Record<string, any>;
        g.ajax_with_recommend = function (options: { onSuccess: (value: unknown) => unknown }) {
          return options.onSuccess.call(this, { status: 0, msg: [] });
        };
      });
      await page.addScriptTag({ content: script("main.js") });
      const value = await page.evaluate(() => {
        const g = window as unknown as Record<string, any>;
        let calls = 0;
        const result = g.ajax_with_recommend({
          data: { page: 1 },
          onSuccess() {
            calls++;
            return 7;
          },
        });
        return { calls, result };
      });
      expect(value).toEqual({ calls: 1, result: 7 });
      await expect
        .poll(async () =>
          page.evaluate(() =>
            (
              window as unknown as { __snapshots: { payload: { business: unknown[] } }[] }
            ).__snapshots.some((value) =>
              value.payload.business.some(
                (event: any) =>
                  event.kind === "jsonp" && event.success === true && event.count === 0,
              ),
            ),
          ),
        )
        .toBe(true);
    } finally {
      await page.close();
    }
  });
});

async function marketRequestFixture() {
  const page = await fixture(
    `<button id="btn_equip_search">搜索</button>
     <div id="order_menu"><a href="#" data_attr_name="price">价格</a></div>
     <div id="pager_bar">第 1 页 共 2 页 <a href="#" data-page="1">1</a> <a href="#" data-page="2">2</a></div>
     <div id="search_result"><a class="soldImg" href="/equip?s=299&eid=stale">旧商品</a></div>
     <div id="unrelated"></div><div style="height:1800px"></div>`,
  );
  await page.evaluate(() => {
    const g = window as unknown as Record<string, any>;
    g.__marketRequests = [];
    g.__marketArgs = {
      act: "overall_search_equip",
      page: 1,
      order_by: "price ASC",
      kindid: "20",
    };
    g.CurSearchValue = { arg: { ...g.__marketArgs } };
    g.ajax_with_recommend = (options: any) => {
      g.__marketRequests.push(options);
      if (g.__immediateMarketResponse) return options.onSuccess(g.__immediateMarketResponse);
      return g.__marketRequests.length - 1;
    };
    g.__requestMarket = () =>
      g.ajax_with_recommend({
        data: { ...g.__marketArgs },
        onSuccess(value: unknown) {
          g.__siteCallbackValue = value;
          g.__synchronousMarketRender?.();
        },
      });
    document.getElementById("btn_equip_search")!.onclick = () => g.__requestMarket();
    document.querySelector<HTMLAnchorElement>("#order_menu a")!.onclick = (event) => {
      event.preventDefault();
      g.__requestMarket();
    };
    for (const node of document.querySelectorAll<HTMLAnchorElement>("#pager_bar a"))
      node.onclick = (event) => {
        event.preventDefault();
        g.__marketArgs.page = Number(node.dataset.page);
        g.__requestMarket();
      };
  });
  await page.addScriptTag({ content: script("main.js") });
  await expect.poll(async () => (await marketSnapshot(page)).market?.conditions.kindid).toBe("20");
  return page;
}
async function marketSnapshot(page: Page) {
  return page.evaluate(async () => {
    const g = window as unknown as Record<string, any>;
    await new Promise((resolve) =>
      g.__listeners[0]({ kind: "capture" }, { id: "test-extension" }, resolve),
    );
    return g.__snapshots.at(-1).payload;
  });
}
async function resolveMarketRequest(
  page: Page,
  index: number,
  value: { status: number; msg: unknown[] | string },
  fillServer = true,
) {
  const before = (await marketSnapshot(page)).business.filter(
    (event: any) => event.kind === "jsonp" && event.phase !== "request",
  ).length;
  await page.evaluate(
    ({ index, value }) => {
      const g = window as unknown as Record<string, any>;
      g.__marketRequests[index].onSuccess(value);
    },
    {
      index,
      value: {
        ...value,
        msg: Array.isArray(value.msg)
          ? value.msg.map((row) =>
              fillServer && row && typeof row === "object" ? { serverid: 299, ...row } : row,
            )
          : value.msg,
      },
    },
  );
  await expect
    .poll(
      async () =>
        (await marketSnapshot(page)).business.filter(
          (event: any) => event.kind === "jsonp" && event.phase !== "request",
        ).length,
    )
    .toBeGreaterThan(before);
}
async function renderMarketRows(page: Page, eid: string | null, currentPage = 1) {
  await page.evaluate(
    ({ eid, currentPage }) => {
      const g = window as unknown as Record<string, any>;
      g.__marketArgs.page = currentPage;
      g.CurSearchValue = { arg: { ...g.__marketArgs } };
      document.querySelector("#pager_bar")!.firstChild!.textContent =
        `第 ${currentPage} 页 共 2 页 `;
      document.querySelector("#search_result")!.innerHTML = eid
        ? `<a class="soldImg" href="/equip?s=299&eid=${eid}">商品 ${eid}</a>`
        : "没有符合条件的商品";
    },
    { eid, currentPage },
  );
  await expect.poll(async () => (await marketSnapshot(page)).market.page).toBe(currentPage);
}
async function mutateUnrelatedMarketContent(page: Page) {
  await page.evaluate(() => {
    document.getElementById("unrelated")!.textContent += "其他页面内容更新";
    window.scrollTo(0, 120);
  });
}
async function expectMarketCommit(page: Page, actionId: string, queryId = "query") {
  await expect.poll(async () => (await marketSnapshot(page)).market.committed).toBe(true);
  const snapshot = await marketSnapshot(page);
  const response = snapshot.business.find(
    (event: any) =>
      event.eventId === snapshot.market.commit?.eventId &&
      event.requestId === snapshot.market.commit?.requestId,
  );
  expect(response).toBeDefined();
  expect(snapshot.market.commit).toMatchObject({
    actionId,
    queryId,
    requestId: response.requestId,
    eventId: response.eventId,
    startedAt: response.startedAt,
    completedAt: response.observedAt,
  });
}
async function seedSuccessfulMarketRequest(page: Page) {
  expect(
    (
      await prepare(
        page,
        { kind: "market-submit", category: "equipment" },
        "previous-submit",
        "previous-query",
      )
    ).ok,
  ).toBe(true);
  await page.locator("#btn_equip_search").click();
  await resolveMarketRequest(page, 0, { status: 0, msg: [{ eid: "previous" }] });
  await renderMarketRows(page, "previous");
  await expectMarketCommit(page, "previous-submit", "previous-query");
}

describe("market submissions require fresh MAIN callback and corresponding result DOM", () => {
  it("accepts a fresh callback that synchronously renders its own result DOM", async () => {
    const page = await marketRequestFixture();
    try {
      expect(
        (await prepare(page, { kind: "market-submit", category: "equipment" }, "sync-submit")).ok,
      ).toBe(true);
      await page.evaluate(() => {
        const g = window as unknown as Record<string, any>;
        g.__immediateMarketResponse = { status: 0, msg: [{ serverid: 299, eid: "synchronous" }] };
        g.__synchronousMarketRender = () => {
          document.querySelector("#search_result")!.innerHTML =
            '<a class="soldImg" href="/equip?s=299&eid=synchronous">同步新商品</a>';
        };
      });
      await page.locator("#btn_equip_search").click();
      await expectMarketCommit(page, "sync-submit");
      expect((await marketSnapshot(page)).market.rows[0].url).toContain("eid=synchronous");
    } finally {
      await page.close();
    }
  });
  it("accepts a new successful response whose exact identities are already rendered", async () => {
    const page = await marketRequestFixture();
    try {
      await seedSuccessfulMarketRequest(page);
      expect(
        (await prepare(page, { kind: "market-submit", category: "equipment" }, "same-rows-submit"))
          .ok,
      ).toBe(true);
      await page.locator("#btn_equip_search").click();
      await resolveMarketRequest(page, 1, { status: 0, msg: [{ eid: "previous" }] });
      await expectMarketCommit(page, "same-rows-submit");
      expect((await marketSnapshot(page)).market.rows[0].url).toContain("eid=previous");
    } finally {
      await page.close();
    }
  });
  it("accepts result DOM rendered in the website callback's microtask", async () => {
    const page = await marketRequestFixture();
    try {
      expect(
        (await prepare(page, { kind: "market-submit", category: "equipment" }, "microtask-submit"))
          .ok,
      ).toBe(true);
      await page.evaluate(() => {
        const g = window as unknown as Record<string, any>;
        g.__immediateMarketResponse = { status: 0, msg: [{ serverid: 299, eid: "microtask" }] };
        g.__synchronousMarketRender = () => {
          queueMicrotask(() => {
            document.querySelector("#search_result")!.innerHTML =
              '<a class="soldImg" href="/equip?s=299&eid=microtask">微任务新商品</a>';
          });
        };
      });
      await page.locator("#btn_equip_search").click();
      await expectMarketCommit(page, "microtask-submit");
      expect((await marketSnapshot(page)).market.rows[0].url).toContain("eid=microtask");
    } finally {
      await page.close();
    }
  });
  it.each([
    { label: "missing", row: { eid: "current" } },
    { label: "wrong", row: { serverid: 300, eid: "current" } },
  ])("does not commit rows with a $label response server identity", async ({ row }) => {
    const page = await marketRequestFixture();
    try {
      expect(
        (await prepare(page, { kind: "market-submit", category: "equipment" }, "identity-submit"))
          .ok,
      ).toBe(true);
      await page.locator("#btn_equip_search").click();
      await resolveMarketRequest(page, 0, { status: 0, msg: [row] }, false);
      await renderMarketRows(page, "current");
      const snapshot = await marketSnapshot(page);
      expect(snapshot.business.at(-1).success).toBe(true);
      expect(snapshot.market.rows[0].url).toContain("s=299&eid=current");
      expect(snapshot.market.committed).toBe(false);
      expect(snapshot.market.commit).toBeUndefined();
    } finally {
      await page.close();
    }
  });
  it("matches response game_ordersn with the visible row's data_ordersn and server", async () => {
    const page = await marketRequestFixture();
    try {
      expect(
        (await prepare(page, { kind: "market-submit", category: "equipment" }, "ordersn-submit"))
          .ok,
      ).toBe(true);
      await page.locator("#btn_equip_search").click();
      await resolveMarketRequest(page, 0, {
        status: 0,
        msg: [{ serverid: 299, game_ordersn: "ordersn-current" }],
      });
      await renderMarketRows(page, "current");
      expect((await marketSnapshot(page)).market.committed).toBe(false);
      await page.evaluate(() => {
        document
          .querySelector("#search_result a.soldImg")!
          .setAttribute("data_ordersn", "ordersn-current");
      });
      await expectMarketCommit(page, "ordersn-submit");
    } finally {
      await page.close();
    }
  });
  it("does not assign a later background request to a target click that started no request", async () => {
    const page = await marketRequestFixture();
    try {
      expect(
        (await prepare(page, { kind: "market-submit", category: "equipment" }, "blocked-submit"))
          .ok,
      ).toBe(true);
      await page.evaluate(() => {
        const g = window as unknown as Record<string, any>;
        document.getElementById("btn_equip_search")!.onclick = () => {};
        g.__immediateMarketResponse = { status: 0, msg: [{ serverid: 299, eid: "background" }] };
        g.__synchronousMarketRender = () => {
          document.querySelector("#search_result")!.innerHTML =
            '<a class="soldImg" href="/equip?s=299&eid=background">后台查询商品</a>';
        };
      });
      await page.locator("#btn_equip_search").click();
      expect(
        await page.evaluate(
          () => (window as unknown as Record<string, any>).__marketRequests.length,
        ),
      ).toBe(0);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              (window as unknown as Record<string, any>).__requestMarket();
              resolve();
            }, 0);
          }),
      );
      await expect.poll(async () => (await marketSnapshot(page)).business.length).toBe(1);
      expect((await marketSnapshot(page)).market.rows[0].url).toContain("eid=background");
      expect((await marketSnapshot(page)).market.committed).toBe(false);
    } finally {
      await page.close();
    }
  });
  it("does not reuse a previous same-condition success after prepare, DOM mutation or scroll", async () => {
    const page = await marketRequestFixture();
    try {
      await seedSuccessfulMarketRequest(page);
      expect(
        (await prepare(page, { kind: "market-submit", category: "equipment" }, "current-submit"))
          .ok,
      ).toBe(true);
      expect((await marketSnapshot(page)).actionContext.actionId).toBe("current-submit");
      expect((await marketSnapshot(page)).market.committed).toBe(false);
      await mutateUnrelatedMarketContent(page);
      expect((await marketSnapshot(page)).market.committed).toBe(false);
      await page.locator("#btn_equip_search").click();
      expect((await marketSnapshot(page)).market.committed).toBe(false);
      await resolveMarketRequest(page, 1, { status: 0, msg: [{ eid: "current" }] });
      expect((await marketSnapshot(page)).market.committed).toBe(false);
      await mutateUnrelatedMarketContent(page);
      expect((await marketSnapshot(page)).market.committed).toBe(false);
      await page.evaluate(() => {
        document.querySelector("#search_result")!.classList.add("refresh-complete");
      });
      expect((await marketSnapshot(page)).market.committed).toBe(false);
      await page.evaluate(() => {
        document.querySelector("#pager_bar")!.append(" 分页状态更新");
      });
      expect((await marketSnapshot(page)).market.committed).toBe(false);
      await renderMarketRows(page, "current");
      await expectMarketCommit(page, "current-submit");
      expect((await marketSnapshot(page)).market.rows[0].url).toContain("eid=current");
    } finally {
      await page.close();
    }
  });
  it.each(["before", "after"])(
    "does not attribute an older in-flight callback whose DOM renders %s the current response",
    async (oldRenderOrder) => {
      const page = await marketRequestFixture();
      try {
        await seedSuccessfulMarketRequest(page);
        await page.locator("#btn_equip_search").click();
        expect(
          (await prepare(page, { kind: "market-submit", category: "equipment" }, "current-submit"))
            .ok,
        ).toBe(true);
        await page.locator("#btn_equip_search").click();
        await resolveMarketRequest(page, 1, { status: 0, msg: [{ eid: "late-old" }] });
        if (oldRenderOrder === "before") await renderMarketRows(page, "late-old");
        expect((await marketSnapshot(page)).market.committed).toBe(false);
        await resolveMarketRequest(page, 2, { status: 0, msg: [{ eid: "current" }] });
        expect((await marketSnapshot(page)).market.committed).toBe(false);
        if (oldRenderOrder === "after") {
          await renderMarketRows(page, "late-old");
          expect((await marketSnapshot(page)).market.committed).toBe(false);
        }
        await renderMarketRows(page, "current");
        await expectMarketCommit(page, "current-submit");
        expect((await marketSnapshot(page)).market.rows[0].url).toContain("eid=current");
      } finally {
        await page.close();
      }
    },
  );
  it.each(["unchanged", "replaced"])(
    "checks the completed current response after an old callback leaves DOM %s",
    async (domState) => {
      const page = await marketRequestFixture();
      try {
        await seedSuccessfulMarketRequest(page);
        await page.locator("#btn_equip_search").click();
        expect(
          (await prepare(page, { kind: "market-submit", category: "equipment" }, "current-submit"))
            .ok,
        ).toBe(true);
        await page.locator("#btn_equip_search").click();
        await resolveMarketRequest(page, 2, { status: 0, msg: [{ eid: "current" }] });
        await renderMarketRows(page, "current");
        await expectMarketCommit(page, "current-submit");
        const completed = (await marketSnapshot(page)).market.commit;
        await resolveMarketRequest(page, 1, { status: 0, msg: [{ eid: "late-old" }] });
        if (domState === "replaced") await renderMarketRows(page, "late-old");
        const snapshot = await marketSnapshot(page);
        if (domState === "unchanged") {
          await expectMarketCommit(page, "current-submit");
          expect(snapshot.market.commit).toEqual(completed);
          expect(snapshot.market.rows[0].url).toContain("eid=current");
        } else {
          expect(snapshot.market.committed).toBe(false);
          expect(snapshot.market.commit).toBeUndefined();
          expect(snapshot.market.rows[0].url).toContain("eid=late-old");
        }
      } finally {
        await page.close();
      }
    },
  );
  it.each([
    { target: { kind: "market-page", page: 1 }, selector: '#pager_bar a[data-page="1"]' },
    { target: { kind: "market-page", page: 2 }, selector: '#pager_bar a[data-page="2"]' },
    { target: { kind: "sort", value: "price ASC" }, selector: "#order_menu a" },
  ])("protects repeated page/sort operation $target", async ({ target, selector }) => {
    const page = await marketRequestFixture();
    const currentPage = target.kind === "market-page" ? target.page! : 1;
    try {
      await seedSuccessfulMarketRequest(page);
      expect((await prepare(page, target, "current-page-or-sort")).ok).toBe(true);
      await mutateUnrelatedMarketContent(page);
      expect((await marketSnapshot(page)).market.committed).toBe(false);
      await page.locator(selector).click();
      expect((await marketSnapshot(page)).market.committed).toBe(false);
      await resolveMarketRequest(page, 1, { status: 0, msg: [{ eid: "new-page-or-sort" }] });
      expect((await marketSnapshot(page)).market.committed).toBe(false);
      await renderMarketRows(page, "new-page-or-sort", currentPage);
      await expectMarketCommit(page, "current-page-or-sort");
      expect((await marketSnapshot(page)).market.page).toBe(currentPage);
    } finally {
      await page.close();
    }
  });
  it.each(["empty", "denial"])(
    "does not accept old rows for a fresh %s response",
    async (response) => {
      const page = await marketRequestFixture();
      try {
        await seedSuccessfulMarketRequest(page);
        expect(
          (await prepare(page, { kind: "market-submit", category: "equipment" }, "current-submit"))
            .ok,
        ).toBe(true);
        await page.locator("#btn_equip_search").click();
        await resolveMarketRequest(
          page,
          1,
          response === "empty" ? { status: 0, msg: [] } : { status: 1, msg: "查询被拒绝" },
        );
        await mutateUnrelatedMarketContent(page);
        expect((await marketSnapshot(page)).market.committed).toBe(false);
        expect((await marketSnapshot(page)).market.rows[0].url).toContain("eid=previous");
        if (response === "empty") {
          await page.evaluate(() => {
            const marker = document.createElement("p");
            marker.textContent = "没有符合条件的商品";
            document.querySelector("#search_result")!.append(marker);
          });
          expect((await marketSnapshot(page)).market.committed).toBe(false);
          await renderMarketRows(page, null);
          await expectMarketCommit(page, "current-submit");
          expect((await marketSnapshot(page)).market).toMatchObject({ empty: true, rows: [] });
        } else {
          await renderMarketRows(page, "denied-stale-render");
          expect((await marketSnapshot(page)).market.committed).toBe(false);
        }
      } finally {
        await page.close();
      }
    },
  );
});
