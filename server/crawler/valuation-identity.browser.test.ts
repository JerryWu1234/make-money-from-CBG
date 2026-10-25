import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { chromium, type Browser } from "playwright-core";
import { captureValuation } from "./valuation-capture";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
afterAll(async () => {
  await browser?.close();
});

it.each(["lexical", "equip", "conflict", "partial-conflict", "array-config", "identity-changes"])(
  "详情身份统一读取且拒绝冲突和无关配置：%s",
  async (mode) => {
    const page = await browser.newPage();
    try {
      const script =
        mode === "lexical"
          ? 'const EquipInfo={server_id:481,eid:"another-role"};'
          : mode === "equip"
            ? 'window.equip={server_id:481,eid:"another-role"};'
            : mode === "identity-changes"
              ? 'window.EquipInfo={server_id:481,eid:"another-role"};'
              : mode === "array-config"
                ? 'window.equip_info=[{server_id:481,eid:"another-role"}];'
                : `window.EquipInfo={server_id:481,${mode === "conflict" ? 'eid:"another-role"' : ""}};window.equip={server_id:482,eid:"another-role"};`;
      await page.setContent(`<div data-cbg-detail-root>价格：￥100</div>
        <textarea id="equip_desc_value">fixture</textarea><script>${script}
        window.decode_desc=x=>x;
        window.RoleInfoParser=class {constructor(){${mode === "identity-changes" ? 'window.EquipInfo.eid="different-role";' : ""}this.raw_info={AllRider:{},jinjie_rider_info:{isJinJie:0},all_skills:{},i3FlyLv:0};this.result={shenqi:false,basic_info:{is_gold_id:false}}}};
        </script>`);
      const capture = await captureValuation(page);
      if (["lexical", "equip"].includes(mode)) {
        expect(capture.source).toMatchObject({ serverId: "481", eid: "another-role" });
        expect(capture.issues).toEqual([]);
      } else {
        expect(capture.issues.join("；")).toMatch(/身份/);
      }
    } finally {
      await page.close();
    }
  },
);

it.each([
  ["缺失对象", undefined, false],
  ["空对象", {}, false],
  ["缺服务器", { eid: "identity-browser" }, false],
  ["缺商品", { server_id: 367 }, false],
  ["非法服务器", { server_id: "not-server", eid: "identity-browser" }, false],
  ["非法商品", { server_id: 367, eid: "bad?query" }, false],
  ["合法官网字段", { server_id: 367, eid: "identity-browser" }, true],
] as const)("实际浏览器提取%s不借Listing或URL补身份", async (_label, equip, valid) => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<div data-cbg-detail-root>价格：￥100</div><textarea id="equip_desc_value">fixture</textarea><script>
      ${equip ? `window.EquipInfo=${JSON.stringify(equip)};` : ""}
      window.decode_desc=x=>x;
      window.RoleInfoParser=class {constructor(){this.raw_info={AllRider:{},jinjie_rider_info:{isJinJie:0},shenqi:{},idbid_desc:[],all_skills:{},i3FlyLv:0,iCash:0,iSaving:0,iLearnCash:0,xianyu:0};this.result={shenqi:false,basic_info:{is_gold_id:false}}}};
    </script>`,
      { waitUntil: "domcontentloaded" },
    );
    const capture = await captureValuation(page);
    if (valid) {
      expect(capture.source).toMatchObject({ serverId: "367", eid: "identity-browser" });
      expect(capture.issues).toEqual([]);
    } else {
      expect(capture.issues.join("；")).toContain("身份");
      if (!equip) expect(capture.source).toMatchObject({ serverId: "", eid: "" });
    }
  } finally {
    await page.close();
  }
});
