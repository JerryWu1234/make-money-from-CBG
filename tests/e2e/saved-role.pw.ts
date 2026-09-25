import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  browserStatus,
  crawlStatus,
  petSkills,
  rolePage,
  roleRecord,
  roleUrl,
} from "../fixtures/saved-role";

test("已采集角色详情、分页和刷新恢复", async ({ page }, testInfo) => {
  let running = true;
  let ready = false;
  let detailReads = 0;
  let browserStatusReads = 0;
  let browserOpenReads = 0;

  // 构建产物与接口都由测试本地提供；其他来源一律阻断。
  await page.context().route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://cbg-ui.test") return route.abort();
    if (url.pathname.startsWith("/api/")) {
      let body: unknown;
      if (url.pathname === "/api/crawl/detail") {
        const key = url.searchParams.get("key") ?? "";
        if (key === "a") detailReads++;
        body = roleRecord(key, ready);
      } else if (url.pathname === "/api/crawl/records") {
        body = rolePage(Number(url.searchParams.get("page") || 1), ready);
      } else if (url.pathname === "/api/crawl/status") {
        body = crawlStatus(running, ready);
      } else if (url.pathname === "/api/browser/status") {
        browserStatusReads++;
        body = browserStatus;
      } else if (url.pathname === "/api/browser/open") {
        browserOpenReads++;
        body = { error: "刷新不应重新开始登录流程" };
      } else {
        throw new Error(`未模拟的测试接口：${url.pathname}`);
      }
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

  await page.goto("http://cbg-ui.test");
  await page.getByText("正在读取标签 4/7：召唤兽/孩子", { exact: true }).waitFor();
  assert.match(await page.locator(".crawl-panel").innerText(), /本页进度：1 \/ 15/);
  await page.getByRole("button", { name: /角色a ·/ }).click();
  await page
    .getByText("已读取列表摘要，正在采集详情。完成后会自动显示各标签内容。", { exact: true })
    .waitFor();
  ready = true;
  await page.getByRole("tab", { name: "人物/修炼", exact: true }).waitFor({ timeout: 6000 });
  assert.ok(detailReads >= 2, "pending record should refresh without another click");
  assert.equal(await page.getByRole("tab").count(), 8);
  assert.match(await page.getByRole("tabpanel").innerText(), /估价资料清单/);
  await page.getByRole("tab", { name: "召唤兽/孩子", exact: true }).click();

  await expect(page.locator(".pet-card")).toHaveCount(8);
  await expect(page.locator(".pet-card").nth(7)).toContainText("宝宝8");
  for (const skill of petSkills) {
    await expect(page.locator(".pet-card").nth(7)).toContainText(skill);
  }
  await expect(page.locator(".pet-card").nth(7)).toContainText("速度：27");
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
  await page.screenshot({ path: testInfo.outputPath("role-drawer-desktop.png") });
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
  assert.ok(drawer && drawer.width <= 390 && drawer.x >= 0);
  await page.screenshot({ path: testInfo.outputPath("role-drawer-mobile.png") });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1100, height: 1000 });

  const results = page.getByRole("region", { name: "已采集角色" });
  assert.match(await results.innerText(), /测试服/);
  assert.match(await results.innerText(), /总修100/);
  assert.match(await results.innerText(), /2026/);
  const sourceLink = results.getByRole("link", { name: "打开原页 ↗" }).first();
  assert.equal(await sourceLink.getAttribute("href"), roleUrl("a"));
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
  await page.screenshot({ path: testInfo.outputPath("crawl-detail-ui.png") });
});
