import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const directory = await mkdtemp(path.join(os.tmpdir(), "cbg-crawl-ui-"));
let context;
try {
  context = await chromium.launchPersistentContext(directory, {
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    viewport: { width: 1100, height: 1000 },
  });
  let running = true;
  let ready = false,
    aReads = 0,
    browserStatusReads = 0,
    browserOpenReads = 0;
  const record = (key) => ({
    listing: {
      key,
      eid: `item-${key}`,
      price: "222",
      url: `https://xyq.cbg.163.com/equip?s=367&eid=item-${key}`,
      name: `角色${key}`,
      serverId: "367",
      serverName: "测试服",
      sellingTime: "2026-09-08T14:06:30.000Z",
      highlights: ["人物总修100", "高资质召唤兽"],
      summary: {
        cName: "清风明月",
        iGrade: 175,
        xiulian: 100,
        pet_xiulian: 87,
        AchPointTotal: 3743,
      },
    },
    status: key === "a" && !ready ? "pending" : "complete",
    error: null,
    detail:
      key === "a" && !ready
        ? null
        : {
            captureVersion: 3,
            collectedAt: new Date().toISOString(),
            raw: { test: key },
            tabs: [
              "人物/修炼",
              "技能",
              "道具/法宝",
              "召唤兽/孩子",
              "坐骑",
              "锦衣/外观",
              "玩家之家",
            ].map((name) => ({
              name,
              text: `${key} 的 ${name} 数据\n攻击修炼：25/25`,
              fields: [],
              tables: [],
              elements: [],
              tooltips: [],
              petCount: name === "召唤兽/孩子" ? 8 : undefined,
              pets:
                name === "召唤兽/孩子"
                  ? Array.from({ length: 8 }, (_, index) => ({
                      index: index + 1,
                      name: "宝宝" + (index + 1),
                      fields: [
                        { name: "成长", value: "1.30" },
                        { name: "攻击资质", value: String(1400 + index) },
                      ],
                      skills: [
                        { index: 0, name: "高级必杀", kind: "skill" },
                        { index: 1, name: "高级偷袭", kind: "skill" },
                      ],
                      innerSkills: [{ index: 0, name: "玄武躯", kind: "innerSkill", level: "5" }],
                      equipment: [
                        {
                          index: 0,
                          name: "宝宝项圈" + (index + 1),
                          kind: "equipment",
                          description: "速度：" + (20 + index),
                        },
                      ],
                    }))
                  : undefined,
              items:
                name === "道具/法宝"
                  ? [
                      {
                        index: 0,
                        name: "测试刀",
                        description: "伤害：500\n特技：罗汉金钟",
                        kind: "equipment",
                      },
                      {
                        index: 1,
                        name: "测试头盔",
                        description: "防御：90",
                        attributes: { 等级: "150" },
                      },
                    ]
                  : [],
            })),
          },
  });
  // 只使用本地模拟接口，禁止真实网站请求及日常浏览器访问。
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://cbg-ui.test") return route.abort();
    if (url.pathname.startsWith("/api/")) {
      let body;
      if (url.pathname === "/api/crawl/detail") {
        const key = url.searchParams.get("key");
        if (key === "a") aReads++;
        body = record(key);
      } else if (url.pathname === "/api/crawl/records") {
        const number = Number(url.searchParams.get("page") || 1);
        const keys = ["a", "b", ...Array.from({ length: 43 }, (_, i) => "k" + (i + 3))];
        body = {
          page: number,
          pageSize: 20,
          total: 45,
          totalPages: 3,
          items: keys.slice((number - 1) * 20, number * 20).map((key) => ({
            key,
            name: `角色${key}`,
            price: "222",
            url: `https://xyq.cbg.163.com/equip?s=367&eid=item-${key}`,
            serverId: "367",
            serverName: "测试服",
            highlights: ["总修100", "高资质宝宝"],
            sellingTime: "2026-09-08T14:06:30.000Z",
            collectedAt: ready ? "2026-09-13T15:00:00.000Z" : null,
            lastSeenAt: "2026-09-13T14:59:00.000Z",
            status: record(key).status,
            error: null,
          })),
        };
      } else if (url.pathname === "/api/crawl/status")
        body = {
          running,
          phase: running ? "collecting" : "completed",
          message: "正在采集角色详情…",
          page: 1,
          totalPages: 100,
          saved: ready ? 1 : 0,
          skipped: 0,
          totalSaved: ready ? 1 : 0,
          current: "角色a",
          itemIndex: 1,
          itemsOnPage: 15,
          detailProgress: "正在读取标签 4/7：召唤兽/孩子",
          database: "test.sqlite",
          recent: ["a", "b"].map((key) => ({
            key,
            name: `角色${key}`,
            price: "222",
            status: record(key).status,
          })),
        };
      else if (url.pathname === "/api/browser/status") {
        browserStatusReads++;
        body = {
          running: false,
          workflowStep: "completed",
          isLoggedIn: true,
          loginStatus: "logged_in",
          message: "角色列表已就绪",
        };
      } else if (url.pathname === "/api/browser/open") {
        browserOpenReads++;
        body = { error: "刷新不应重新开始登录流程" };
      } else body = { error: "未知接口" };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    }
    const filename = path.join("dist", url.pathname === "/" ? "index.html" : url.pathname);
    return route.fulfill({
      contentType: filename.endsWith(".js")
        ? "application/javascript"
        : filename.endsWith(".css")
          ? "text/css"
          : "text/html",
      body: await readFile(filename),
    });
  });
  const page = context.pages()[0];
  await page.goto("http://cbg-ui.test");
  await page.getByText("正在读取标签 4/7：召唤兽/孩子", { exact: true }).waitFor();
  assert.match(await page.locator(".crawl-panel").innerText(), /本页进度：1 \/ 15/);
  await page.getByRole("button", { name: /角色a ·/ }).click();
  await page
    .getByText("已读取列表摘要，正在采集详情。完成后会自动显示各标签内容。", { exact: true })
    .waitFor();
  ready = true;
  await page.getByRole("tab", { name: "人物/修炼", exact: true }).waitFor({ timeout: 6000 });
  assert.ok(aReads >= 2, "pending record should refresh without another click");
  assert.equal(await page.getByRole("tab").count(), 8);
  assert.match(await page.getByRole("tabpanel").innerText(), /估价资料清单/);
  await page.getByRole("tab", { name: "召唤兽/孩子", exact: true }).click();

  assert.equal(await page.locator(".pet-card").count(), 8);
  assert.match(await page.locator(".pet-card").nth(7).innerText(), /宝宝8/);
  assert.match(await page.locator(".pet-card").nth(7).innerText(), /高级必杀/);
  assert.match(await page.locator(".pet-card").nth(7).innerText(), /高级偷袭/);
  assert.match(await page.locator(".pet-card").nth(7).innerText(), /速度：27/);
  assert.match(await page.getByRole("tabpanel").innerText(), /已采集 8 \/ 8 只/);
  assert.doesNotMatch(
    await page.getByRole("tabpanel").innerText(),
    /skill_type|equip_level|riderSkill/,
  );
  await page.getByRole("tab", { name: "道具/法宝", exact: true }).click();
  assert.match(await page.getByRole("tabpanel").innerText(), /特技：罗汉金钟/);
  assert.equal(await page.locator(".detail-item").count(), 2);
  assert.match(await page.locator(".detail-item").nth(1).innerText(), /防御：90/);
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.ok(
    await page
      .getByRole("button", { name: /角色a ·/ })
      .evaluate((el) => el === document.activeElement),
  );
  const listScroll = await page
    .locator(".saved-roles .role-table-scroll")
    .evaluate((el) => el.scrollTop);
  await page
    .locator(".saved-role-table tbody tr")
    .filter({ hasText: "角色b" })
    .locator("td")
    .nth(2)
    .click();
  await page.getByRole("tab", { name: "估价概览", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("tab", { name: "估价概览", exact: true }).getAttribute("aria-selected"),
    "true",
  );
  await page.screenshot({ path: "/tmp/cbg-role-drawer-desktop.png" });
  await page.mouse.click(35, 200);
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.getByRole("button", { name: /角色b ·/ }).click();
  await page.getByRole("tab", { name: "估价概览", exact: true }).waitFor();
  await page.getByRole("tab", { name: "估价概览", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await page.getByRole("tab", { name: "人物/修炼", exact: true }).getAttribute("aria-selected"),
    "true",
  );
  await page.getByRole("button", { name: "关闭角色详情" }).click();
  assert.equal(
    await page.locator(".saved-roles .role-table-scroll").evaluate((el) => el.scrollTop),
    listScroll,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /角色b ·/ }).click();
  await page.getByRole("tab", { name: "估价概览", exact: true }).waitFor();
  const drawer = await page.getByRole("dialog").boundingBox();
  assert.ok(drawer.width <= 390 && drawer.x >= 0);
  await page.screenshot({ path: "/tmp/cbg-role-drawer-mobile.png" });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1100, height: 1000 });
  console.log(
    "PASS: row click opens overview drawer; Escape/close restore focus and list scroll; tabs support keyboard; mobile drawer fits viewport",
  );
  const results = page.getByRole("region", { name: "已采集角色" });
  assert.match(await results.innerText(), /测试服/);
  assert.match(await results.innerText(), /总修100/);
  assert.match(await results.innerText(), /2026/);
  const sourceLink = results.getByRole("link", { name: "打开原页 ↗" }).first();
  assert.equal(
    await sourceLink.getAttribute("href"),
    "https://xyq.cbg.163.com/equip?s=367&eid=item-a",
  );
  assert.equal(await sourceLink.getAttribute("target"), "_blank");
  await results.getByRole("button", { name: "下一页", exact: true }).click();
  await page.getByRole("button", { name: /角色k21 ·/ }).waitFor();
  await results.getByRole("button", { name: "下一页", exact: true }).click();
  await page.getByRole("button", { name: /角色k45 ·/ }).waitFor();
  assert.equal(await results.locator("tbody tr").count(), 5);
  await page.getByRole("button", { name: /角色k45 ·/ }).click();
  await page.getByRole("dialog").waitFor();
  assert.match(page.url(), /recordsPage=3/);
  assert.match(page.url(), /record=k45/);
  running = false;
  const statusReadsBeforeReload = browserStatusReads;
  const openReadsBeforeReload = browserOpenReads;
  await page.reload();
  await page.getByRole("button", { name: /角色k45 ·/ }).waitFor();
  await page.getByRole("dialog").waitFor();
  assert.ok(browserStatusReads > statusReadsBeforeReload, "reload should verify browser status");
  assert.equal(browserOpenReads, openReadsBeforeReload, "reload should not restart login");
  assert.equal(await results.locator("tbody tr").count(), 5);
  assert.match(await results.innerText(), /共 45 条/);
  await results.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/cbg-crawl-detail-ui.png" });
  console.log(
    "PASS: saved record page and opened detail restore after reload without restarting login",
  );
  console.log(
    "PASS: live item/tab progress is visible; pending details automatically refresh to seven readable tabs; switching records resets tab selection; gear tips are visible",
  );
} finally {
  await context?.close();
  await rm(directory, { recursive: true, force: true });
}
