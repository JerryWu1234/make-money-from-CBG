import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { chromium, type Browser } from "playwright-core";
import { collectDetail, collectValuationDetail, MAIN_TABS } from "./detail";
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
const fixture = (
  missingTooltip: boolean,
  petHtml = "<p>召唤兽(0/10)</p>",
  iconKindId?: string,
  nonEquipmentHtml = "",
) => {
  const gear = `<p>道具和法宝</p><div id="RoleEquip"><a data_kindid="999" data_equip_name="新武器" data_equip_desc="" data_equip_category="武器" data_tip_box="RoleEquipTipsBox"><img ${iconKindId ? `data_kindid="${iconKindId}"` : ""} width="40" height="40" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" onmouseover="${missingTooltip ? "" : "document.getElementById('RoleEquipTipsBox').style.display='block';document.getElementById('RoleEquipTipsBox').innerText='新武器\\n等级 100\\n伤害 +420\\n魔力 +20'"}"></a></div>`;
  return `<meta charset="utf-8"><section><nav>${MAIN_TABS.map(
    (name) =>
      `<button onclick="show(${JSON.stringify(name).replaceAll('"', "&quot;")})">${name}</button>`,
  ).join(
    "",
  )}</nav><div id="panel">${"基本资料。".repeat(60)}</div><div id="RoleEquipTipsBox" style="display:none"></div></section><script>function show(name){document.getElementById('panel').innerHTML=name==='道具/法宝'?${JSON.stringify(gear + nonEquipmentHtml)}:name==='召唤兽/孩子'?${JSON.stringify(petHtml)}:'<p>'+name+'：新资料</p>'}</script>`;
};
const completePet = () =>
  `<p>召唤兽(1/10)</p><img width="30" height="30" data_idx="0" src="/images/pets/small/0.gif"><section><p>详细信息</p><p>类型：幽灵</p><p>等级：0</p><p>成长：1.23</p>${["攻击资质", "防御资质", "体力资质", "法力资质", "速度资质", "躲闪资质"].map((name) => `<p>${name}：1400</p>`).join("")}<p>技能（2）</p><img width="30" height="30" data_skill_type="cifu" data_equip_name="鬼魂术"><img width="30" height="30" data_skill_type="cifu" data_equip_name="死亡召唤"><p>装备（1）</p><img width="30" height="30" data_equip_name="宝宝项圈" data_equip_desc="等级 80#r速度 +20"><p>内丹（1）</p><img width="30" height="30" data_skill_type="neidan" data_equip_name="玄武躯" data_equip_level="5"></section><p>孩子</p><img width="30" height="30" data_skill_type="cifu" data_equip_name="孩子技能">`;

describe("装备局部补采", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ channel: "chrome", headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  it("空描述也读取提示框，新装备和宝宝替换旧快照，其余资料保留", async () => {
    const page = await browser.newPage();
    try {
      await page.route(url, (route) =>
        route.fulfill({ contentType: "text/html", body: fixture(false) }),
      );
      const saved = previous();
      saved.raw = { AllSummon: [{ name: "旧宝宝原始数据" }] };
      const pets = saved.tabs.find((tab) => tab.name === "召唤兽/孩子")!;
      pets.text = "旧宝宝资料";
      pets.petCount = 1;
      pets.pets = [
        { index: 1, name: "旧宝宝", fields: [], skills: [], equipment: [], innerSkills: [] },
      ];
      saved.tabs.push(tab("召唤兽/孩子 / 旧子页"));
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
      expect(equipment.items![0].kindId).toBeUndefined();
      expect(equipment.items![0].location).toBe("RoleEquip");
      expect(equipment.itemsCollectedAt).not.toBe(saved.collectedAt);
      expect(detail.equipmentCapture?.complete).toBe(true);
      const updatedPets = detail.tabs.find((tab) => tab.name === "召唤兽/孩子")!;
      expect(updatedPets.text).toContain("召唤兽(0/10)");
      expect(updatedPets.petCount).toBe(0);
      expect(updatedPets.pets).toEqual([]);
      expect(detail.petCapture?.complete).toBe(true);
      expect(detail.raw).toEqual({});
      expect(saved.raw).toEqual({ AllSummon: [{ name: "旧宝宝原始数据" }] });
      expect(detail.tabs.some((tab) => tab.name === "召唤兽/孩子 / 旧子页")).toBe(false);
      expect(pets.pets[0].name).toBe("旧宝宝");
      expect(saved.tabs.find((tab) => tab.name === "道具/法宝")!.items![0].name).toBe("旧武器");
    } finally {
      await page.close();
    }
  }, 15000);
  it("kindid仅读取装备图标自身原值，父节点的编号不覆盖图标", async () => {
    const page = await browser.newPage();
    try {
      await page.route(url, (route) =>
        route.fulfill({ contentType: "text/html", body: fixture(false, undefined, "025") }),
      );
      const detail = await collectValuationDetail(
        page,
        listing,
        previous(),
        new AbortController().signal,
      );
      expect(detail.tabs.find((tab) => tab.name === "道具/法宝")!.items![0].kindId).toBe("025");
    } finally {
      await page.close();
    }
  }, 15000);
  it("官方法宝和神器容器内的无描述图标不造成真实装备采集失败", async () => {
    const page = await browser.newPage();
    try {
      const others = `<div id="RoleStoreFabao"><img width="40" height="40" data_equip_name="测试法宝" data_equip_type="6033" data_tip_box="MissingArtifactBox"></div><div id="RoleStoreShenqi"><img width="40" height="40" data_equip_name="测试神器"></div><div id="RoleStoreLingbao"><img width="40" height="40" data_equip_name="测试灵宝"></div>`;
      await page.route(url, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: fixture(false, undefined, undefined, others),
        }),
      );
      const detail = await collectValuationDetail(
        page,
        listing,
        previous(),
        new AbortController().signal,
      );
      const items = detail.tabs.find((tab) => tab.name === "道具/法宝")!.items!;
      expect(items.map((item) => item.category)).toEqual(["武器", "法宝", "神器", "灵宝"]);
      expect(items[0].description).toContain("伤害 +420");
      expect(detail.equipmentCapture?.complete).toBe(true);
      expect(detail.equipmentCapture?.issues).toEqual([]);
    } finally {
      await page.close();
    }
  }, 15000);
  it("没有宝宝总数时替换旧资料并记录未知，不能假定零只", async () => {
    const page = await browser.newPage();
    try {
      await page.route(url, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: fixture(false, "<p>召唤兽资料正在读取</p>"),
        }),
      );
      const saved = previous();
      saved.petCapture = { version: 1, collectedAt: saved.collectedAt, complete: true, issues: [] };
      const oldTab = saved.tabs.find((entry) => entry.name === "召唤兽/孩子")!;
      oldTab.petCount = 1;
      oldTab.pets = [
        { index: 1, name: "旧宝宝", fields: [], skills: [], equipment: [], innerSkills: [] },
      ];
      const detail = await collectValuationDetail(
        page,
        listing,
        saved,
        new AbortController().signal,
      );
      const pets = detail.tabs.find((entry) => entry.name === "召唤兽/孩子")!;
      expect(pets.petCount).toBeUndefined();
      expect(pets.pets).toEqual([]);
      expect(detail.petCapture?.complete).toBe(false);
      expect(detail.petCapture?.issues).toContain("召唤兽总数未确认，不能按没有宝宝处理");
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
  it("完整采集核对每只属性和三个区域，并排除孩子技能", async () => {
    const page = await browser.newPage();
    try {
      await page.route(url, (route) =>
        route.fulfill({ contentType: "text/html", body: fixture(false, completePet()) }),
      );
      const detail = await collectDetail(page, listing, new AbortController().signal);
      const snapshot = detail.tabs.find((entry) => entry.name === "召唤兽/孩子")!;
      expect(detail.petCapture).toMatchObject({ complete: true, issues: [] });
      expect(snapshot.petCount).toBe(1);
      expect(snapshot.pets![0].skills.map((skill) => skill.name)).toEqual(["鬼魂术", "死亡召唤"]);
      expect(snapshot.pets![0].equipment[0].description).toBe("等级 80\n速度 +20");
      expect(snapshot.pets![0].innerSkills[0].level).toBe("5");
    } finally {
      await page.close();
    }
  }, 15000);
  it("技能图标漏读或标题数量不符不能标完整", async () => {
    const page = await browser.newPage();
    try {
      const body = completePet()
        .replace("技能（2）", "技能（3）")
        .replace('data_equip_name="死亡召唤"', "");
      await page.route(url, (route) =>
        route.fulfill({ contentType: "text/html", body: fixture(false, body) }),
      );
      const detail = await collectValuationDetail(
        page,
        listing,
        previous(),
        new AbortController().signal,
      );
      expect(detail.petCapture?.complete).toBe(false);
      expect(detail.petCapture?.issues).toEqual(
        expect.arrayContaining([
          "第 1 只召唤兽技能图标未完整读取",
          "第 1 只召唤兽技能数量与页面不一致",
        ]),
      );
    } finally {
      await page.close();
    }
  }, 15000);
  it("明确技能0、未装备和无内丹时允许空列表，但不从缺区域猜零", async () => {
    const page = await browser.newPage();
    try {
      const body = completePet()
        .replace(/<p>技能（2）<\/p><img[^>]*><img[^>]*>/, "<p>技能（0）</p><p>无技能</p>")
        .replace(/<p>装备（1）<\/p><img[^>]*>/, "<p>装备</p><p>未装备</p>")
        .replace(/<p>内丹（1）<\/p><img[^>]*>/, "<p>内丹</p><p>无内丹</p>");
      await page.route(url, (route) =>
        route.fulfill({ contentType: "text/html", body: fixture(false, body) }),
      );
      const detail = await collectValuationDetail(
        page,
        listing,
        previous(),
        new AbortController().signal,
      );
      expect(detail.petCapture).toMatchObject({ complete: true, issues: [] });
      const pet = detail.tabs.find((entry) => entry.name === "召唤兽/孩子")!.pets![0];
      expect(pet.skills).toEqual([]);
      expect(pet.equipment).toEqual([]);
      expect(pet.innerSkills).toEqual([]);
    } finally {
      await page.close();
    }
  }, 15000);
  it("没看到内丹区域不能把空数组当没有内丹", async () => {
    const page = await browser.newPage();
    try {
      const body = completePet().replace(
        /<p>内丹（1）<\/p><img[^>]*data_skill_type="neidan"[^>]*>/,
        "",
      );
      await page.route(url, (route) =>
        route.fulfill({ contentType: "text/html", body: fixture(false, body) }),
      );
      const detail = await collectValuationDetail(
        page,
        listing,
        previous(),
        new AbortController().signal,
      );
      expect(detail.petCapture?.complete).toBe(false);
      expect(detail.petCapture?.issues).toContain("第 1 只召唤兽内丹区域未确认，不能按空列表处理");
    } finally {
      await page.close();
    }
  }, 15000);
});
