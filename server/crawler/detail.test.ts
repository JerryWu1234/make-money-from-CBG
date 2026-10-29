import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { chromium, type Browser } from "playwright-core";
import { collectDetail, equipmentCaptureSummary, isOnShelf, MAIN_TABS } from "./detail";
import { CAPTURE_VERSION, itemFromAttributes } from "./compact";
import {
  ListingChangedError,
  ListingUnavailableError,
  type Listing,
  type RoleDetail,
  type TabSnapshot,
} from "./types";
import { createCrawlSource } from "./source";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { equipmentInventory } from "../analysis/equipment-pricing";
import { hoverListing, readListings } from "./page";
import { hoverForInspection } from "../viewport";
import { captureValuation } from "./valuation-capture";
import { captureIssues, IncompleteCaptureError } from "./capture-readiness";
import { cleanDiagnostic } from "../diagnostics";
import { CrawlStore } from "./store";

vi.mock("./page", async (original) => ({
  ...(await original<typeof import("./page")>()),
  pace: async () => {},
}));
vi.mock("./valuation-capture", () => ({
  captureValuation: vi.fn(async () => ({
    version: 1,
    fields: [],
    issues: [],
    source: { serverId: "367", eid: "equipment-fixture" },
  })),
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
  schoolCount = 7,
) => {
  const gear = `<p>道具和法宝</p><div id="RoleEquip"><a data_kindid="999" data_equip_name="新武器" data_equip_desc="${equipmentDescription}" data_equip_category="武器" data_tip_box="RoleEquipTipsBox"><img ${iconKindId ? `data_kindid="${iconKindId}"` : ""} width="40" height="40" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" onmouseout="document.getElementById('RoleEquipTipsBox').style.display='none'" onmouseover="${missingTooltip ? "" : "document.getElementById('RoleEquipTipsBox').style.display='block';document.getElementById('RoleEquipTipsBox').innerText='新武器\\n等级 100\\n伤害 +420\\n魔力 +20'"}"></a></div>`;
  const skills =
    "<p>师门技能</p>" +
    ["甲", "乙", "丙", "丁", "戊", "己", "庚"]
      .slice(0, schoolCount)
      .map(
        (suffix) =>
          `<p>150</p><img width="30" height="30" data_skill_type="school_skill" data_equip_name="测试技能${suffix}" data_equip_level="150"><p>测试技能${suffix}</p>`,
      )
      .join("") +
    "<p>生活技能</p>";
  return `<meta charset="utf-8"><section><nav>${MAIN_TABS.map(
    (name) =>
      `<button onclick="show(${JSON.stringify(name).replaceAll('"', "&quot;")})">${name}</button>`,
  ).join(
    "",
  )}</nav><div id="panel">${"基本资料。".repeat(60)}</div><div id="RoleEquipTipsBox" style="display:none"></div></section><script>function show(name){document.getElementById('panel').innerHTML=name==='道具/法宝'?${JSON.stringify((equipmentHtml ?? gear) + nonEquipmentHtml)}:name==='召唤兽/孩子'?${JSON.stringify(petHtml)}:name==='技能'?${JSON.stringify(skills)}:'<p>'+name+'：新资料</p>'}</script>`;
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
  it("详情属性读取不依赖单元素句柄转换，句柄求值超时也不丢失技能及装备", async () => {
    const page = await browser.newPage(),
      locate = page.locator.bind(page);
    const spy = vi.spyOn(page, "locator").mockImplementation((selector, options) => {
      const target = locate(selector, options);
      if (selector.includes("data-cbg-inspect-index"))
        vi.spyOn(target, "evaluate").mockImplementation(async () => {
          throw Object.assign(
            new Error(
              "locator.evaluate: Timeout 15000ms exceeded; locator resolved to visible element",
            ),
            { name: "TimeoutError" },
          );
        });
      return target;
    });
    try {
      await page.route(url, (route) =>
        route.fulfill({ contentType: "text/html", body: fixture(false) }),
      );
      const result = await collectDetail(page, listing, new AbortController().signal);
      expect(
        result.tabs
          .find((tab) => tab.name === "技能")!
          .items!.filter((item) => item.kind === "skill"),
      ).toHaveLength(7);
      expect(
        result.tabs.find((tab) => tab.name === "道具/法宝")!.items!.map((item) => item.name),
      ).toContain("新武器");
    } finally {
      spy.mockRestore();
      await page.close();
    }
  });
  it("真实浏览器中途断开时保留已读标签，统一暂停且不对关闭页面继续重读", async () => {
    const isolated = await chromium.launch({ channel: "chrome", headless: true });
    const page = await isolated.newPage(),
      listPage = await isolated.newPage();
    const navigation = vi.spyOn(page, "goto");
    let closing: Promise<void> | undefined;
    try {
      await page.route(url, (route) =>
        route.fulfill({ contentType: "text/html", body: fixture(false) }),
      );
      const source = createCrawlSource({
        listPage,
        detailPage: page,
        signal: new AbortController().signal,
        log: vi.fn(),
        onDetailProgress: (message) => {
          if (!closing && message.includes("正在读取标签 2/7")) closing = isolated.close();
        },
      });
      const error = await source.detail(listing).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(IncompleteCaptureError);
      expect((error as IncompleteCaptureError).cause).toMatchObject({
        name: "BrowserConnectionError",
      });
      // Graceful Chrome.close can close targets before its transport disconnects;
      // either observed scope must pause and preserve the same partial capture.
      expect(["page_closed", "disconnected"]).toContain(
        ((error as IncompleteCaptureError).cause as { kind: string }).kind,
      );
      expect((error as IncompleteCaptureError).detail.tabs.map((value) => value.name)).toEqual([
        "人物/修炼",
      ]);
      expect(navigation).toHaveBeenCalledOnce();
      expect(page.isClosed()).toBe(true);
      expect(listPage.isClosed()).toBe(true);
    } finally {
      navigation.mockRestore();
      await closing;
      await isolated.close();
    }
  }, 30_000);
  it("主上下文求值永不返回时，总预算关闭独占页并带出已读标签，列表页保持打开", async () => {
    const page = await browser.newPage(),
      listPage = await browser.newPage();
    const evaluate = page.evaluate.bind(page),
      navigation = vi.spyOn(page, "goto");
    let blocked: { mockRestore: () => void } | undefined;
    try {
      await page.route(url, (route) =>
        route.fulfill({ contentType: "text/html", body: fixture(false) }),
      );
      const log = vi.fn();
      const source = createCrawlSource({
        listPage,
        detailPage: page,
        signal: new AbortController().signal,
        detailTimeoutMs: 5000,
        log,
        onDetailProgress: (message) => {
          if (!blocked && message.includes("正在读取标签 2/7"))
            blocked = vi
              .spyOn(page, "evaluate")
              .mockImplementation(() => evaluate(() => new Promise<never>(() => {})));
        },
      });
      const error = await source.detail(listing).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IncompleteCaptureError);
      expect((error as Error).message).toContain("5 秒总时限");
      expect((error as Error).message).not.toContain("采集已暂停");
      expect(log).toHaveBeenCalledWith(
        "detail.cancelled",
        expect.objectContaining({
          key: listing.key,
          reasonCode: "DETAIL_TIMEOUT",
          stage: expect.stringContaining("标签 2/7"),
        }),
      );
      const event = log.mock.calls.find(([name]) => name === "detail.cancelled")![1];
      expect(JSON.parse(JSON.stringify(cleanDiagnostic(event)))).toMatchObject({
        reasonCode: "DETAIL_TIMEOUT",
        stage: expect.stringContaining("标签 2/7"),
      });
      expect((error as IncompleteCaptureError).detail.tabs.map((tab) => tab.name)).toEqual([
        "人物/修炼",
      ]);
      expect(page.isClosed()).toBe(true);
      expect(listPage.isClosed()).toBe(false);
      expect(navigation).toHaveBeenCalledOnce();
    } finally {
      blocked?.mockRestore();
      navigation.mockRestore();
      await page.close();
      await listPage.close();
    }
  }, 15_000);
  it("中途超时只读取一次并保留完成标签，不能自动重开商品", async () => {
    const page = await browser.newPage();
    const progress = vi.fn();
    let visits = 0;
    try {
      await page.route(url, (route) => {
        visits++;
        return route.fulfill({
          contentType: "text/html",
          body:
            fixture(false) +
            '<textarea id="equip_desc_value" hidden>same-role-source-v1</textarea><script>const EquipInfo={server_id:367,eid:"equipment-fixture"}</script>',
        });
      });
      const error = (await createCrawlSource({
        listPage: page,
        detailPage: page,
        signal: new AbortController().signal,
        log: vi.fn(),
        onDetailProgress: (message) => {
          progress(message);
          if (message.includes("标签 7/7"))
            throw Object.assign(new Error("模拟玩家之家读取超时"), { name: "TimeoutError" });
        },
      })
        .detail(listing)
        .catch((error: unknown) => error)) as IncompleteCaptureError;
      expect(error).toBeInstanceOf(IncompleteCaptureError);
      expect(visits).toBe(1);
      expect(error.detail.tabs.map((tab) => tab.name)).toEqual(MAIN_TABS.slice(0, 6));
      expect(progress.mock.calls.filter(([message]) => message.includes("标签 2/7"))).toHaveLength(
        1,
      );
      expect(progress.mock.calls.filter(([message]) => message.includes("标签 7/7"))).toHaveLength(
        1,
      );
      expect(captureIssues(error.detail, true, true, listing)).toContain("角色本体资料未核验");
    } finally {
      await page.close();
    }
  }, 30_000);
  it.each(["技能不完整", "宝宝不完整"])(
    "%s单次失败且保留缺项，不把半成品当完整",
    async (scenario) => {
      const page = await browser.newPage();
      const progress = vi.fn();
      try {
        await page.route(url, (route) =>
          route.fulfill({
            contentType: "text/html",
            body: fixture(
              false,
              scenario === "宝宝不完整" ? "<p>召唤兽(1/10)</p>" : undefined,
              undefined,
              "",
              "",
              undefined,
              scenario === "技能不完整" ? 6 : 7,
            ),
          }),
        );
        const error = (await createCrawlSource({
          listPage: page,
          detailPage: page,
          signal: new AbortController().signal,
          log: vi.fn(),
          onDetailProgress: progress,
        })
          .detail(listing)
          .catch((error: unknown) => error)) as IncompleteCaptureError;
        expect(error).toBeInstanceOf(IncompleteCaptureError);
        const step = scenario === "技能不完整" ? "标签 2/7" : "标签 4/7";
        expect(progress.mock.calls.filter(([message]) => message.includes(step))).toHaveLength(1);
        expect(captureIssues(error.detail, true, true, listing).join("；")).toContain(
          scenario === "技能不完整" ? "7项" : "宝宝",
        );
      } finally {
        await page.close();
      }
    },
    30_000,
  );
  it("无关延迟脚本不影响读完七个标签后的完整入库", async () => {
    const page = await browser.newPage();
    let visits = 0;
    try {
      await page.route(url, (route) => {
        visits++;
        return route.fulfill({
          contentType: "text/html",
          body:
            fixture(false) +
            '<textarea id="equip_desc_value" hidden>stable-role-source</textarea><script>const EquipInfo={server_id:367,eid:"equipment-fixture"}; const stableShow=show; show=function(name){stableShow(name); if(name==="玩家之家"){const s=document.createElement("script");s.src="data:text/javascript,void%200";document.head.appendChild(s)}}</script>',
        });
      });
      const result = await createCrawlSource({
        listPage: page,
        detailPage: page,
        signal: new AbortController().signal,
        log: vi.fn(),
        onDetailProgress: vi.fn(),
      }).detail(listing);
      expect(visits).toBe(1);
      expect(captureIssues(result, true, true, listing)).toEqual([]);
      expect(result.tabs.map((tab) => tab.name)).toEqual(MAIN_TABS);
    } finally {
      await page.close();
    }
  }, 30_000);
  it.each(["原文变化", "配置不可读"])(
    "末尾%s保留本轮本体核验和七标签，但仍失败不入完整库",
    async (scenario) => {
      const page = await browser.newPage();
      try {
        const change = `<textarea id="equip_desc_value" hidden>stable-source</textarea><script>const EquipInfo={server_id:367,eid:"equipment-fixture"};window.CBG_GAME_CONFIG={};const oldShow=show;show=function(name){oldShow(name);if(name==="玩家之家"){${scenario === "原文变化" ? 'document.getElementById("equip_desc_value").value="changed-source"' : 'window.CBG_GAME_CONFIG=new Proxy({},{ownKeys(){throw new Error("unreadable late config")}})'}}}</script>`;
        await page.route(url, (route) =>
          route.fulfill({ contentType: "text/html", body: fixture(false) + change }),
        );
        const error = (await createCrawlSource({
          listPage: page,
          detailPage: page,
          signal: new AbortController().signal,
          onDetailProgress: vi.fn(),
          log: vi.fn(),
        })
          .detail(listing)
          .catch((error: unknown) => error)) as IncompleteCaptureError;
        expect(error).toBeInstanceOf(IncompleteCaptureError);
        expect(error.detail.tabs.map((tab) => tab.name)).toEqual(MAIN_TABS);
        expect(error.detail.equipmentCapture?.complete).toBe(true);
        expect(error.detail.petCapture?.complete).toBe(true);
        expect(error.detail.valuation?.source).toEqual({
          serverId: listing.serverId,
          eid: listing.eid,
        });
        expect(captureIssues(error.detail, true, true, listing)).toEqual(
          expect.arrayContaining([
            expect.stringContaining(
              scenario === "原文变化" ? "原文或身份变化" : "公开配置无法核验",
            ),
          ]),
        );
        const store = new CrawlStore(":memory:");
        try {
          store.observe(listing);
          expect(store.save(listing, error.detail)).toBe(false);
          expect(store.count()).toBe(0);
        } finally {
          store.close();
        }
      } finally {
        await page.close();
      }
    },
    30_000,
  );
  it("已分类道具读取关联提示框用途，不继续等待人物装备数值", async () => {
    const page = await browser.newPage();
    try {
      const equipment =
        '<div id="RoleUsingEquips"></div><div id="RoleStoreEquips"><img width="40" height="40" data_equip_type="90001" data_tip_box="StoreItemTipsBox" onmouseover="document.getElementById(\'StoreItemTipsBox\').style.display=\'block\'"></div><div id="StoreItemTipsBox" style="display:none;white-space:pre-line">官网道具\n完整用途说明</div>';
      await page.route(url, (route) =>
        route.fulfill({
          contentType: "text/html",
          body:
            fixture(false, undefined, undefined, "", "", equipment) +
            '<script>class RoleNameConf{get_equip_info(){return {name:"官网道具",category:"道具"}}}</script>',
        }),
      );
      const result = await createCrawlSource({
        listPage: page,
        detailPage: page,
        signal: new AbortController().signal,
        onDetailProgress: vi.fn(),
        log: vi.fn(),
      }).detail(listing);
      expect(captureIssues(result, true, true, listing)).toEqual([]);
      expect(result.tabs.find((tab) => tab.name === "道具/法宝")!.items![0].description).toContain(
        "完整用途说明",
      );
    } finally {
      await page.close();
    }
  }, 15_000);
  it.each(["getter", "toJSON", "circular"])(
    "配置%s不击穿实际采集，物品可用备用官网型号核验",
    async (kind) => {
      const page = await browser.newPage();
      try {
        const equipment =
          '<div id="RoleUsingEquips"><img width="40" height="40" data_equip_type="31001" data_equip_desc="等级 30#r伤害 +100"></div>';
        const config = `<textarea id="equip_desc_value" hidden>stable-source-with-public-config</textarea><script>const EquipInfo={server_id:367,eid:"equipment-fixture"};window.optionalCalls=0;window.modelCalls=0;const CBG_GAME_CONFIG={equip_info:{}};Object.defineProperty(CBG_GAME_CONFIG.equip_info,"31001",{enumerable:true,get(){window.modelCalls++;throw new Error("primary model metadata unavailable")}});class RoleNameConf{get_equip_info(){return {name:"官网型号名称",category:"人物装备"}}};${kind === "getter" ? 'Object.defineProperty(CBG_GAME_CONFIG,"optional",{enumerable:true,get(){window.optionalCalls++;throw new Error("unrelated optional getter")}});' : kind === "toJSON" ? 'CBG_GAME_CONFIG.toJSON=()=>{window.optionalCalls++;throw new Error("unrelated optional serializer")};' : "CBG_GAME_CONFIG.self=CBG_GAME_CONFIG;"}</script>`;
        await page.route(url, (route) =>
          route.fulfill({
            contentType: "text/html",
            body: fixture(false, undefined, undefined, "", "", equipment) + config,
          }),
        );
        const result = await createCrawlSource({
          listPage: page,
          detailPage: page,
          signal: new AbortController().signal,
          onDetailProgress: vi.fn(),
          log: vi.fn(),
        }).detail(listing);
        expect(captureIssues(result, true, true, listing)).toEqual([]);
        expect(result.tabs.find((tab) => tab.name === "道具/法宝")!.items![0]).toMatchObject({
          name: "官网型号名称",
          modelId: "31001",
        });
        expect(await page.evaluate(() => Reflect.get(window, "optionalCalls"))).toBe(0);
        expect(await page.evaluate(() => Reflect.get(window, "modelCalls"))).toBeGreaterThan(0);
      } finally {
        await page.close();
      }
    },
    30_000,
  );
  it("子页中断保留父页快照并单次失败，不自动重开商品", async () => {
    const page = await browser.newPage();
    const progress = vi.fn();
    try {
      const child =
        '<script>const originalShow=show;show=function(name){originalShow(name);if(name==="坐骑")document.getElementById("panel").innerHTML+=\'<button role="tab">坐骑子页</button>\'}</script>';
      await page.route(url, (route) =>
        route.fulfill({ contentType: "text/html", body: fixture(false) + child }),
      );
      const error = (await createCrawlSource({
        listPage: page,
        detailPage: page,
        signal: new AbortController().signal,
        log: vi.fn(),
        onDetailProgress: (message) => {
          progress(message);
          if (message.includes("正在读取 坐骑 / 坐骑子页"))
            throw Object.assign(new Error("模拟子页中断"), { name: "TimeoutError" });
        },
      })
        .detail(listing)
        .catch((error: unknown) => error)) as IncompleteCaptureError;
      expect(error).toBeInstanceOf(IncompleteCaptureError);
      expect(error.detail.tabs.some((tab) => tab.name === "坐骑 / 坐骑子页")).toBe(false);
      expect(progress.mock.calls.filter(([message]) => message.includes("标签 5/7"))).toHaveLength(
        1,
      );
      expect(progress.mock.calls.filter(([message]) => message.includes("标签 2/7"))).toHaveLength(
        1,
      );
    } finally {
      await page.close();
    }
  }, 30_000);
  it("非人物装备的分类不跳过召唤兽自身装备的属性读取", async () => {
    const page = await browser.newPage();
    try {
      const pet =
        completePet().replace(
          'data_equip_name="宝宝项圈" data_equip_desc="等级 80#r速度 +20"',
          'data_equip_name="宝宝项圈" data_equip_level="80" data_equip_type_desc="【装备对象】召唤兽" data_tip_box="PetItemTipsBox" onmouseover="document.getElementById(\'PetItemTipsBox\').style.display=\'block\'"',
        ) +
        '<div id="PetItemTipsBox" style="display:none;white-space:pre-line">宝宝项圈\n等级 80\n速度 +20</div>';
      await page.route(url, (route) =>
        route.fulfill({ contentType: "text/html", body: fixture(false, pet) }),
      );
      const detail = await collectDetail(page, listing, new AbortController().signal);
      expect(detail.petCapture?.complete).toBe(true);
      const pets = detail.tabs.find((tab) => tab.name === "召唤兽/孩子")!.pets!;
      expect(pets[0].equipment.find((item) => item.name === "宝宝项圈")?.description).toContain(
        "速度 +20",
      );
    } finally {
      await page.close();
    }
  });
  it.each([
    "official-model",
    "official-resolver",
    "official-lexical",
    "resolver-throws",
    "resolver-constructor-throws",
    "resolver-metadata-getter-throws",
    "tooltip-heading",
    "unknown",
    "ambiguous-tooltip",
  ])(
    "所有角色共用名称补全且未知或串提示框不能通过：%s",
    async (mode) => {
      const page = await browser.newPage();
      try {
        const image =
          '<img width="40" height="40" data_equip_type="31001" data_equip_location="role_using_equip_6" data_equip_desc="等级 30#r伤害 +100"';
        const equipment = mode.includes("tooltip")
          ? `${image} onmouseover="document.getElementById('RoleEquipTipsBox').style.display='block'" ${mode === "ambiguous-tooltip" ? "" : 'data_tip_box="RoleEquipTipsBox"'}>`
          : `${image}>`;
        const html =
          fixture(false, "<p>召唤兽(0/10)</p>", undefined, "", "", equipment) +
          (mode === "resolver-metadata-getter-throws"
            ? '<script>window.CBG_GAME_CONFIG={equip_info:{31001:{name:"官网型号名称"}}};class RoleNameConf {get_equip_info(){return {get name(){throw new Error("备用元数据属性尚未就绪")}}}}</script>'
            : mode === "resolver-constructor-throws"
              ? '<script>window.CBG_GAME_CONFIG={equip_info:{31001:{name:"官网型号名称"}}};class RoleNameConf {constructor(){throw new Error("备用配置尚未就绪")}}</script>'
              : mode === "resolver-throws"
                ? '<script>window.CBG_GAME_CONFIG={equip_info:{31001:{name:"官网型号名称"}}};class RoleNameConf {get_equip_info(){throw new Error("此型号备用查表不可用")}}</script>'
                : mode === "official-model"
                  ? '<script>window.CBG_GAME_CONFIG={equip_info:{31001:{name:"官网型号名称"}}}</script>'
                  : mode === "official-resolver"
                    ? '<script>class RoleNameConf { get_equip_info(model){return model===31001?{name:"官网型号名称"}:undefined} }</script>'
                    : mode === "official-lexical"
                      ? '<script>const CBG_GAME_CONFIG={equip_info:{31001:{name:"官网型号名称"}}}</script>'
                      : "");
        await page.route(url, (route) => route.fulfill({ contentType: "text/html", body: html }));
        // The heading is deliberately not the tooltip's first line.
        await page.addInitScript(() => {
          document.addEventListener("DOMContentLoaded", () => {
            const box = document.getElementById("RoleEquipTipsBox")!;
            box.innerHTML = "<p>等级 30</p><h3>实际武器名称</h3><p>伤害 +100</p>";
          });
        });
        if (mode === "ambiguous-tooltip")
          await page.addInitScript(() =>
            document.addEventListener("DOMContentLoaded", () => {
              const other = document.createElement("div");
              other.setAttribute("role", "tooltip");
              other.innerHTML = "<h3>其他物品</h3><p>等级 30</p><p>伤害 +999</p>";
              document.body.append(other);
            }),
          );
        const official = mode.startsWith("official-") || mode.startsWith("resolver-");
        const valid = official || mode === "tooltip-heading";
        const signal = new AbortController().signal;
        const detail = valid
          ? await createCrawlSource({
              listPage: page,
              detailPage: page,
              signal,
              onDetailProgress: vi.fn(),
              log: vi.fn(),
            }).detail(listing)
          : await collectDetail(page, listing, signal);
        const item = detail.tabs.find((entry) => entry.name === "道具/法宝")!.items![0];
        if (["unknown", "ambiguous-tooltip"].includes(mode)) {
          expect(detail.equipmentCapture?.complete).toBe(false);
          expect(item.name).toMatch(/^图标/);
        } else {
          expect(item.name).toBe(official ? "官网型号名称" : "实际武器名称");
          expect(item.nameSource).toBe(official ? "official-model" : "tooltip");
          expect(detail.equipmentCapture?.complete).toBe(true);
          const store = new CrawlStore(":memory:");
          try {
            store.observe(listing);
            expect(store.save(listing, detail)).toBe(true);
            expect(store.count()).toBe(1);
          } finally {
            store.close();
          }
        }
      } finally {
        await page.close();
      }
    },
    15000,
  );
  it.each([404, 410, 200])(
    "官网确证不存在HTTP %s只请求一次，不做三轮资料重试",
    async (status) => {
      const page = await browser.newPage();
      let visits = 0;
      try {
        await page.route(url, async (route) => {
          visits++;
          await route.fulfill({
            status,
            contentType: "text/html",
            body: "<meta charset=utf-8><main>很抱歉，您查询的商品不存在。</main>",
          });
        });
        const source = createCrawlSource({
          listPage: page,
          detailPage: page,
          signal: new AbortController().signal,
          onDetailProgress: vi.fn(),
          log: vi.fn(),
        });
        const error = await source.detail(listing).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(ListingUnavailableError);
        expect((error as Error).message).toContain("不再重试");
        expect(visits).toBe(1);
      } finally {
        await page.close();
      }
    },
    10000,
  );
  it.each([
    ["登录", 404, "<script>window.IsLogin=0</script><p>商品不存在</p>", "登录"],
    ["布尔登录", 404, "<script>window.IsLogin=false</script><p>商品不存在</p>", "登录"],
    [
      "布尔LoginInfo",
      410,
      "<script>window.LoginInfo={login:false}</script><p>商品不存在</p>",
      "登录",
    ],
    ["验证码", 410, "<div id=captcha_container>安全验证</div><p>商品不存在</p>", "安全验证"],
    ["降低频率", 404, "<p>系统繁忙</p><p>商品不存在</p>", "繁忙"],
    ["登录面板", 404, "<div id=loginContainer>扫码登录</div><p>商品不存在</p>", "登录"],
  ] as const)("%s优先于不存在证据，不能终止补齐", async (_label, status, body, message) => {
    const page = await browser.newPage();
    try {
      await page.route(url, (route) =>
        route.fulfill({ status, contentType: "text/html", body: `<meta charset=utf-8>${body}` }),
      );
      const error = await isOnShelf(page, listing, new AbortController().signal).catch(
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ListingUnavailableError);
      expect((error as Error).message).toContain(message);
    } finally {
      await page.close();
    }
  });
  it.each([
    ["已售出", "<main>商品已售出</main>"],
    ["已下架", "<main>商品已下架</main>"],
    ["推荐内容", "<main>页面加载中</main><aside>商品不存在</aside>"],
    ["其他说明", "<main>如遇商品不存在，请重试</main>"],
  ])("%s不等于商品不存在", async (_label, body) => {
    const page = await browser.newPage();
    try {
      await page.route(url, (route) =>
        route.fulfill({ contentType: "text/html", body: `<meta charset=utf-8>${body}` }),
      );
      await expect(isOnShelf(page, listing, new AbortController().signal)).resolves.toBe(false);
    } finally {
      await page.close();
    }
  });
  it.each([404, 410])("HTTP %s伴随明确已售/下架状态不足以认定商品删除", async (status) => {
    const page = await browser.newPage();
    try {
      for (const state of ["商品已售出", "商品已下架", "状态：已下架"]) {
        await page.route(url, (route) =>
          route.fulfill({
            status,
            contentType: "text/html",
            body: `<meta charset=utf-8><main>${state}</main>`,
          }),
        );
        await expect(isOnShelf(page, listing, new AbortController().signal)).resolves.toBe(false);
        await page.unroute(url);
      }
    } finally {
      await page.close();
    }
  });
  it.each([
    "<main>页面加载中</main><aside><div role=alert>商品不存在</div></aside>",
    "<aside><div class=error_msg>商品不存在</div></aside>",
    "<main>页面加载中</main><div id=recommend><div class=error_box>商品不存在</div></div>",
  ])("推荐或侧栏错误提示不作为主商品不存在证据：%s", async (body) => {
    const page = await browser.newPage();
    try {
      await page.route(url, (route) =>
        route.fulfill({ contentType: "text/html", body: `<meta charset=utf-8>${body}` }),
      );
      await expect(isOnShelf(page, listing, new AbortController().signal)).resolves.toBe(false);
    } finally {
      await page.close();
    }
  });
  it("跳转到其他商品的404不能作为目标商品不存在的证据", async () => {
    const page = await browser.newPage();
    const other = url.replace("equipment-fixture", "other-role");
    try {
      await page.route("**/*", (route) =>
        route.fulfill({
          status: 404,
          contentType: "text/html",
          body: "<meta charset=utf-8><main>商品不存在</main>",
        }),
      );
      const goto = page.goto.bind(page);
      // Redirected HTTP requests bypass route handlers; navigate the routed alternate page directly.
      vi.spyOn(page, "goto").mockImplementationOnce(async (_url, options) => goto(other, options));
      await expect(isOnShelf(page, listing, new AbortController().signal)).resolves.toBe(false);
    } finally {
      await page.close();
    }
  });
  it("详情导航超时原样抛出，不能转成不存在", async () => {
    const page = await browser.newPage();
    const timeout = Object.assign(new Error("page.goto: Timeout"), { name: "TimeoutError" });
    try {
      vi.spyOn(page, "goto").mockRejectedValueOnce(timeout);
      await expect(isOnShelf(page, listing, new AbortController().signal)).rejects.toBe(timeout);
    } finally {
      await page.close();
    }
  });
  it("未完成导航须先清空旧文档，再重新导航，延迟响应不能打断下一次读取", async () => {
    const page = await browser.newPage();
    const goto = page.goto.bind(page);
    const navigation = vi.spyOn(page, "goto");
    let requests = 0;
    navigation.mockImplementation((address, options) =>
      goto(address, {
        ...options,
        ...(address === url && requests === 0 ? { timeout: 40 } : {}),
      }),
    );
    try {
      await page.route(url, async (route) => {
        requests++;
        if (requests === 1) await new Promise((resolve) => setTimeout(resolve, 250));
        await route.fulfill({ contentType: "text/html", body: fixture(false) }).catch(() => {});
      });
      const log = vi.fn();
      const result = await createCrawlSource({
        listPage: page,
        detailPage: page,
        signal: new AbortController().signal,
        onDetailProgress: vi.fn(),
        log,
      }).detail(listing);
      expect(captureIssues(result, true, true, listing)).toEqual([]);
      expect(navigation.mock.calls.map(([address]) => address)).toEqual([url, "about:blank", url]);
      expect(log).toHaveBeenCalledWith(
        "detail.navigation_reset",
        expect.objectContaining({ key: listing.key, attempt: 1 }),
      );
    } finally {
      navigation.mockRestore();
      await page.close();
    }
  }, 30_000);
  it("读到部分资料后超时保存快照，不触发下一次导航或清理重读", async () => {
    const page = await browser.newPage(),
      listPage = await browser.newPage();
    const store = new CrawlStore(":memory:");
    const goto = page.goto.bind(page);
    let visits = 0,
      resets = 0,
      interrupted = false;
    const navigation = vi.spyOn(page, "goto").mockImplementation(async (address, options) => {
      if (address === url && ++visits === 2)
        throw Object.assign(new Error("page.goto: Timeout 45000ms exceeded"), {
          name: "TimeoutError",
        });
      if (address === "about:blank") {
        resets++;
        throw new Error("模拟旧导航无法结束");
      }
      return goto(address, options);
    });
    try {
      await page.route(url, (route) =>
        route.fulfill({ contentType: "text/html", body: fixture(false) }),
      );
      const log = vi.fn();
      const error = (await createCrawlSource({
        listPage,
        detailPage: page,
        signal: new AbortController().signal,
        log,
        onDetailProgress: (message) => {
          if (!interrupted && message.includes("标签 7/7")) {
            interrupted = true;
            throw Object.assign(new Error("模拟末尾读取中断"), { name: "TimeoutError" });
          }
        },
      })
        .detail(listing)
        .catch((error: unknown) => error)) as IncompleteCaptureError;
      expect(error).toBeInstanceOf(IncompleteCaptureError);
      expect(error.cause).toMatchObject({ name: "IncompleteDetailError" });
      expect(error.detail.tabs.some((tab) => tab.name === "技能")).toBe(true);
      expect(visits).toBe(1);
      expect(resets).toBe(0);
      expect(page.isClosed()).toBe(false);
      expect(listPage.isClosed()).toBe(false);
      expect(log).not.toHaveBeenCalledWith("detail.navigation_reset", expect.anything());
      store.observe(listing);
      store.savePartial(listing, error.detail);
      store.fail(listing.key, error.message);
      const saved = store.detail(listing.key) as { status: string; detail: RoleDetail };
      expect(saved.status).toBe("failed");
      expect(saved.detail.tabs.some((tab) => tab.name === "技能")).toBe(true);
      expect(store.count()).toBe(0);
    } finally {
      navigation.mockRestore();
      store.close();
      await page.close();
      await listPage.close();
    }
  }, 30_000);
  it.each([
    {},
    { serverId: "367" },
    { serverId: "750", eid: "equipment-fixture" },
    { serverId: "367", eid: "another-item" },
  ])("实际完整采集入口遇到身份缺失或不同时不能发布：%j", async (source) => {
    const page = await browser.newPage();
    try {
      await page.route(url, (route) =>
        route.fulfill({ contentType: "text/html", body: fixture(false) }),
      );
      vi.mocked(captureValuation).mockResolvedValueOnce({
        version: 1,
        fields: [],
        issues: [],
        source,
      });
      await expect(
        createCrawlSource({
          listPage: page,
          detailPage: page,
          signal: new AbortController().signal,
          onDetailProgress: vi.fn(),
          log: vi.fn(),
        }).detail(listing),
      ).rejects.toMatchObject({
        name: "IncompleteDetailError",
        message: expect.stringContaining("身份"),
      });
    } finally {
      await page.close();
    }
  });
  it("悬停准备遇到多个匹配节点时停止，不能选择第一件商品继续读取", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        '<button onmouseover="window.inspected=true">角色甲</button><button onmouseover="window.inspected=true">角色乙</button>',
      );
      await expect(hoverForInspection(page, page.locator("button"))).rejects.toThrow("目标不唯一");
      expect(await page.evaluate(() => Reflect.get(window, "inspected"))).not.toBe(true);
    } finally {
      await page.close();
    }
  });
  it.each([
    ["scroll", false],
    ["scroll", true],
    ["visibility", false],
    ["visibility", true],
    ["handle", false],
    ["handle", true],
  ] as const)("原生悬停卡在 %s 阶段时核对命中目标，遮罩存在：%s", async (stage, covered) => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        '<button style="margin-top:1500px;width:120px;height:50px" onmouseover="window.inspected=event.isTrusted">测试物品</button>',
      );
      const target = page.locator("button");
      const recovered = vi.fn();
      const error = Object.assign(
        new Error(
          "locator.hover: Timeout 5000ms exceeded.\n" +
            (stage === "scroll"
              ? "  element is visible and stable\n  scrolling into view if needed"
              : stage === "handle"
                ? "  locator resolved to <button>测试物品</button>"
                : "  waiting for element to be visible and stable"),
        ),
        { name: "TimeoutError" },
      );
      vi.spyOn(target, "hover").mockImplementationOnce(async () => {
        if (covered)
          await page.evaluate(() => {
            const dialog = document.createElement("div");
            dialog.setAttribute("role", "dialog");
            dialog.style.cssText = "position:fixed;inset:0;background:white;z-index:9999";
            document.body.appendChild(dialog);
          });
        throw error;
      });
      if (covered) {
        await expect(hoverForInspection(page, target, recovered)).rejects.toBe(error);
        expect(recovered).not.toHaveBeenCalled();
        expect(
          await page.evaluate(() => (window as Window & { inspected?: boolean }).inspected),
        ).not.toBe(true);
      } else {
        await hoverForInspection(page, target, recovered);
        expect(recovered).toHaveBeenCalledOnce();
        expect(recovered).toHaveBeenCalledWith(stage);
        expect(
          await page.evaluate(() => (window as Window & { inspected?: boolean }).inspected),
        ).toBe(true);
      }
    } finally {
      await page.close();
    }
  });
  it.each(["price", "duplicate"] as const)("句柄恢复时%s改变仍拒绝读取商品", async (change) => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        `<style>a{display:block;width:240px;height:40px}</style><div id="soldList"><a class="soldImg" href="https://xyq.cbg.163.com/equip?s=1&eid=handle-fixture" data_price="100">目标</a></div><div id="pager_bar">第 1 页 共 1 页</div><script>window.QueryArgs={server_type:'3',page:1,order_by:'expire_time DESC'};</script>`,
      );
      const item = (await readListings(page)).items[0];
      const locate = page.locator.bind(page);
      const timeout = Object.assign(
        new Error("locator.hover: Timeout 5000ms exceeded.\n  locator resolved to <a>目标</a>"),
        { name: "TimeoutError" },
      );
      vi.spyOn(page, "locator").mockImplementation((selector, options) => {
        const target = locate(selector, options);
        if (selector.startsWith("#soldList a.soldImg:is("))
          vi.spyOn(target, "hover").mockImplementationOnce(async () => {
            await page.evaluate((change) => {
              const anchor = document.querySelector("#soldList a")!;
              if (change === "price") anchor.setAttribute("data_price", "200");
              else anchor.after(anchor.cloneNode(true));
            }, change);
            throw timeout;
          });
        return target;
      });
      const outcome = hoverListing(page, item, new AbortController().signal);
      if (change === "price") await expect(outcome).rejects.toBeInstanceOf(ListingChangedError);
      else await expect(outcome).rejects.toBe(timeout);
    } finally {
      await page.close();
    }
  });
  it.each([false, true])(
    "悬停前列表行消失：%s，按商品身份定位且区分目标消失",
    async (removeTarget) => {
      const page = await browser.newPage();
      page.setDefaultTimeout(300);
      await page.route("**/*", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<style>a{display:block;width:100px;height:30px}</style><div id="soldList">${Array.from({ length: 15 }, (_, index) => `<a class="soldImg" href="https://xyq.cbg.163.com/equip?s=1&eid=fixture-${index}" onmouseover="window.hovered='fixture-${index}'">角色${index}</a>`).join("")}</div><div id="pager_bar">第 1 页 共 1 页</div><script>window.QueryArgs={server_type:'3',page:1,order_by:'expire_time DESC'};</script>`,
        }),
      );
      try {
        await page.goto("https://xyq.cbg.163.com/cgi-bin/list-fixture.py", {
          timeout: 5000,
          waitUntil: "domcontentloaded",
        });
        const target = (await readListings(page)).items[13]!;
        const move = page.mouse.move.bind(page.mouse);
        vi.spyOn(page.mouse, "move").mockImplementationOnce(async (x, y) => {
          await page.evaluate(
            (index) => document.querySelectorAll("#soldList a")[index].remove(),
            removeTarget ? 13 : 0,
          );
          await move(x, y);
        });
        const outcome = hoverListing(page, target, new AbortController().signal);
        if (removeTarget)
          await expect(outcome).rejects.toMatchObject({ name: "ListingDisappearedError" });
        else {
          await expect(outcome).resolves.toMatchObject({ key: target.key });
          expect(await page.evaluate(() => (window as Window & { hovered?: string }).hovered)).toBe(
            target.eid,
          );
        }
      } finally {
        await page.close();
      }
    },
    15000,
  );
  it.each(["tracking", "replace"] as const)(
    "列表同一商品在滚动后变更追踪链接：%s，仍按服务器和eid悬停",
    async (mode) => {
      const page = await browser.newPage();
      page.setDefaultTimeout(500);
      try {
        await page.setContent(
          `<base href="https://xyq.cbg.163.com"><style>a{display:block;width:240px;height:40px}</style><h1>隔离回归：同一商品追踪链接变化</h1><div id="soldList">${[
            ["wrong-server", "?s=11&eid=fixture-13"],
            ["wrong-eid", "?s=1&eid=fixture-130"],
            ["target", "?s=1&eid=fixture-13&reco_request_id=before"],
          ]
            .map(
              ([id, query]) =>
                `<a id="${id}" class="soldImg" href="/equip${query}" onmouseover="window.hovered={id:this.id,trusted:event.isTrusted}">${id}</a>`,
            )
            .join(
              "",
            )}</div><div id="pager_bar">第 1 页 共 1 页</div><script>window.QueryArgs={server_type:'3',page:1,order_by:'expire_time DESC'};</script>`,
          { waitUntil: "domcontentloaded", timeout: 10000 },
        );
        const target = (await readListings(page)).items.find((row) => row.key === "1:fixture-13")!;
        await page.locator("#target").evaluate((el, mode) => {
          const scroll = el.scrollIntoView.bind(el);
          el.scrollIntoView = (options) => {
            scroll(options);
            const current = mode === "replace" ? (el.cloneNode(true) as Element) : el;
            current.setAttribute("href", "/equip?reco_request_id=after&eid=fixture-13&s=1#detail");
            if (current !== el) el.replaceWith(current);
          };
        }, mode);
        await expect(
          hoverListing(page, target, new AbortController().signal),
        ).resolves.toMatchObject({
          key: target.key,
        });
        expect(
          await page.evaluate(() => (window as Window & { hovered?: unknown }).hovered),
        ).toEqual({
          id: "target",
          trusted: true,
        });
        const directory = path.resolve("data/service-runtime/goal-round5-list-identity");
        await mkdir(directory, { recursive: true });
        await page.screenshot({ path: path.join(directory, `${mode}.png`) });
      } finally {
        await page.close();
      }
    },
    15000,
  );
  it.each([
    "reappear",
    "price",
    "time",
    "server",
    "captcha",
    "covered",
    "repeat",
    "disappear",
    "page",
    "order",
    "abort",
    "after-price",
    "after-time",
  ] as const)(
    "第六轮列表定位：短暂缺失后重现及保护边界 %s",
    async (mode) => {
      const page = await browser.newPage();
      const diagnostics = vi.fn();
      const control = new AbortController();
      if (mode === "abort")
        diagnostics.mockImplementation(() => control.abort(new Error("用户暂停采集")));
      let hoverCalls = 0;
      try {
        await page.setContent(
          `<base href="https://xyq.cbg.163.com"><style>body{font:18px sans-serif;padding:32px;background:#f4f6fa}a{display:block;width:300px;height:48px;margin:16px;background:#fff}#result{padding:20px;background:#fff3c4}</style><h1>隔离回归：列表目标短暂消失后重现</h1><p id="result">等待采集核对</p><div id="soldList"><a id="target" class="soldImg" href="/equip?s=421&eid=round6-target&reco_request_id=fixture&token=redact-me#secret-fragment" data_price="5684" data_selling_time="2026-10-24T03:25:36Z" onmouseover="window.hovered={key:'421:round6-target',trusted:event.isTrusted}">421:round6-target</a><a class="soldImg" href="/equip?s=4211&eid=round6-target">其他服务器</a><a class="soldImg" href="/equip?s=421&eid=round6-target-other">其他角色</a></div><div id="pager_bar">第 3 页 共 100 页</div><script>window.QueryArgs={server_type:'3',page:3,order_by:'expire_time DESC'};</script>`,
        );
        const target = (await readListings(page)).items.find(
          (row) => row.key === "421:round6-target",
        )!;
        const locator = page.locator.bind(page);
        vi.spyOn(page, "locator").mockImplementation((selector, options) => {
          const matches = locator(selector, options);
          if (!selector.startsWith("#soldList a.soldImg:is(")) return matches;
          const selected = matches;
          const hover = selected.hover.bind(selected);
          vi.spyOn(selected, "hover").mockImplementation(async (options) => {
            hoverCalls++;
            if (hoverCalls === 1 || mode === "repeat") {
              if (mode === "covered") {
                await page.evaluate(() => {
                  const cover = document.createElement("div");
                  cover.style.cssText = "position:fixed;inset:0;background:white;z-index:9999";
                  cover.setAttribute("role", "dialog");
                  document.body.appendChild(cover);
                });
                return hover({ ...options, timeout: 150 });
              }
              const html = await selected.evaluate((el) => el.outerHTML);
              await selected.evaluate((el) => el.remove());
              try {
                await hover({ ...options, timeout: mode === "reappear" ? 5000 : 120 });
              } catch (error) {
                await page.evaluate(
                  ({ html, mode }) => {
                    if (mode === "disappear") return;
                    document.querySelector("#soldList")!.insertAdjacentHTML("afterbegin", html);
                    const anchor = document.querySelector("#target")!;
                    if (mode === "price") anchor.setAttribute("data_price", "6000");
                    if (mode === "time")
                      anchor.setAttribute("data_selling_time", "2026-10-24T03:26:00Z");
                    if (mode === "server")
                      anchor.setAttribute("href", "/equip?s=422&eid=round6-target");
                    if (mode === "captcha")
                      (window as Window & { CaptchaCheck?: unknown }).CaptchaCheck = {
                        need_captcha: true,
                      };
                    const globals = window as Window & {
                      QueryArgs?: { page: number; order_by: string };
                    };
                    if (mode === "page") {
                      globals.QueryArgs!.page = 4;
                      document.querySelector("#pager_bar")!.textContent = "第 4 页 共 100 页";
                    }
                    if (mode === "order") globals.QueryArgs!.order_by = "selling_time DESC";
                    document.querySelector("#result")!.textContent =
                      "第一次定位超时后，同一角色重新出现在列表，等待有界重读";
                  },
                  { html, mode },
                );
                if (mode === "reappear") {
                  const directory = path.resolve("data/service-runtime/goal-round6-list-identity");
                  await mkdir(directory, { recursive: true });
                  await page.screenshot({ path: path.join(directory, "reappear-before.png") });
                }
                throw error;
              }
            }
            await hover(options);
            if (mode === "after-price" || mode === "after-time")
              await selected.evaluate((el, mode) => {
                el.setAttribute(
                  mode === "after-price" ? "data_price" : "data_selling_time",
                  mode === "after-price" ? "6000" : "2026-10-24T03:26:00Z",
                );
              }, mode);
          });
          return matches;
        });
        const outcome = hoverListing(page, target, control.signal, undefined, diagnostics);
        if (mode === "reappear") {
          await expect(outcome).resolves.toMatchObject({ key: target.key, price: "5684" });
          expect(hoverCalls).toBe(2);
          expect(diagnostics).toHaveBeenCalledWith(
            expect.objectContaining({
              event: "timeout",
              key: target.key,
              matches: 1,
              page: 3,
              retrying: true,
            }),
          );
          expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("redact-me");
          expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("secret-fragment");
          expect(
            await page.evaluate(() => (window as Window & { hovered?: unknown }).hovered),
          ).toEqual({
            key: target.key,
            trusted: true,
          });
          await page.locator("#result").evaluate((el) => {
            el.textContent = "重读后同身份、同价格、同上架时间，原生悬停成功；其他角色未被误采";
          });
          await page.screenshot({
            path: path.resolve("data/service-runtime/goal-round6-list-identity/reappear-after.png"),
          });
        } else {
          await expect(outcome).rejects.toMatchObject(
            mode === "price" ||
              mode === "time" ||
              mode === "page" ||
              mode === "order" ||
              mode === "after-price" ||
              mode === "after-time"
              ? { name: "ListingChangedError" }
              : mode === "server" || mode === "disappear"
                ? { name: "ListingDisappearedError" }
                : mode === "captcha"
                  ? { message: expect.stringContaining("安全验证") }
                  : mode === "abort"
                    ? { message: "用户暂停采集" }
                    : { name: "TimeoutError" },
          );
          const retried = ["repeat", "after-price", "after-time"].includes(mode);
          expect(hoverCalls).toBe(retried ? 2 : 1);
          if (!mode.startsWith("after-"))
            expect(
              await page.evaluate(() => (window as Window & { hovered?: unknown }).hovered),
            ).toBeUndefined();
        }
      } finally {
        await page.close();
      }
    },
    20000,
  );
  // 失败方式：共享详情页串号、读取失败未归还页面、每件都新开页而没有复用。
  it("并发角色使用独立详情页，完整读取后复用空闲页", async () => {
    const context = await browser.newContext();
    await context.route("**/*", (route) => {
      const id = new URL(route.request().url()).searchParams.get("eid")!;
      return route.fulfill({
        contentType: "text/html",
        body:
          fixture(false).replaceAll("新武器", `武器${id}`) +
          `<script>window.RoleData={id:${JSON.stringify(id)}};window.EquipInfo={serverId:"367",eid:${JSON.stringify(id)}}</script>`,
      });
    });
    vi.mocked(captureValuation).mockImplementation(async (page) => ({
      version: 1,
      fields: [],
      issues: [],
      source: await page.evaluate(
        () =>
          (window as unknown as Window & { EquipInfo: { serverId: string; eid: string } })
            .EquipInfo,
      ),
    }));
    try {
      const page = await context.newPage();
      const createDetailPage = vi.fn(() => context.newPage());
      const source = createCrawlSource({
        listPage: page,
        detailPage: page,
        createDetailPage,
        signal: new AbortController().signal,
        onDetailProgress: vi.fn(),
        log: vi.fn(),
      });
      const rows = ["one", "two", "three"].map((id) => ({
        ...listing,
        key: `367:${id}`,
        eid: id,
        url: `https://xyq.cbg.163.com/equip?s=367&eid=${id}`,
      }));
      const results = await Promise.all(rows.map((row) => source.detail(row)));
      for (const [index, result] of results.entries()) {
        expect(result.raw.RoleData).toEqual({ id: rows[index].eid });
        expect(result.tabs.find((tab) => tab.name === "道具/法宝")!.items![0].name).toBe(
          `武器${rows[index].eid}`,
        );
        expect(result.equipmentCapture?.complete).toBe(true);
      }
      expect(createDetailPage).toHaveBeenCalledTimes(2);
      await source.detail(rows[0]);
      expect(createDetailPage).toHaveBeenCalledTimes(2);
    } finally {
      await context.close();
      vi.mocked(captureValuation).mockImplementation(async () => ({
        version: 1,
        fields: [],
        issues: [],
        source: { serverId: "367", eid: "equipment-fixture" },
      }));
    }
  }, 30000);
  it("旧详情来源合法但属于其他商品时全量重采，不沿用错源师门技能", async () => {
    const page = await browser.newPage();
    try {
      await page.route("**/*", (route) =>
        route.fulfill({ contentType: "text/html", body: fixture(false) }),
      );
      const old = structuredClone(await collectDetail(page, listing, new AbortController().signal));
      old.valuation!.source.eid = "another-role";
      const oldSkills = old.tabs.find((tab) => tab.name === "技能")!.items!;
      oldSkills.forEach((skill, index) => {
        skill.name = `错源技能${index}`;
      });
      // Without the expected listing, the foreign identity is syntactically valid.
      expect(captureIssues(old, true)).toEqual([]);
      const source = createCrawlSource({
        listPage: page,
        detailPage: page,
        signal: new AbortController().signal,
        savedRecord: () => ({ listing, detail: old, status: "complete", error: null }),
        onDetailProgress: vi.fn(),
        log: vi.fn(),
      });
      const result = await source.detail(listing);
      expect(result.valuation!.source).toEqual({ serverId: "367", eid: "equipment-fixture" });
      const names = result.tabs
        .find((tab) => tab.name === "技能")!
        .items!.map((skill) => skill.name);
      expect(names).toHaveLength(7);
      expect(names.every((name) => name!.startsWith("测试技能"))).toBe(true);
      expect(names.some((name) => name!.startsWith("错源技能"))).toBe(false);
    } finally {
      await page.close();
    }
  }, 20000);
  it("采集始终读取所有标签、装备及宝宝，不受只分析裸号的设置影响", async () => {
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: fixture(false, completePet()),
      }),
    );
    try {
      const source = createCrawlSource({
        listPage: page,
        detailPage: page,
        signal: new AbortController().signal,
        onDetailProgress: () => {},
        log: () => {},
      });
      const result = await source.detail(listing);
      expect(result.captureMode).toBe("all");
      expect(result.equipmentCapture).toMatchObject({ complete: true, issues: [] });
      expect(result.petCapture).toMatchObject({ complete: true, issues: [] });
      expect(MAIN_TABS.every((name) => result.tabs.some((tab) => tab.name === name))).toBe(true);
      expect(result.tabs.find((tab) => tab.name === "道具/法宝")!.items!.length).toBeGreaterThan(0);
      expect(result.tabs.find((tab) => tab.name === "召唤兽/孩子")!.pets).toHaveLength(1);
    } finally {
      await page.close();
    }
  }, 20000);
  it.each([false, true])(
    "前四页已读后坐骑超时，单次保存部分资料；明确补采恢复：%s",
    async (recover) => {
      const page = await browser.newPage();
      const store = new CrawlStore(":memory:");
      let visits = 0;
      await page.route("**/*", async (route) => {
        if (route.request().isNavigationRequest()) visits++;
        await route.fulfill({
          contentType: "text/html",
          body: fixture(false, undefined, undefined, "", "等级 100"),
        });
      });
      const waitForLoadState = page.waitForLoadState.bind(page);
      vi.spyOn(page, "waitForLoadState").mockImplementation(async (...args) => {
        if (
          (await page.locator("#panel").innerText()).includes("坐骑：新资料") &&
          (!recover || visits === 1)
        )
          throw Object.assign(new Error("page.waitForLoadState: Timeout 15000ms exceeded. 坐骑"), {
            name: "TimeoutError",
          });
        return waitForLoadState(...args);
      });
      const source = createCrawlSource({
        listPage: page,
        detailPage: page,
        signal: new AbortController().signal,
        onDetailProgress: vi.fn(),
        log: vi.fn(),
      });
      try {
        store.observe(listing);
        if (recover) {
          const first = await source.detail(listing).catch((error: unknown) => error);
          expect(first).toBeInstanceOf(IncompleteCaptureError);
          expect(visits).toBe(1);
          const result = await source.detail(listing);
          expect(visits).toBe(2);
          expect(captureIssues(result, true, true, listing)).toEqual([]);
          expect(result.tabs.map((tab) => tab.name)).toEqual(expect.arrayContaining(MAIN_TABS));
          expect(store.save(listing, result)).toBe(true);
          expect(store.count()).toBe(1);
        } else {
          const error = await source.detail(listing).catch((error: unknown) => error);
          expect(error).toBeInstanceOf(IncompleteCaptureError);
          expect(visits).toBe(1);
          const failed = error as IncompleteCaptureError;
          expect(failed.message).toContain("坐骑");
          expect(failed.detail.tabs.map((tab) => tab.name)).toEqual(MAIN_TABS.slice(0, 4));
          expect(failed.detail.tabs[1].items).toHaveLength(7);
          expect(failed.detail.tabs[2].items![0].description).toContain("伤害 +420");
          expect(store.save(listing, failed.detail)).toBe(false);
          expect(store.count()).toBe(0);
          expect(store.checkpoint()).toBeUndefined();
          expect(store.detail(listing.key)).toMatchObject({
            status: "failed",
            detail: { tabs: expect.arrayContaining([expect.objectContaining({ name: "技能" })]) },
          });
          const dir = path.resolve("artifacts/partial-capture-regression");
          await mkdir(dir, { recursive: true });
          await page.screenshot({
            path: path.join(dir, "mount-timeout-partial-preserved.png"),
            fullPage: true,
          });
          await writeFile(
            path.join(dir, "partial-evidence.json"),
            JSON.stringify(
              {
                simulatedFailure: true,
                attempts: visits,
                error: failed.message,
                savedStatus: "failed",
                tabs: failed.detail.tabs.map((tab) => ({
                  name: tab.name,
                  items: tab.items?.length || 0,
                })),
                publishedProducts: store.count(),
                checkpoint: store.checkpoint() || null,
              },
              null,
              2,
            ),
          );
        }
      } finally {
        store.close();
        await page.close();
      }
    },
    30000,
  );
  it("首次缺武器属性只保存一次，明确补采读全后才返回完成", async () => {
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
      const first = await source.detail(listing).catch((error: unknown) => error);
      expect(first).toBeInstanceOf(IncompleteCaptureError);
      expect(visits).toBe(1);
      const result = await source.detail(listing);
      expect(visits).toBe(2);
      expect(result.equipmentCapture).toMatchObject({ complete: true, issues: [] });
      expect(result.petCapture).toMatchObject({ complete: true, issues: [] });
      expect(result.tabs.find((tab) => tab.name === "道具/法宝")!.items![0].description).toContain(
        "伤害 +420",
      );
      expect(progress.some((message) => message.includes("本轮内自动重读"))).toBe(false);
    } finally {
      await page.close();
    }
  }, 20000);
  it.each([
    {
      label: "名称尾部空格",
      name: "新武器 ",
      tooltip: "新武器\n等级 100\n伤害 +420",
      complete: true,
    },
    {
      label: "名称首尾空白",
      name: "　新武器\t ",
      tooltip: "新武器\n等级 100\n伤害 +420",
      complete: true,
    },
    {
      label: "不同物品名称",
      name: "新武器 ",
      tooltip: "另一把武器\n等级 100\n伤害 +420",
      complete: false,
    },
    { label: "相同名称缺属性", name: "新武器 ", tooltip: "新武器\n等级 100", complete: false },
  ])(
    "提示框名称首尾空白匹配边界：$label",
    async ({ name, tooltip, complete }) => {
      const page = await browser.newPage();
      const gear = `<div id="RoleEquip"><img width="40" height="40" data_kindid="999" data_equip_name="${name}" data_equip_desc="等级 100" data_equip_category="武器" data_tip_box="WhitespaceTipsBox" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" onmouseover="document.getElementById('WhitespaceTipsBox').style.display='block'"><div id="WhitespaceTipsBox" style="display:none;white-space:pre-line">${tooltip}</div></div>`;
      await page.route(url, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: fixture(false, undefined, undefined, "", "", gear),
        }),
      );
      try {
        const detail = await collectDetail(page, listing, new AbortController().signal);
        expect(detail.equipmentCapture?.complete).toBe(complete);
        const captured = detail.tabs.find((entry) => entry.name === "道具/法宝")!.items![0];
        expect(captured.name).toBe(name);
        expect(captured.description).toContain(tooltip.split("\n").slice(1).join("\n"));
        if (complete) expect(detail.equipmentCapture?.issues).toEqual([]);
        else
          expect(
            detail.equipmentCapture?.issues.some((issue) => issue.includes("提示框未完整显示")),
          ).toBe(true);
      } finally {
        await page.close();
      }
    },
    15000,
  );
  it.each([
    [false, true],
    [true, true],
    [true, false],
  ])(
    "宝宝饰品缺名称，部分描述：%s，完整提示：%s",
    async (partialDescription, completeTooltip) => {
      const page = await browser.newPage();
      const pet = completePet()
        .replace("装备（1）", "装备（2）")
        .replace(
          "<p>内丹（1）</p>",
          `<div id="RolePetShipin" data_idx="0" data_tip_box="PetAccessoryTipsBox" ${partialDescription ? 'data_equip_desc="装备对象：雷龙"' : ""}><img width="30" height="30" src="/images/pet_shipin/small/1.gif" onmouseover="${completeTooltip ? "document.getElementById('PetAccessoryTipsBox').style.display='block'" : ""}" onmouseout="document.getElementById('PetAccessoryTipsBox').style.display='none'"></div><div id="PetAccessoryTipsBox" style="display:none">雷龙饰品<br>装备对象：雷龙<br>完整的外观说明</div><p>内丹（1）</p>`,
        );
      await page.route("**/*", (route) =>
        route.fulfill({ contentType: "text/html", body: fixture(false, pet) }),
      );
      try {
        const result = await collectDetail(page, listing, new AbortController().signal);
        expect(result.petCapture?.complete).toBe(completeTooltip);
        if (completeTooltip) {
          expect(result.petCapture?.issues).toEqual([]);
          const captured = result.tabs.find((tab) => tab.name === "召唤兽/孩子")!.pets![0];
          expect(captured.equipment).toHaveLength(2);
          expect(captured.equipment[1]).toMatchObject({
            name: "雷龙饰品",
            location: "RolePetShipin",
          });
        } else expect(result.petCapture?.issues.length).toBeGreaterThan(0);
      } finally {
        await page.close();
      }
    },
    15000,
  );
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
      const result = await collectDetail(page, listing, new AbortController().signal);
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
      const detail = await collectDetail(page, listing, new AbortController().signal);
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
      const incomplete = await collectDetail(page, listing, new AbortController().signal);
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
      const captured = await collectDetail(page, listing, new AbortController().signal);
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

  it("人物装备为空但随身有宝宝装备时，以可见容器及已读装备对象确认完整", async () => {
    const page = await browser.newPage();
    try {
      const body =
        '<p>现金：100</p><table id="RoleUsingEquips"><tr><td></td></tr></table><table id="RoleStoreEquips"><tr><td><img width="40" height="40" data_equip_name="嵌宝金环" data_equip_type="9210" data_equip_desc="等级 95#r速度 +24#r耐久 500" data_equip_type_desc="【装备对象】召唤兽#r【装备条件】等级95"></td></tr></table>';
      await page.route(url, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: fixture(false, undefined, undefined, "", "", body),
        }),
      );
      const captured = await collectDetail(page, listing, new AbortController().signal);
      expect(captured.equipmentCapture).toMatchObject({
        complete: true,
        emptyProof: "official-containers",
        issues: [],
      });
      expect(captured.tabs.find((tab) => tab.name === "道具/法宝")?.items?.[0]).toMatchObject({
        name: "嵌宝金环",
        attributes: { 装备对象: "召唤兽" },
      });
    } finally {
      await page.close();
    }
  });

  it.each(["parent", "grandparent", "unknown-icon"])(
    "宝宝装备属性在%s时，空人物库存证据与实际读取物品一致",
    async (kind) => {
      const page = await browser.newPage();
      try {
        const attributes =
          'data_equip_name="琅琊衣" data_equip_type="9235" data_equip_desc="等级 105#r防御 +15#r耐久 385" data_equip_type_desc="【装备对象】召唤兽#r【装备条件】等级105"';
        const image = '<img width="40" height="40">';
        const icon =
          kind === "grandparent"
            ? `<td ${attributes}><a>${image}</a></td>`
            : `<td><a ${attributes}>${image}</a></td>`;
        const body = `<p>现金：100</p><table id="RoleUsingEquips"><tr><td></td></tr></table><table id="RoleStoreEquips"><tr>${icon}${kind === "unknown-icon" ? '<td><img width="40" height="40"></td>' : ""}</tr></table>`;
        await page.route(url, (route) =>
          route.fulfill({
            contentType: "text/html",
            body: fixture(false, undefined, undefined, "", "", body),
          }),
        );
        const captured = await collectDetail(page, listing, new AbortController().signal);
        const inventory = captured.tabs.find((tab) => tab.name === "道具/法宝")!;
        expect(inventory.items?.[0]).toMatchObject({
          name: "琅琊衣",
          modelId: "9235",
          attributes: { 装备对象: "召唤兽" },
        });
        if (kind === "unknown-icon") {
          expect(captured.equipmentCapture?.complete).toBe(false);
          expect(captured.equipmentCapture?.emptyProof).toBeUndefined();
          expect(captured.equipmentCapture?.issues.join(" ")).toContain("库存是否为空尚未核对");
        } else {
          expect(captured.equipmentCapture).toMatchObject({
            complete: true,
            emptyProof: "official-containers",
            issues: [],
          });
          expect(
            inventory.equipmentContainers
              ?.flatMap((container) => container.icons)
              .every((icon) => icon.name === "琅琊衣" && icon.modelId === "9235"),
          ).toBe(true);
        }
      } finally {
        await page.close();
      }
    },
    15000,
  );

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
      const detail = await collectDetail(page, listing, new AbortController().signal);
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
  it("官网4103内丹只有技能说明时完整采集，不要求人物装备等级和数值", async () => {
    const page = await browser.newPage();
    try {
      const innerdan =
        '<img width="40" height="40" data_equip_name="高级召唤兽内丹" data_equip_type="4103" data_equip_desc="所带内丹技能：血债偿#r本方召唤兽被击飞时提升法术伤害">';
      await page.route(url, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: fixture(false, undefined, undefined, innerdan),
        }),
      );
      const detail = await collectDetail(page, listing, new AbortController().signal);
      expect(detail.equipmentCapture).toMatchObject({ complete: true, issues: [] });
      const items = detail.tabs.find((tab) => tab.name === "道具/法宝")!.items!;
      expect(items[1]).toMatchObject({
        name: "高级召唤兽内丹",
        modelId: "4103",
        category: "道具 · 召唤兽内丹",
      });
      expect(items[1].description).toContain("血债偿");
    } finally {
      await page.close();
    }
  }, 15000);

  // 失败方式：材料被当作装备要求属性或悬停；普通装备因此被一并跳过。
  it("制造指南书、点化石等材料无需装备属性，仍完整读取同页的普通装备", async () => {
    const page = await browser.newPage();
    try {
      await page.route(url, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: fixture(
            false,
            undefined,
            undefined,
            '<img width="40" height="40" data_equip_name="钟灵石" data_equip_type="50344"><img width="40" height="40" data_equip_name="百炼精铁" data_equip_type="4001" data_equip_desc="等级 150"><img width="40" height="40" data_equip_name="制造指南书" data_equip_type="612" data_equip_desc="制造指南书#r种类：头盔#r可制造等级：150"><img width="40" height="40" data_equip_name="点化石" data_equip_type="4034" data_equip_desc="附加技能：高级幸运" data_tip_box="MissingStoneTipsBox">',
          ),
        }),
      );
      const detail = await collectDetail(page, listing, new AbortController().signal);
      expect(detail.equipmentCapture).toMatchObject({ complete: true, issues: [] });
      const items = detail.tabs.find((entry) => entry.name === "道具/法宝")!.items!;
      expect(items[0].description).toContain("伤害 +420");
      expect(items.slice(1).map((item) => item.category)).toEqual([
        "材料 · 钟灵石",
        "材料 · 百炼精铁",
        "材料 · 制造指南书",
        "材料 · 点化石",
      ]);
      expect(items[2].description).toBe("等级 150");
      expect(items[3].description).toContain("可制造等级：150");
      expect(items[4].description).toBe("附加技能：高级幸运");
    } finally {
      await page.close();
    }
  }, 15000);

  it("4002太阳石保留原等级且不等待不存在的装备提示框，同页武器仍读取完整属性", async () => {
    const page = await browser.newPage();
    try {
      const stones = ["saved-stone-one", "saved-stone-two"]
        .map(
          (location) =>
            `<img width="40" height="40" data_equip_name="太阳石" data_equip_type="4002" data_equip_location="${location}" data_equip_desc="等级 6  " data_tip_box="MissingSunStoneTipsBox">`,
        )
        .join("");
      await page.route(url, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: fixture(false, undefined, undefined, stones),
        }),
      );
      const detail = await collectDetail(page, listing, new AbortController().signal);
      expect(detail.equipmentCapture).toMatchObject({ complete: true, issues: [] });
      const items = detail.tabs.find((entry) => entry.name === "道具/法宝")!.items!;
      expect(items[0].description).toContain("伤害 +420");
      expect(items.slice(1)).toEqual([
        expect.objectContaining({
          name: "太阳石",
          modelId: "4002",
          category: "材料 · 太阳石",
          description: "等级 6",
          location: "saved-stone-one",
        }),
        expect.objectContaining({
          name: "太阳石",
          modelId: "4002",
          category: "材料 · 太阳石",
          description: "等级 6",
          location: "saved-stone-two",
        }),
      ]);
      expect(
        equipmentInventory({ listing, detail, status: "complete", error: null }).items.map(
          (item) => item.name,
        ),
      ).toEqual(["新武器"]);
    } finally {
      await page.close();
    }
  }, 15000);

  it("同名未核对型号的太阳石和缺等级武器仍保留采集失败，不能按4002材料跳过", async () => {
    const page = await browser.newPage();
    try {
      const unknowns =
        '<img width="40" height="40" data_equip_name="太阳石" data_equip_type="4003" data_equip_desc="等级 6" data_tip_box="MissingUnknownStoneTipsBox"><img width="40" height="40" data_equip_name="未知武器" data_equip_type="31301" data_equip_desc="伤害 +750" data_tip_box="MissingUnknownWeaponTipsBox">';
      await page.route(url, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: fixture(false, undefined, undefined, unknowns),
        }),
      );
      const detail = await collectDetail(page, listing, new AbortController().signal);
      expect(detail.equipmentCapture?.complete).toBe(false);
      expect(detail.equipmentCapture?.issues.join("；")).toContain("太阳石 的装备属性未完整读取");
      expect(detail.equipmentCapture?.issues.join("；")).toContain("未知武器 的装备等级未完整读取");
      const weapon = detail.tabs
        .find((entry) => entry.name === "道具/法宝")!
        .items!.find((item) => item.modelId === "31301")!;
      expect(weapon.description).toBe("伤害 +750");
      expect(weapon.attributes?.等级).toBeUndefined();
    } finally {
      await page.close();
    }
  }, 15000);

  it.each([
    "named-zero",
    "unnamed-zero",
    "unnamed-agility-zero",
    "wrong-role",
    "missing-level",
    "decode-throws",
    "parser-throws",
    "malformed-raw",
  ])(
    "原始穿戴等级按同商品槽位型号和描述绑定，属性首行不能成为名称：%s",
    async (mode) => {
      const page = await browser.newPage();
      try {
        const description = "五行 土#r伤害 +15 命中 +20#r耐久度 100#Y  ";
        const name = mode.startsWith("unnamed-") ? "" : "模拟已核对武器";
        const firstLine = mode === "unnamed-agility-zero" ? "敏捷 +15" : "五行 土";
        const tooltip = [name, firstLine, "伤害 +15 命中 +20", "耐久度 100"]
          .filter(Boolean)
          .join("\n");
        const gear = `<div id="RoleEquip"><img width="40" height="40" data_equip_name="${name}" data_equip_type="31301" data_equip_location="role_using_equip_6" data_equip_desc="${description}" data_tip_box="WornRawTipsBox" onmouseover="document.getElementById('WornRawTipsBox').style.display='block'"><div id="WornRawTipsBox" style="display:none;white-space:pre-line">${tooltip}</div></div>`;
        const raw = {
          AllEquip: {
            6: {
              iType: 31301,
              cDesc: description,
              ...(mode === "missing-level" ? {} : { obj_level: 0 }),
            },
          },
        };
        const html =
          fixture(false, undefined, undefined, "", "", gear) +
          `<textarea id="equip_desc_value" hidden>isolated-raw-fixture</textarea><script>window.EquipInfo=${JSON.stringify({ server_id: mode === "wrong-role" ? "750" : listing.serverId, eid: listing.eid })};window.decode_desc=()=>{${mode === "decode-throws" ? 'throw new Error("isolated decode failure")' : 'return "isolated raw"'}};window.RoleInfoParser=class {constructor(){${mode === "parser-throws" ? 'throw new Error("isolated parser failure")' : `this.raw_info=${mode === "malformed-raw" ? "null" : JSON.stringify(raw)}`}}};</script>`;
        await page.route(url, (route) => route.fulfill({ contentType: "text/html", body: html }));
        const detail = await collectDetail(page, listing, new AbortController().signal);
        const item = detail.tabs.find((entry) => entry.name === "道具/法宝")!.items![0];
        if (mode === "named-zero") {
          expect(detail.equipmentCapture).toMatchObject({ complete: true, issues: [] });
          expect(item).toMatchObject({
            name,
            attributes: { 等级: "0" },
            modelId: "31301",
            location: "role_using_equip_6",
          });
        } else {
          expect(detail.equipmentCapture?.complete).toBe(false);
          if (mode.startsWith("unnamed-")) {
            expect(item.attributes?.等级).toBe("0");
            expect(item.name).not.toBe(firstLine);
            expect(detail.equipmentCapture?.issues.join("；")).toContain("装备名称未完整读取");
          } else {
            expect(item.attributes?.等级).toBeUndefined();
            expect(detail.equipmentCapture?.issues.join("；")).toContain("装备等级未完整读取");
          }
        }
      } finally {
        await page.close();
      }
    },
    15000,
  );

  it("旧版本资料重新采集时只发布新装备和宝宝，不混用历史快照", async () => {
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
      const detail = await createCrawlSource({
        listPage: page,
        detailPage: page,
        signal: new AbortController().signal,
        savedRecord: () => ({ listing, detail: saved, status: "complete", error: null }),
        onDetailProgress: vi.fn(),
        log: vi.fn(),
      }).detail(listing);
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
        const detail = await collectDetail(page, listing, new AbortController().signal);
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
        const detail = await collectDetail(page, listing, new AbortController().signal);
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
      const detail = await collectDetail(page, listing, new AbortController().signal);
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
      const detail = await collectDetail(page, listing, new AbortController().signal);
      const items = detail.tabs.find((tab) => tab.name === "道具/法宝")!.items!;
      expect(items.map((item) => item.category)).toEqual(["武器", "法宝", "神器", "灵宝"]);
      expect(items[0].description).toContain("伤害 +420");
      expect(detail.equipmentCapture?.complete).toBe(true);
      expect(detail.equipmentCapture?.issues).toEqual([]);
    } finally {
      await page.close();
    }
  }, 15000);
  it("没有宝宝总数时记录未知，不能假定零只", async () => {
    const page = await browser.newPage();
    try {
      await page.route(url, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: fixture(false, "<p>召唤兽资料正在读取</p>"),
        }),
      );
      const detail = await collectDetail(page, listing, new AbortController().signal);
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
      const detail = await collectDetail(page, listing, new AbortController().signal);
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
    const report = vi.fn();
    try {
      const body = completePet()
        .replace("技能（2）", "技能（3）")
        .replace('data_equip_name="死亡召唤"', "");
      await page.route(url, (route) =>
        route.fulfill({ contentType: "text/html", body: fixture(false, body) }),
      );
      const detail = await collectDetail(page, listing, new AbortController().signal, report);
      expect(detail.petCapture?.complete).toBe(false);
      expect(detail.petCapture?.issues).toEqual(
        expect.arrayContaining([
          "第 1 只召唤兽技能图标未完整读取",
          "第 1 只召唤兽技能数量与页面不一致",
        ]),
      );
      const diagnostic = report.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.startsWith("召唤兽图标核对异常："));
      expect(JSON.parse(diagnostic!.slice("召唤兽图标核对异常：".length))).toMatchObject({
        pet: 1,
        section: "skills",
        expected: 2,
        captured: 1,
        icons: [{ name: "鬼魂术" }, { name: "" }],
        capturedItems: [{ name: "鬼魂术" }],
      });
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
      const detail = await collectDetail(page, listing, new AbortController().signal);
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
      const detail = await collectDetail(page, listing, new AbortController().signal);
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
