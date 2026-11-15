import { afterAll, beforeAll, expect, it, vi } from "vite-plus/test";
import { chromium, type Browser } from "playwright-core";
import { collectDetail, MAIN_TABS } from "./detail";
import { captureValuation } from "./valuation-capture";
import { assertDetailRoot, evaluateDetailRoot, retainDetailRoot } from "./detail-root";
import { IncompleteCaptureError } from "./capture-readiness";
import type { Listing } from "./types";

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
  eid: "root-role",
  key: "367:root-role",
  url: "https://xyq.cbg.163.com/equip?s=367&eid=root-role",
  attrs: {},
  summary: null,
} as Listing;
const pixel = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const skillNames = ["甲", "乙", "丙", "丁", "戊", "己", "庚"].map((name) => "实际师门" + name);
const panels: Record<string, string> = {
  "人物/修炼": "<p>名称：实际人物</p><p>等级：175</p><p>攻击修炼：20/20</p>",
  技能:
    "<p>师门技能</p>" +
    skillNames
      .map(
        (name) =>
          `<img width="20" height="20" src="${pixel}" data_skill_type="school_skill" data_equip_name="${name}" data_equip_level="150">`,
      )
      .join(""),
  "道具/法宝": `<div id="RoleUsingEquips"><img width="20" height="20" src="${pixel}" data_equip_name="实际武器" data_equip_category="武器" data_tip_box="RoleEquipTipsBox" onmouseover="const tip=this.closest('section').querySelector('[id=RoleEquipTipsBox]');tip.innerText='实际武器\\n等级 100\\n伤害 +420';tip.style.display='block'"></div><div id="RoleStoreEquips"></div>`,
  "召唤兽/孩子": `<p>召唤兽(1/10)</p><img width="20" height="20" src="/pets/small/1.gif" data_idx="0"><section><p>详细信息</p><p>名称：实际宝宝</p><p>类型：幽灵</p><p>等级：0</p><p>成长：1.23</p>${["攻击资质", "防御资质", "体力资质", "法力资质", "速度资质", "躲闪资质"].map((name) => `<p>${name}：1400</p>`).join("")}<p>技能（1）</p><img width="20" height="20" src="${pixel}" data_skill_type="cifu" data_equip_name="实际宝宝技能"><p>装备（1）</p><img width="20" height="20" src="${pixel}" data_equip_name="实际宝宝项圈" data_equip_desc="等级 80#r速度 +20"><p>内丹（0）</p></section><p>孩子</p><ul class="child_list"><li data-child-id="1" onclick="window.actualChildClicks++">实际孩子</li></ul>`,
  坐骑: `<div id="RoleRiders"><img width="20" height="20" src="${pixel}" data_idx="1" onclick="window.actualMountClicks++"></div><p>坐骑成长：2.3</p>`,
  "锦衣/外观": "<p>锦衣：实际锦衣</p>",
  玩家之家: "<p>房屋：实际豪宅</p>",
};
function documentFixture(decoys = true) {
  return `<meta charset="utf-8"><script>window.IsLogin=1;window.EquipInfo={server_id:367,eid:'root-role'};window.actualMountClicks=0;window.actualChildClicks=0;window.decoyClicks=0;window.parserInputs=[];window.decode_desc=x=>x;window.RoleInfoParser=class{constructor(value){window.parserInputs.push(value);if(value!=='actual-encoded')throw new Error('wrong-source');this.raw_info={AllRider:{one:{iGrow:230,exgrow:0,mattrib:'力量'}},jinjie_rider_info:{isJinJie:0},all_skills:{230:40,237:20},i3FlyLv:0,iCash:5,iSaving:6,iLearnCash:7,xianyu:8};this.result={shenqi:false,basic_info:{is_gold_id:false}}}};
  window.panels=${JSON.stringify(panels)};window.show=name=>document.querySelector('#actual-panel').innerHTML=panels[name];</script>
    ${decoys ? `<aside><textarea id="equip_desc_value" hidden>poison-encoded</textarea>${MAIN_TABS.map((name) => `<button onclick="window.decoyClicks++">${name}</button>`).join("")}<div id="RoleRiders"><img src="${pixel}" data_idx="99" onclick="window.decoyClicks++"></div><div class="child_list"><li data-child-id="99" onclick="window.decoyClicks++">诱饵孩子</li></div><div id="RoleEquipTipsBox">实际武器\n等级 100\n伤害 +999</div><p>价格：￥999999</p><p>召唤兽(20/20)</p></aside>` : ""}
  <section id="actual-detail"><header>价格：￥1234</header><nav>${MAIN_TABS.map((name) => `<button onclick="show('${name}')">${name}</button>`).join("")}</nav><article id="actual-panel">${panels["人物/修炼"]}</article><div id="RoleEquipTipsBox" style="display:none"></div><textarea id="equip_desc_value" hidden>actual-encoded</textarea></section>`;
}

it("collects real valuation, role, skills, equipment and pets inside the retained scope while ignoring external decoys and duplicate IDs", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/*", (route) =>
      new URL(route.request().url()).pathname === "/equip"
        ? route.fulfill({ contentType: "text/html", body: documentFixture() })
        : route.fulfill({ body: "" }),
    );
    const detail = await collectDetail(page, listing, new AbortController().signal);
    expect(detail.tabs.find((tab) => tab.name === "人物/修炼")?.text).toContain("实际人物");
    expect(detail.tabs.find((tab) => tab.name === "技能")?.items?.map((item) => item.name)).toEqual(
      skillNames,
    );
    expect(
      detail.tabs.find((tab) => tab.name === "道具/法宝")?.items?.map((item) => item.name),
    ).toEqual(["实际武器"]);
    expect(detail.tabs.find((tab) => tab.name === "道具/法宝")?.items?.[0].description).toContain(
      "伤害 +420",
    );
    expect(detail.petCapture?.complete).toBe(true);
    expect(detail.tabs.find((tab) => tab.name === "召唤兽/孩子")?.pets?.[0]).toMatchObject({
      name: "实际宝宝",
      skills: [{ name: "实际宝宝技能", skillObservation: { section: "技能", state: "current" } }],
      equipment: [{ name: "实际宝宝项圈" }],
    });
    expect(detail.valuation?.source).toMatchObject({
      askingPrice: "1234",
      serverId: "367",
      eid: "root-role",
      allSkills: { 230: 40, 237: 20 },
    });
    expect(detail.valuation?.fields).toEqual(
      expect.arrayContaining([
        { name: "坐骑1成长", value: "2.3", tab: "坐骑" },
        { name: "现金", value: "5", tab: "道具/法宝" },
      ]),
    );
    expect(detail.valuation?.issues).toEqual([]);
    expect(detail.raw.encodedRoleData).toBe("actual-encoded");
    expect(
      await page.evaluate(() => ({
        decoy: Reflect.get(window, "decoyClicks"),
        mounts: Reflect.get(window, "actualMountClicks"),
        children: Reflect.get(window, "actualChildClicks"),
        sources: Reflect.get(window, "parserInputs"),
        marked: document.querySelectorAll(
          "[data-cbg-detail-root],[data-cbg-inspect-index],[data-cbg-pet-index],[data-cbg-pet-item],[data_cbg_skill_section]",
        ).length,
      })),
    ).toEqual({
      decoy: 0,
      mounts: 1,
      children: 1,
      sources: ["actual-encoded", "actual-encoded"],
      marked: 0,
    });
  } finally {
    await page.close();
  }
}, 30000);

it.each(["div", "ul"])(
  "keeps a %s tab bar and its independent real panel inside one detail root",
  async (tag) => {
    const page = await browser.newPage();
    try {
      const html = documentFixture(false).replace(/<nav>(.*?)<\/nav>/, (_match, buttons: string) =>
        tag === "ul"
          ? `<ul>${buttons.replaceAll("<button ", "<li ").replaceAll("</button>", "</li>")}</ul>`
          : `<div>${buttons}</div>`,
      );
      await page.route("**/*", (route) =>
        new URL(route.request().url()).pathname === "/equip"
          ? route.fulfill({ contentType: "text/html", body: html })
          : route.fulfill({ body: "" }),
      );
      const detail = await collectDetail(page, listing, new AbortController().signal);
      expect(detail.tabs.find((tab) => tab.name === "人物/修炼")?.text).toContain("实际人物");
      expect(detail.tabs.find((tab) => tab.name === "技能")?.items).toHaveLength(7);
      expect(detail.tabs.find((tab) => tab.name === "道具/法宝")?.items?.[0].name).toBe("实际武器");
      expect(detail.valuation?.source.askingPrice).toBe("1234");
      expect(detail.petCapture?.complete).toBe(true);
    } finally {
      await page.close();
    }
  },
  30000,
);

it.each(["parser", "decode", "raw-null", "raw-getter", "result-getter"])(
  "preserves seven completed tabs and the cause when the final %s is replaced with a throwing function",
  async (kind) => {
    const page = await browser.newPage();
    try {
      await page.route("**/*", (route) =>
        new URL(route.request().url()).pathname === "/equip"
          ? route.fulfill({ contentType: "text/html", body: documentFixture(false) })
          : route.fulfill({ body: "" }),
      );
      let replacing: Promise<void> | undefined;
      const error = await collectDetail(page, listing, new AbortController().signal, (message) => {
        if (message === "全部标签读取完成，正在保存详情…")
          replacing = page.evaluate((kind) => {
            const globals = window as unknown as Record<string, unknown>;
            if (kind === "parser")
              globals.RoleInfoParser = class {
                constructor() {
                  throw new TypeError("fixture final parser failed");
                }
              };
            else if (kind === "decode")
              globals.decode_desc = () => {
                throw new TypeError("fixture final decode failed");
              };
            else
              globals.RoleInfoParser = class {
                raw_info =
                  kind === "raw-null"
                    ? null
                    : Object.defineProperty({}, "all_skills", {
                        get() {
                          if (kind === "raw-getter")
                            throw new TypeError("fixture final raw-getter failed");
                          return {};
                        },
                      });
                get result() {
                  throw new TypeError("fixture final result-getter failed");
                }
              };
          }, kind);
      }).catch((failure: unknown) => failure);
      await replacing;
      expect(error).toBeInstanceOf(IncompleteCaptureError);
      expect(
        (error as IncompleteCaptureError).detail.tabs
          .filter((tab) => MAIN_TABS.includes(tab.name))
          .map((tab) => tab.name),
      ).toEqual([...MAIN_TABS]);
      expect((error as IncompleteCaptureError).cause).toMatchObject({
        name: "IncompleteDetailError",
        cause: {
          name: "TypeError",
          message: kind === "raw-null" ? "角色原文结构无效" : `fixture final ${kind} failed`,
        },
      });
    } finally {
      await page.close();
    }
  },
  30000,
);

it.each(["root-replaced", "navigation", "navigation-same-url", "source-replaced"])(
  "fails a changed retained %s without rebinding",
  async (scenario) => {
    const page = await browser.newPage();
    try {
      await page.route("**/*", (route) =>
        route.fulfill({ contentType: "text/html", body: documentFixture(false) }),
      );
      await page.goto(listing.url);
      await retainDetailRoot(page);
      if (scenario.startsWith("navigation"))
        await page.goto(listing.url + (scenario === "navigation" ? "&navigation=1" : ""));
      else
        await page.evaluate((scenario) => {
          const element = document.querySelector(
            scenario === "root-replaced" ? "#actual-detail" : "#equip_desc_value",
          )!;
          element.replaceWith(element.cloneNode(true));
        }, scenario);
      await expect(assertDetailRoot(page)).rejects.toMatchObject({ name: "IncompleteDetailError" });
    } finally {
      await page.close();
    }
  },
);

it("preserves completed tabs as partial when the root is replaced during collection", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body:
          documentFixture(false).replace("window.show=name=>", "window.originalShow=name=>") +
          `<script>window.show=name=>{originalShow(name);if(name==='技能'){const root=document.querySelector('#actual-detail');root.replaceWith(root.cloneNode(true))}}</script>`,
      }),
    );
    const error = await collectDetail(page, listing, new AbortController().signal).catch(
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(IncompleteCaptureError);
    expect((error as IncompleteCaptureError).detail.tabs.map((tab) => tab.name)).toEqual([
      "人物/修炼",
    ]);
  } finally {
    await page.close();
  }
}, 15000);

it.each([
  "body-only",
  "duplicate-root",
  "duplicate-source",
  "outside-duplicate-source",
  "outside-identity-conflict",
])("rejects or leaves incomplete %s scopes", async (scenario) => {
  const page = await browser.newPage();
  try {
    await page.setContent(documentFixture(false));
    await page.evaluate((scenario) => {
      const root = document.querySelector("#actual-detail")!;
      if (scenario === "body-only") root.replaceWith(...root.childNodes);
      if (scenario === "duplicate-root") root.after(root.cloneNode(true));
      if (scenario === "duplicate-source")
        root.appendChild(root.querySelector("textarea")!.cloneNode(true));
      if (scenario === "outside-duplicate-source") {
        const source = root.querySelector("textarea")!;
        document.body.append(source, source.cloneNode(true));
      }
      if (scenario === "outside-identity-conflict") {
        document.body.appendChild(root.querySelector("textarea")!);
        Reflect.set(window, "equip", { server_id: 999, eid: "conflicting-role" });
      }
    }, scenario);
    if (scenario === "outside-identity-conflict") {
      await retainDetailRoot(page);
      const capture = await captureValuation(page);
      expect(capture.issues.join(";")).toContain("身份");
      expect(capture.source).toEqual({});
    } else
      await expect(retainDetailRoot(page)).rejects.toMatchObject({
        name: "IncompleteDetailError",
      });
  } finally {
    await page.close();
  }
});

it("binding and a read leave the page markup unchanged", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(documentFixture(false));
    const before = await page.content();
    await retainDetailRoot(page);
    expect(
      await evaluateDetailRoot(
        page,
        (root) => root.querySelector("header")?.textContent,
        undefined,
      ),
    ).toBe("价格：￥1234");
    expect(await page.content()).toBe(before);
  } finally {
    await page.close();
  }
});

it("retains a unique fixed public source outside the visual root only with a matching product identity", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(documentFixture(false));
    await page.evaluate(() =>
      document.body.appendChild(document.querySelector("#actual-detail textarea")!),
    );
    await retainDetailRoot(page);
    expect((await captureValuation(page)).source).toMatchObject({
      serverId: "367",
      eid: "root-role",
      askingPrice: "1234",
    });
    await page.evaluate(() =>
      Reflect.set(window, "EquipInfo", { server_id: 367, eid: "another-role" }),
    );
    await expect(captureValuation(page)).rejects.toMatchObject({ name: "IncompleteDetailError" });
  } finally {
    await page.close();
  }
});
