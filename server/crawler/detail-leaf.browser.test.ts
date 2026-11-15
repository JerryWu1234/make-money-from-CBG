import { afterAll, beforeAll, expect, it, vi } from "vite-plus/test";
import { chromium, type Browser, type Page } from "playwright-core";
import { collectDetail, MAIN_TABS } from "./detail";
import { collectPets, petCaptureSummary } from "./pets";
import { evaluateDetailRoot, retainDetailLeafSelector, retainDetailRoot } from "./detail-root";
import { IncompleteCaptureError } from "./capture-readiness";
import type { Listing, TabSnapshot } from "./types";

vi.mock("./page", async (original) => ({
  ...(await original<typeof import("./page")>()),
  pace: async () => {},
}));
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
afterAll(async () => {
  await browser?.close();
});
const listing = {
  serverId: "367",
  eid: "leaf-role",
  key: "367:leaf-role",
  url: "https://xyq.cbg.163.com/equip?s=367&eid=leaf-role",
  attrs: {},
  summary: null,
} as Listing;
const pixel = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
async function routeDocument(page: Page, body: string) {
  await page.route("**/*", (route) =>
    new URL(route.request().url()).pathname === "/equip"
      ? route.fulfill({ contentType: "text/html", body })
      : route.fulfill({
          contentType: "image/gif",
          body: Buffer.from(pixel.split(",")[1], "base64"),
        }),
  );
}
const mutationScript = (mutation: string) =>
  `window.changed=false;window.clicks=[];window.mutate=selector=>{if(window.changed)return;window.changed=true;const list=document.querySelector(selector);if('${mutation}'==='reorder')list.append(list.firstElementChild);else list.innerHTML=[...list.children].reverse().map(node=>node.outerHTML).join('');};`;
function petDocument(mutation: string) {
  return `<meta charset="utf-8"><script>${mutationScript(mutation)}window.select=name=>{clicks.push(name);document.querySelector('#selected').innerHTML='<p>详细信息</p><p>名称：'+name+'</p><p>类型：幽灵</p><p>等级：0</p><p>成长：1.2</p>'+${JSON.stringify(["攻击资质", "防御资质", "体力资质", "法力资质", "速度资质", "躲闪资质"].map((name) => `<p>${name}：1400</p>`).join(""))}+'<p>技能（0）</p><p>装备（0）</p><p>内丹（0）</p>';if('${mutation}'!=='none')mutate('#pets');};</script><section id="detail"><p>召唤兽(2/10)</p><div id="pets">${["A", "B"].map((name, index) => `<img width="20" height="20" src="/pets/small/${index}.gif" data_idx="${index}" onclick="select('${name}')">`).join("")}</div><div id="selected"></div><p>孩子</p></section>`;
}
async function pets(page: Page) {
  await page.goto(listing.url);
  await retainDetailRoot(page, page.locator("#detail"));
  return collectPets(
    page,
    new AbortController().signal,
    (name) =>
      evaluateDetailRoot(
        page,
        (root, name): TabSnapshot => ({
          name,
          text: root.innerText,
          fields: [],
          tables: [],
          elements: [],
          tooltips: [],
          items: [],
        }),
        name,
      ),
    async () => {},
    async () => {},
    () => {},
  );
}
it.each(["reorder", "replace"])(
  "rejects same-count pet leaf %s inside the retained root instead of collecting A twice",
  async (mutation) => {
    const page = await browser.newPage();
    try {
      await routeDocument(page, petDocument(mutation));
      await expect(pets(page)).rejects.toMatchObject({ name: "IncompleteDetailError" });
      expect(
        await page.evaluate(() => ({
          clicks: Reflect.get(window, "clicks"),
          count: document.querySelector("#pets")!.children.length,
          root: document.querySelector("#detail")!.isConnected,
        })),
      ).toEqual({ clicks: ["A"], count: 2, root: true });
    } finally {
      await page.close();
    }
  },
);
it("collects distinct stable pet entries and keeps their complete proof", async () => {
  const page = await browser.newPage();
  try {
    await routeDocument(page, petDocument("none"));
    const result = await pets(page);
    expect(result.pets.map((pet) => pet.name)).toEqual(["A", "B"]);
    expect(
      petCaptureSummary(result.count, result.pets, new Date().toISOString(), result.issues)
        .complete,
    ).toBe(true);
  } finally {
    await page.close();
  }
});
function detailDocument(kind: string, mutation: string) {
  const panels: Record<string, string> = {
    "人物/修炼": "<p>名称：测试人物</p><p>等级：175</p>",
    技能: Array.from(
      { length: 7 },
      (_, index) =>
        `<img width="20" height="20" src="${pixel}" data_skill_type="school_skill" data_equip_name="技能${index}" data_equip_level="150">`,
    ).join(""),
    "道具/法宝": `<div id="RoleUsingEquips">${kind === "icon" ? `<div id="icons">${["A", "B"].map((name) => `<img width="20" height="20" src="${pixel}" data_equip_name="武器${name}" data_equip_category="武器" data_tip_box="WeaponTipsBox" onmouseover="clicks.push('${name}');mutate('#icons');document.querySelector('#WeaponTipsBox').innerText='武器${name}\\n等级 100\\n伤害 +400'">`).join("")}</div>` : ""}</div><div id="RoleStoreEquips"></div><div id="WeaponTipsBox"></div>`,
    "召唤兽/孩子": `<p>召唤兽(0/10)</p><p>孩子</p>${kind === "child" ? `<ul class="child_list">${["A", "B"].map((name) => `<li data-child-id="${name}" onclick="clicks.push('${name}');mutate('.child_list')">孩子${name}</li>`).join("")}</ul>` : ""}`,
    坐骑: `<div id="RoleRiders">${["A", "B"].map((name, index) => `<img width="20" height="20" src="${pixel}" data_idx="${index}" onclick="clicks.push('${name}');mutate('#RoleRiders')">`).join("")}</div><p>坐骑成长：2.3</p>`,
    "锦衣/外观": "<p>锦衣：测试</p>",
    玩家之家: "<p>房屋：测试</p>",
  };
  return `<meta charset="utf-8"><script>${mutationScript(mutation)}window.IsLogin=1;window.EquipInfo={server_id:367,eid:'leaf-role'};window.decode_desc=x=>x;window.RoleInfoParser=class{constructor(){this.raw_info={};this.result={}}};window.panels=${JSON.stringify(panels)};window.show=name=>document.querySelector('#panel').innerHTML=panels[name];</script><section id="detail"><header>价格：￥1234</header><nav>${MAIN_TABS.map((name) => `<button onclick="show('${name}')">${name}</button>`).join("")}</nav><article id="panel">${panels["人物/修炼"]}</article><textarea id="equip_desc_value" hidden>{}</textarea></section>`;
}
it.each(
  ["icon", "mount", "child"].flatMap((kind) =>
    ["reorder", "replace"].map((mutation) => ({ kind, mutation })),
  ),
)(
  "returns a partial detail when $kind leaves $mutation without changing the root or count",
  async ({ kind, mutation }) => {
    const page = await browser.newPage();
    try {
      await routeDocument(page, detailDocument(kind, mutation));
      const error: unknown = await collectDetail(page, listing, new AbortController().signal).catch(
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(IncompleteCaptureError);
      expect((error as IncompleteCaptureError).cause).toMatchObject({
        name: "IncompleteDetailError",
      });
      expect((error as IncompleteCaptureError).detail.tabs.length).toBeGreaterThan(0);
      expect(await page.evaluate(() => Reflect.get(window, "changed"))).toBe(true);
    } finally {
      await page.close();
    }
  },
  20000,
);
it("disposing an old leaf scope cannot invalidate a fresh scope after a normal panel switch", async () => {
  const page = await browser.newPage();
  try {
    await routeDocument(
      page,
      '<section id="detail"><article><button>A</button><button>B</button></article></section>',
    );
    await page.goto(listing.url);
    await retainDetailRoot(page, page.locator("#detail"));
    const old = await retainDetailLeafSelector(page, "article button");
    await page.locator("article").evaluate((panel) => {
      panel.innerHTML = "<button>C</button>";
    });
    const fresh = await retainDetailLeafSelector(page, "article button");
    await expect(old.assert()).rejects.toMatchObject({ name: "IncompleteDetailError" });
    await old.dispose();
    await fresh.assert();
    expect(await fresh.locator(0).innerText()).toBe("C");
    await fresh.dispose();
    expect(() => fresh.locator(0)).toThrow();
  } finally {
    await page.close();
  }
});
