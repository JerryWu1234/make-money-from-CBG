import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { chromium, type Browser } from "playwright-core";
import {
  collectDetail,
  collectValuationDetail,
  equipmentCaptureSummary,
  isOnShelf,
  MAIN_TABS,
} from "./detail";
import { CAPTURE_VERSION, itemFromAttributes } from "./compact";
import type { Listing, RoleDetail, TabSnapshot } from "./types";
import { createCrawlSource } from "./source";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { equipmentInventory } from "../analysis/equipment-pricing";

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
  equipmentDescription = "",
  equipmentHtml?: string,
) => {
  const gear = `<p>道具和法宝</p><div id="RoleEquip"><a data_kindid="999" data_equip_name="新武器" data_equip_desc="${equipmentDescription}" data_equip_category="武器" data_tip_box="RoleEquipTipsBox"><img ${iconKindId ? `data_kindid="${iconKindId}"` : ""} width="40" height="40" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" onmouseout="document.getElementById('RoleEquipTipsBox').style.display='none'" onmouseover="${missingTooltip ? "" : "document.getElementById('RoleEquipTipsBox').style.display='block';document.getElementById('RoleEquipTipsBox').innerText='新武器\\n等级 100\\n伤害 +420\\n魔力 +20'"}"></a></div>`;
  return `<meta charset="utf-8"><section><nav>${MAIN_TABS.map(
    (name) =>
      `<button onclick="show(${JSON.stringify(name).replaceAll('"', "&quot;")})">${name}</button>`,
  ).join(
    "",
  )}</nav><div id="panel">${"基本资料。".repeat(60)}</div><div id="RoleEquipTipsBox" style="display:none"></div></section><script>function show(name){document.getElementById('panel').innerHTML=name==='道具/法宝'?${JSON.stringify((equipmentHtml ?? gear) + nonEquipmentHtml)}:name==='召唤兽/孩子'?${JSON.stringify(petHtml)}:'<p>'+name+'：新资料</p>'}</script>`;
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
  it("同一采集流程先缺武器属性，自动重新打开并读全后才返回完成", async () => {
    const page = await browser.newPage();
    let visits = 0;
    await page.route("**/*", async (route) => {
      if (route.request().isNavigationRequest()) visits++;
      await route.fulfill({
        contentType: "text/html",
        body: fixture(visits === 1, undefined, undefined, "", "等级 100"),
      });
    });
    const progress: string[] = [];
    try {
      const source = createCrawlSource({
        listPage: page,
        detailPage: page,
        signal: new AbortController().signal,
        savedRecord: () => ({ listing, detail: previous(), status: "complete", error: null }),
        onDetailProgress: (message) => progress.push(message),
        log: () => {},
      });
      const result = await source.detail(listing);
      expect(visits).toBe(2);
      expect(result.equipmentCapture).toMatchObject({ complete: true, issues: [] });
      expect(result.petCapture).toMatchObject({ complete: true, issues: [] });
      expect(result.tabs.find((tab) => tab.name === "道具/法宝")!.items![0].description).toContain(
        "伤害 +420",
      );
      expect(progress.some((message) => message.includes("本轮内自动重读"))).toBe(true);
    } finally {
      await page.close();
    }
  }, 20000);
  it("宝宝饰品带切换索引但只有提示框时仍读取，不能误当头像跳过", async () => {
    const page = await browser.newPage();
    const pet = completePet()
      .replace("装备（1）", "装备（2）")
      .replace(
        "<p>内丹（1）</p>",
        `<div id="RolePetShipin" data_idx="0" data_tip_box="PetAccessoryTipsBox"><img width="30" height="30" src="/images/pet_shipin/small/1.gif" onmouseover="document.getElementById('PetAccessoryTipsBox').style.display='block'" onmouseout="document.getElementById('PetAccessoryTipsBox').style.display='none'"></div><div id="PetAccessoryTipsBox" style="display:none">雷龙饰品<br>装备对象：雷龙<br>完整的外观说明</div><p>内丹（1）</p>`,
      );
    await page.route("**/*", (route) =>
      route.fulfill({ contentType: "text/html", body: fixture(false, pet) }),
    );
    try {
      const result = await collectValuationDetail(
        page,
        listing,
        previous(),
        new AbortController().signal,
      );
      expect(result.petCapture).toMatchObject({ complete: true, issues: [] });
      const captured = result.tabs.find((tab) => tab.name === "召唤兽/孩子")!.pets![0];
      expect(captured.equipment).toHaveLength(2);
      expect(captured.equipment[1]).toMatchObject({ name: "雷龙饰品", location: "RolePetShipin" });
    } finally {
      await page.close();
    }
  });
  it("名称和等级已显示时仍等待延迟的完整属性，不能提前当作读全", async () => {
    const page = await browser.newPage();
    const original =
      "document.getElementById('RoleEquipTipsBox').innerText='新武器\\n等级 100\\n伤害 +420\\n魔力 +20'";
    const html = fixture(false, undefined, undefined, "", "等级 100").replace(
      original,
      "document.getElementById('RoleEquipTipsBox').innerText='新武器\\n等级 100';setTimeout(()=>{document.getElementById('RoleEquipTipsBox').innerText='新武器\\n等级 100\\n伤害 +420\\n魔力 +20'},800)",
    );
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
    try {
      const result = await collectValuationDetail(
        page,
        listing,
        previous(),
        new AbortController().signal,
      );
      expect(result.equipmentCapture).toMatchObject({ complete: true, issues: [] });
      expect(result.tabs.find((tab) => tab.name === "道具/法宝")!.items![0].description).toContain(
        "伤害 +420",
      );
    } finally {
      await page.close();
    }
  });
  it("明确属于召唤兽的命中率护腕不要求人物装备属性，仍核验人物装备库存", () => {
    const snapshot = {
      ...tab("道具/法宝"),
      items: [
        {
          index: 0,
          name: "测试刀",
          kind: "equipment" as const,
          description: "等级 100\n伤害 +420",
        },
        {
          index: 1,
          name: "玳瑁护腕",
          kind: "equipment" as const,
          description: "等级 105\n命中率 +14%\n耐久度 500",
          attributes: { 装备对象: "召唤兽" },
        },
      ],
    };
    expect(equipmentCaptureSummary([snapshot], "now")).toMatchObject({
      complete: true,
      issues: [],
    });
    snapshot.items.shift();
    expect(equipmentCaptureSummary([snapshot], "now").issues).toContain(
      "人物装备库存是否为空尚未核对，需确认穿戴与随身装备区域后再计价",
    );
  });
  it.each([
    ["已上架", "已下架", true],
    ["已下架", "已上架", false],
    ["", "已上架", false],
  ])(
    "锚点只按主文档上架状态 %s 核对，忽略辅助 shadow body 的 %s",
    async (state, auxiliary, expected) => {
      const page = await browser.newPage();
      try {
        await page.route(url, (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `<meta charset="utf-8"><p>${state ? `是否上架：${state}` : "商品详情"}</p><browser-mcp-container></browser-mcp-container><script>const auxiliaryBody = document.createElement('body'); auxiliaryBody.innerText = '是否上架：${auxiliary}'; document.querySelector('browser-mcp-container').attachShadow({mode:'open'}).append(auxiliaryBody);</script>`,
          }),
        );
        await page.goto(url);
        expect(await page.locator("body").count()).toBe(2);
        expect(await isOnShelf(page, listing, new AbortController().signal)).toBe(expected);
      } finally {
        await page.close();
      }
    },
  );

  it.each([
    ["上架中", true],
    ["已下架", false],
  ])("当前官网的主商品状态%s可识别，辅助页面状态不影响判断", async (state, expected) => {
    const page = await browser.newPage();
    try {
      await page.route(url, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<meta charset="utf-8"><p>编号：123</p><p>状态：${state}</p><p>价格：￥5888.00（元）</p><browser-mcp-container></browser-mcp-container><script>const auxiliaryBody = document.createElement('body'); auxiliaryBody.innerText = '状态：已下架'; document.querySelector('browser-mcp-container').attachShadow({mode:'open'}).append(auxiliaryBody);</script>`,
        }),
      );
      expect(await isOnShelf(page, listing, new AbortController().signal)).toBe(expected);
    } finally {
      await page.close();
    }
  });

  it("官网时间锁徽章不计装备图标，其他同尺寸未知图片仍报告缺失", async () => {
    const page = await browser.newPage();
    try {
      await page.route("**/images/**", (route) => route.abort());
      const badges =
        '<img width="14" height="14" src="/images/time_lock_9.png"><img width="14" height="14" src="/images/time_lock_1.png?v=1"><img width="14" height="14" src="/images/time_lock_protect.png"><img width="14" height="14" src="/images/time_lock_huoyue.png?v=1">';
      await page.route(url, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: fixture(false, undefined, undefined, badges),
        }),
      );
      const detail = await collectValuationDetail(
        page,
        listing,
        previous(),
        new AbortController().signal,
      );
      expect(detail.equipmentCapture).toMatchObject({ complete: true, issues: [] });
      expect(detail.tabs.find((tab) => tab.name === "道具/法宝")!.items).toHaveLength(1);
      await page.unroute(url);
      await page.route(url, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: fixture(
            false,
            undefined,
            undefined,
            badges + '<img width="14" height="14" src="/images/unknown.png">',
          ),
        }),
      );
      const incomplete = await collectValuationDetail(
        page,
        listing,
        previous(),
        new AbortController().signal,
      );
      expect(incomplete.equipmentCapture?.complete).toBe(false);
      expect(incomplete.equipmentCapture?.issues.join(" ")).toContain(
        "第 2 个物品图标没有读取到名称和属性",
      );
    } finally {
      await page.close();
    }
  }, 15000);

  it.each([
    "cash",
    "artifacts",
    "hidden",
    "empty",
    "explicit",
    "material",
    "unknown-item",
    "wrong-name",
  ])("空装备只有实际容器或明确文字可确认：%s", async (kind) => {
    const page = await browser.newPage();
    try {
      const artifacts =
        '<div id="RoleUsingFabao"><img data_equip_name="法宝" data_equip_type="6033" src="/images/fabao.png"></div>';
      const empty =
        '<table id="RoleUsingEquips"><tbody><tr><td></td></tr></tbody></table><table id="RoleStoreEquips"><tbody><tr><td></td></tr></tbody></table>';
      const material = `<img width="50" height="50" src="/images/equip/small/17320.gif" data_equip_name="${kind === "wrong-name" ? "未知物品" : "三界密令"}" data_equip_type="${kind === "unknown-item" ? "17321" : "17320"}" data_equip_desc="灵气：158" data_equip_type_desc="流传于三界之间的神秘信物，内藏乾坤，完成密令任务获得奖励（转换月卡可得，右键使用）">`;
      const body =
        kind === "cash"
          ? "<p>现金：100</p><p>存银：0</p>"
          : kind === "artifacts"
            ? artifacts
            : kind === "hidden"
              ? empty.replace('id="RoleStoreEquips"', 'id="RoleStoreEquips" style="display:none"')
              : ["material", "unknown-item", "wrong-name"].includes(kind)
                ? empty.replace(
                    '<table id="RoleStoreEquips"><tbody><tr><td>',
                    `<table id="RoleStoreEquips"><tbody><tr><td>${material}`,
                  )
                : kind === "explicit"
                  ? "<p>没有装备</p>"
                  : empty + artifacts;
      await page.route("**/images/**", (route) => route.abort());
      await page.route(url, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: fixture(false, undefined, undefined, "", "", body),
        }),
      );
      const captured = await collectValuationDetail(
        page,
        listing,
        previous(),
        new AbortController().signal,
      );
      const expected = ["empty", "explicit", "material"].includes(kind);
      expect(captured.equipmentCapture?.complete).toBe(expected);
      expect(captured.equipmentCapture?.emptyProof).toBe(
        ["empty", "material"].includes(kind)
          ? "official-containers"
          : kind === "explicit"
            ? "explicit-text"
            : undefined,
      );
      if (!expected)
        expect(captured.equipmentCapture?.issues.join(" ")).toContain("库存是否为空尚未核对");
    } finally {
      await page.close();
    }
  });

  it("新采保存官网模型号，玉魄、技能书和镶嵌材料不误报装备属性缺失", async () => {
    const page = await browser.newPage();
    try {
      const others =
        '<div id="store_equip_tips1"><img width="40" height="40" data_equip_name="上古玉魄·阴" data_equip_type="61717" data_equip_desc="防御 +25#r耐久度 102#r抵抗封印等级 +13 [+48]#r奇袭法术：弱点击破"></div><div id="store_equip_tips2"><img width="40" height="40" data_equip_name="魔兽要诀" data_equip_type="611" data_equip_desc="召唤兽技能：高级反震"></div>';
      const materials = [4036, 4037, 4038]
        .map(
          (model) =>
            `<div id="store_equip_tips${model}"><img width="40" height="40" data_equip_name="精魄灵石" data_equip_type="${model}" data_equip_desc="等级:7,增加10点伤害"></div>`,
        )
        .join("");
      await page.route(url, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: fixture(false, undefined, undefined, others + materials),
        }),
      );
      const detail = await collectValuationDetail(
        page,
        listing,
        previous(),
        new AbortController().signal,
      );
      expect(detail.equipmentCapture).toMatchObject({ complete: true, issues: [] });
      const items = detail.tabs.find((tab) => tab.name === "道具/法宝")!.items!;
      expect(items[1]).toMatchObject({ modelId: "61717", category: "上古玉魄" });
      expect(items[1].description).toContain("奇袭法术：弱点击破");
      expect(items[2]).toMatchObject({ modelId: "611", category: "道具 · 召唤兽技能书" });
      expect(items.slice(3)).toHaveLength(3);
      for (const item of items.slice(3)) {
        expect(item.category).toBe("材料 · 精魄灵石");
        expect(item.description).toContain("增加10点伤害");
      }
    } finally {
      await page.close();
    }
  }, 15000);
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
  it.each([
    { label: "complete", tooltip: "水晶棒\n等级 70\n未鉴定物品", complete: true },
    { label: "wrong-name", tooltip: "另一把武器\n等级 70\n未鉴定物品", complete: false },
    { label: "wrong-level", tooltip: "水晶棒\n等级 80\n未鉴定物品", complete: false },
    { label: "missing-level", tooltip: "水晶棒\n未鉴定物品", complete: false },
    { label: "identified-missing-stats", tooltip: "水晶棒\n等级 70", complete: false },
  ])(
    "未鉴定装备采集身份与未知价格边界：$label",
    async ({ label, tooltip, complete }) => {
      const page = await browser.newPage();
      try {
        const gear = `<p>道具和法宝</p><div id="store_equip_tips4"><img width="40" height="40" data_equip_name="水晶棒" data_equip_type="1808" data_equip_level="70" data_tip_box="UnidentifiedTipsBox" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" onmouseover="document.getElementById('UnidentifiedTipsBox').style.display='block'"><div id="UnidentifiedTipsBox" style="display:none;white-space:pre-line">${tooltip}</div></div>`;
        await page.route(url, (route) =>
          route.fulfill({
            contentType: "text/html",
            body: fixture(false, undefined, undefined, "", "", gear),
          }),
        );
        const detail = await collectValuationDetail(
          page,
          listing,
          previous(),
          new AbortController().signal,
        );
        expect(detail.equipmentCapture?.complete).toBe(complete);
        const item = detail.tabs.find((entry) => entry.name === "道具/法宝")!.items![0];
        const inventory = equipmentInventory({
          listing,
          detail,
          status: complete ? "complete" : "failed",
          error: null,
        });
        if (complete) {
          expect(item.name).toBe("水晶棒");
          expect(item.description).toContain("未鉴定物品");
          expect(item.description).not.toMatch(/伤害|命中/);
          expect(inventory.captureComplete).toBe(true);
          expect(inventory.items[0]).toMatchObject({
            referencePrice: null,
            searchState: "skipped",
            candidates: [],
          });
          expect(item.category).toBeUndefined();
          expect(item.modelId).toBe("1808");
          expect(item.location).toBe("store_equip_tips4");
          expect(inventory.items[0].skipReason).toMatch(/未鉴定.*初始.*未知/);
        } else expect(detail.equipmentCapture?.issues.length).toBeGreaterThan(0);
        const directory = path.resolve("data/capture-regression/unidentified");
        await mkdir(directory, { recursive: true });
        await writeFile(
          path.join(directory, label + ".json"),
          JSON.stringify({ simulated: true, label, tooltip, detail, inventory }, null, 2),
        );
        await page.screenshot({ path: path.join(directory, label + ".png") });
      } finally {
        await page.close();
      }
    },
    15000,
  );

  it.each([false, true])(
    "只有等级的非空描述仍读取提示框，提示框缺失=%s",
    async (missingTooltip) => {
      const page = await browser.newPage();
      try {
        await page.route(url, (route) =>
          route.fulfill({
            contentType: "text/html",
            body: fixture(missingTooltip, undefined, undefined, "", "等级 70"),
          }),
        );
        const detail = await collectValuationDetail(
          page,
          listing,
          previous(),
          new AbortController().signal,
        );
        const item = detail.tabs.find((entry) => entry.name === "道具/法宝")!.items![0];
        if (missingTooltip) {
          expect(item.description).toBe("等级 70");
          expect(detail.equipmentCapture?.complete).toBe(false);
          expect(detail.equipmentCapture?.issues).toContain(
            "道具/法宝：新武器 的装备属性未完整读取",
          );
        } else {
          expect(item.description).toContain("伤害 +420");
          expect(item.description).toContain("魔力 +20");
          expect(detail.equipmentCapture).toMatchObject({ complete: true, issues: [] });
        }
      } finally {
        await page.close();
      }
    },
    15000,
  );
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
        route.fulfill({
          contentType: "text/html",
          body: fixture(
            false,
            completePet().replace(
              "<p>内丹（1）</p>",
              '<img width="14" height="14" src="/images/time_lock_protect.png"><img width="14" height="14" src="/images/time_lock_huoyue.png?v=1"><p>内丹（1）</p>',
            ),
          ),
        }),
      );
      const detail = await collectDetail(page, listing, new AbortController().signal);
      const snapshot = detail.tabs.find((entry) => entry.name === "召唤兽/孩子")!;
      expect(detail.petCapture).toMatchObject({ complete: true, issues: [] });
      expect(snapshot.petCount).toBe(1);
      expect(snapshot.pets![0].skills.map((skill) => skill.name)).toEqual(["鬼魂术", "死亡召唤"]);
      expect(snapshot.pets![0].skills.map((skill) => skill.skillObservation)).toEqual([
        { rawName: "鬼魂术", type: "cifu", section: "技能", state: "current" },
        { rawName: "死亡召唤", type: "cifu", section: "技能", state: "current" },
      ]);
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

describe("装备完整性按官方物品类型核对", () => {
  it("玉魄原始JSON不能充当已渲染完整属性，须继续读官网提示框", () => {
    const snapshot = tab("道具/法宝");
    snapshot.items = [
      itemFromAttributes(
        {
          data_equip_name: "玉魄",
          data_equip_type: "61717",
          data_equip_desc: '{"minghun":{"init":{"desc":"防御 +25"},"base":[{"desc":"气血 +67"}]}}',
        },
        0,
      ),
    ];
    expect(equipmentCaptureSummary([snapshot], "2026-10-05T00:00:00Z")).toMatchObject({
      complete: false,
    });
    expect(equipmentCaptureSummary([snapshot], "2026-10-05T00:00:00Z").issues.join(" ")).toContain(
      "仍为原始JSON",
    );
  });
  it("玉魄不虚构装备等级，但属性漏读仍不标完整", () => {
    const snapshot = tab("道具/法宝");
    snapshot.items = [
      itemFromAttributes(
        {
          data_equip_name: "玉魄",
          data_equip_type: "61718",
          data_equip_desc: "穿刺等级 +6\n耐久度 294",
        },
        0,
      ),
    ];
    expect(equipmentCaptureSummary([snapshot], "2026-10-05T00:00:00Z")).toMatchObject({
      complete: true,
      issues: [],
    });
    delete snapshot.items[0].description;
    expect(equipmentCaptureSummary([snapshot], "2026-10-05T00:00:00Z").issues).toEqual([
      "道具/法宝：玉魄 的装备属性未完整读取",
    ]);
  });
});
