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
  await page.bringToFront();
  return page;
}
async function prepare(page: Page, target: Record<string, unknown>) {
  return page.evaluate(async (target) => {
    const g = window as unknown as Record<string, any>;
    const bound = await new Promise<any>((resolve) =>
      g.__listeners[0]({ kind: "bind" }, { id: "test-extension" }, resolve),
    );
    const plan = {
      runId: "run",
      queryId: "query",
      actionId: "action",
      ...bound,
      browserSessionEpoch: "epoch",
      stopEpoch: 0,
      target,
      expected: { kind: "changed" },
    };
    return new Promise<any>((resolve) =>
      g.__listeners[0]({ kind: "prepare", plan }, { id: "test-extension" }, resolve),
    );
  }, target);
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
