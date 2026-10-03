import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { chromium, type Browser } from "playwright-core";
import { collectValuationDetail, MAIN_TABS } from "./detail";
import { CAPTURE_VERSION } from "./compact";
import type { Listing, RoleDetail, TabSnapshot } from "./types";

vi.mock("./page", async (original) => ({
  ...(await original<typeof import("./page")>()),
  pace: async () => {},
}));
vi.mock("./valuation-capture", () => ({
  captureValuation: async () => ({ version: 1, fields: [], issues: [], source: {} }),
}));

const url = "https://xyq.cbg.163.com/equip?s=367&eid=equipment-fixture";
const listing: Listing = {
  key: "367:equipment-fixture",
  serverId: "367",
  eid: "equipment-fixture",
  ordersn: "fixture",
  url,
  sellingTime: null,
  createdTime: null,
  orderTime: null,
  name: "测试角色",
  price: "100",
  attrs: {},
  summary: null,
};
const tab = (name: string): TabSnapshot => ({
  name,
  text: "旧资料",
  fields: [],
  tables: [],
  elements: [],
  tooltips: [],
  items: [],
});
const previous = (): RoleDetail => ({
  captureVersion: 4,
  url,
  collectedAt: "2026-09-26T00:00:00Z",
  raw: {},
  tabs: MAIN_TABS.map((name) => ({
    ...tab(name),
    items:
      name === "道具/法宝"
        ? [{ index: 0, name: "旧武器", kind: "equipment", description: "伤害 +1" }]
        : [],
  })),
});
const fixture = (missingTooltip: boolean) => {
  const gear = `<p>道具和法宝</p><div id="RoleEquip"><a data_equip_name="新武器" data_equip_desc="" data_equip_category="武器" data_tip_box="RoleEquipTipsBox"><img width="40" height="40" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" onmouseover="${missingTooltip ? "" : "document.getElementById('RoleEquipTipsBox').style.display='block';document.getElementById('RoleEquipTipsBox').innerText='新武器\\n等级 100\\n伤害 +420\\n魔力 +20'"}"></a></div>`;
  return `<meta charset="utf-8"><section><nav>${MAIN_TABS.map(
    (name) =>
      `<button onclick="show(${JSON.stringify(name).replaceAll('"', "&quot;")})">${name}</button>`,
  ).join(
    "",
  )}</nav><div id="panel">${"基本资料。".repeat(60)}</div><div id="RoleEquipTipsBox" style="display:none"></div></section><script>function show(name){document.getElementById('panel').innerHTML=name==='道具/法宝'?${JSON.stringify(gear)}:'<p>'+name+'：新资料</p>'}</script>`;
};

describe("装备局部补采", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ channel: "chrome", headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  it("空描述也读取提示框，新装备替换旧快照，其余角色资料保留", async () => {
    const page = await browser.newPage();
    try {
      await page.route(url, (route) =>
        route.fulfill({ contentType: "text/html", body: fixture(false) }),
      );
      const saved = previous();
      const pets = saved.tabs.find((tab) => tab.name === "召唤兽/孩子")!;
      pets.text = "需要保留的旧宝宝资料";
      const detail = await collectValuationDetail(
        page,
        listing,
        saved,
        new AbortController().signal,
      );
      const equipment = detail.tabs.find((tab) => tab.name === "道具/法宝")!;
      expect(detail.captureVersion).toBe(CAPTURE_VERSION);
      expect(equipment.items).toHaveLength(1);
      expect(equipment.items![0].name).toBe("新武器");
      expect(equipment.items![0].description).toContain("伤害 +420");
      expect(equipment.items![0].description).toContain("魔力 +20");
      expect(equipment.items![0].category).toBe("武器");
      expect(equipment.items![0].location).toBe("RoleEquip");
      expect(equipment.itemsCollectedAt).not.toBe(saved.collectedAt);
      expect(detail.equipmentCapture?.complete).toBe(true);
      expect(detail.tabs.find((tab) => tab.name === "召唤兽/孩子")?.text).toBe(pets.text);
      expect(saved.tabs.find((tab) => tab.name === "道具/法宝")!.items![0].name).toBe("旧武器");
    } finally {
      await page.close();
    }
  }, 15000);
  it("提示框没有属性时保留待补采状态，不将仅有名字当完整装备", async () => {
    const page = await browser.newPage();
    try {
      await page.route(url, (route) =>
        route.fulfill({ contentType: "text/html", body: fixture(true) }),
      );
      const detail = await collectValuationDetail(
        page,
        listing,
        previous(),
        new AbortController().signal,
      );
      expect(detail.equipmentCapture?.complete).toBe(false);
      expect(detail.equipmentCapture?.issues).toContain("道具/法宝：新武器 的装备属性未完整读取");
    } finally {
      await page.close();
    }
  }, 15000);
});
