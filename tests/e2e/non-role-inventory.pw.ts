import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { collectDetail, MAIN_TABS } from "../../server/crawler/detail";
import { captureIssues } from "../../server/crawler/capture-readiness";
import { CrawlStore } from "../../server/crawler/store";
import { equipmentInventory } from "../../server/analysis/equipment-pricing";
import { clickForInspection } from "../../server/viewport";
import type { Listing, SavedRoleRecord } from "../../server/crawler/types";

// Failure modes: materials wait forever for weapon stats; metadata/levels are
// lost; materials enter equipment pricing; a broken weapon is also accepted;
// saved data changes after reopening SQLite or the fixture contacts the website.
const observedModels = {
  "906": {
    name: "蚩尤武诀",
    desc: "记载着蚩尤所创的武术心法。#r【物品类型】儿童物品#r【功能】可供儿童学习，减少智力属性40点，减少定力及念力属性各20点，养育结束后可领悟“蚩尤之搏”的特殊技能。",
  },
  "4243": { name: "元灵晶石", desc: "灵山晶石经千锤百炼而成，为灵饰淬灵所必须的材料。" },
  "18126": { name: "灵饰指南书", desc: "记载各种灵饰制造方法的古老书卷。" },
  "4010": {
    name: "黑宝石",
    desc: "坚硬无比的宝石；表面看起来毫不起眼，实际上却蕴涵着巨大的力量。是用来合成装备的神奇矿石。#r【镶嵌装备】腰带、鞋子#r提高8点速度",
  },
};

test("四类归档失败物品→完整读取7标签→入库重开→仅武器查价，残缺武器仍拒绝", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const database = testInfo.outputPath("inventory.sqlite");
  await mkdir(path.dirname(database), { recursive: true });
  let store = new CrawlStore(database);
  const origin = "http://127.0.0.1:17779";
  const listing = (id: string): Listing => ({
    key: `367:${id}`,
    serverId: "367",
    eid: id,
    ordersn: id,
    url: `${origin}/equip?s=367&eid=${id}`,
    sellingTime: new Date().toISOString(),
    createdTime: null,
    orderTime: null,
    name: "隔离测试角色",
    price: "100",
    attrs: {},
    summary: null,
  });
  const good = listing("complete"),
    broken = listing("broken");
  const html = (eid: string) => {
    const materials = Object.entries(observedModels)
      .map(
        ([model, value]) =>
          `<div><img width="35" height="35" alt="${value.name}" data_equip_type="${model}" data_equip_name="${value.name}" ${model === "4010" ? 'data_equip_desc="等级 6"' : ""} data_tip_box="MissingMaterialTip" onmouseover="window.materialHovers++"><span>${value.name}</span></div>`,
      )
      .join("");
    const weapon = `<div id="RoleUsingEquips"><img width="35" height="35" alt="测试武器" data_equip_type="31301" data_equip_name="测试武器" data_equip_category="武器" data_equip_desc="等级 100${eid === "broken" ? "" : "#r伤害 +420"}" data_tip_box="MissingWeaponTip"><span>测试武器</span></div>`;
    const gear =
      weapon +
      `<div id="RoleStoreEquips">${materials}</div><div id="RoleSplitEquips"></div><div id="RoleYuHun"></div>`;
    const skills =
      "<p>师门技能</p>" +
      ["一", "二", "三", "四", "五", "六", "七"]
        .map(
          (n) =>
            `<p>150</p><img width="30" height="30" data_skill_type="school_skill" data_equip_name="测试技能${n}" data_equip_level="150"><p>测试技能${n}</p>`,
        )
        .join("") +
      "<p>生活技能</p>";
    const tabs = Object.fromEntries(
      MAIN_TABS.map((name) => [
        name,
        name === "道具/法宝"
          ? gear
          : name === "召唤兽/孩子"
            ? "<p>召唤兽(0/10)</p>"
            : name === "技能"
              ? skills
              : `<p>${name}：本地隔离回归资料</p>`,
      ]),
    );
    return `<meta charset="utf-8"><h1>本地隔离回归：普通道具与人物装备</h1><script>var IsLogin=1,LoginInfo={login:1},EquipInfo={server_id:367,eid:${JSON.stringify(eid)}};window.materialHovers=0;window.CBG_GAME_CONFIG={equip_info:${JSON.stringify(observedModels)}};window.decode_desc=v=>v;window.RoleInfoParser=class{constructor(){this.raw_info={AllRider:{},jinjie_rider_info:{isJinJie:0},all_skills:{201:140},i3FlyLv:0};this.result={shenqi:false,basic_info:{is_gold_id:false}}}};var content=${JSON.stringify(tabs)};function show(name){document.getElementById('panel').innerHTML=content[name]}</script><section><nav>${MAIN_TABS.map((name) => `<button onclick="show('${name}')">${name}</button>`).join("")}</nav><div id="panel">${"隔离角色完整资料。".repeat(30)}</div><textarea id="equip_desc_value" hidden>fixture-${eid}</textarea></section>`;
  };
  await page.context().route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || url.pathname !== "/equip") return route.abort();
    return route.fulfill({ contentType: "text/html", body: html(url.searchParams.get("eid")!) });
  });
  const signal = new AbortController().signal;
  try {
    const detail = await collectDetail(page, good, signal);
    expect(detail.tabs.map((tab) => tab.name)).toEqual(MAIN_TABS);
    expect(captureIssues(detail, true, true, good)).toEqual([]);
    expect(
      await page.evaluate(() => (window as unknown as { materialHovers: number }).materialHovers),
    ).toBe(0);
    const items = detail.tabs.find((tab) => tab.name === "道具/法宝")!.items!;
    expect(items).toHaveLength(5);
    for (const material of Object.values(observedModels)) {
      const item = items.find((value) => value.name === material.name)!;
      expect(item.officialModel?.description).toBe(material.desc);
      expect(item.description).toContain(material.desc.split("#r")[0]);
      expect(item.category).toMatch(/^(材料|道具)/);
    }
    expect(items.find((item) => item.modelId === "4010")!.description).toContain("等级 6");
    store.observe(good);
    expect(store.save(good, detail)).toBe(true);
    await clickForInspection(page.getByRole("button", { name: "道具/法宝", exact: true }), signal);
    await page.screenshot({ path: testInfo.outputPath("material-inventory.png"), fullPage: true });
    store.close();
    store = new CrawlStore(database);
    const record = store.detail(good.key) as SavedRoleRecord;
    expect(record.status).toBe("complete");
    expect(captureIssues(record.detail!, true, true, record.listing)).toEqual([]);
    const priced = equipmentInventory(record).items.map((item) => item.name);
    expect(priced).toEqual(["测试武器"]);
    const incomplete = await collectDetail(page, broken, signal);
    expect(captureIssues(incomplete, true, true, broken).join("；")).toContain(
      "测试武器 的装备属性未完整读取",
    );
    store.observe(broken);
    expect(store.save(broken, incomplete)).toBe(false);
    expect(store.count()).toBe(1);
    expect(store.detail(broken.key)).toMatchObject({ status: "failed" });
    await page.screenshot({
      path: testInfo.outputPath("broken-weapon-rejected.png"),
      fullPage: true,
    });
    const sql =
      "SELECT key,status,json_extract(detail_json,'$.equipmentCapture.complete') AS equipment_complete FROM listings ORDER BY key;";
    await writeFile(testInfo.outputPath("verify.sql"), sql + "\n");
    await writeFile(
      testInfo.outputPath("evidence.json"),
      JSON.stringify(
        {
          fixture: true,
          scope:
            "真实浏览器读取、完整性校验、SQLite及装备库存提取；官网页面和元数据使用本地受控内容，不请求官网或AI",
          items,
          priced,
          failedWeaponIssues: incomplete.equipmentCapture?.issues,
          rows: store.db.prepare(sql).all(),
          repeat:
            "vp exec playwright test tests/e2e/non-role-inventory.pw.ts --workers=1 --output=/tmp/cbg-nonrole-e2e",
          verify: "sqlite3 inventory.sqlite < verify.sql",
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    store.close();
  }
});
