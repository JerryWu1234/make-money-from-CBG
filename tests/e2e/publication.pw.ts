import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { CrawlStore } from "../../server/crawler/store";
import type { SavedListingScope } from "../../server/crawler/types";
import { analysisRecord } from "../fixtures/analysis";
import { browserStatus, crawlStatus } from "../fixtures/saved-role";

test("单一商品列表排除未完整记录，兼容旧任务链接并保留分页刷新", async ({
  page,
  context,
}, testInfo) => {
  const store = new CrawlStore(":memory:");
  const scopes: string[] = [];
  for (let index = 0; index < 21; index++) {
    const record = analysisRecord(`published-${String(index).padStart(2, "0")}`);
    record.listing.name = `完整角色${index}`;
    store.observe(record.listing);
    store.save(record.listing, record.detail!);
  }
  for (const key of ["pending", "failed"]) {
    const record = analysisRecord(key);
    record.listing.name = key === "pending" ? "排队角色" : "失败角色";
    store.observe(record.listing);
  }
  store.fail("failed", "fixture：师门资料仍缺一项");
  store.observe(analysisRecord("broken-complete").listing);
  store.db.prepare("UPDATE listings SET status='complete' WHERE key='broken-complete'").run();
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://cbg-ui.test") return route.abort();
    if (url.pathname.startsWith("/api/")) {
      let body: unknown;
      switch (url.pathname) {
        case "/api/browser/status":
          body = browserStatus;
          break;
        case "/api/crawl/status":
          body = crawlStatus(false, true);
          break;
        case "/api/crawl/settings":
          body = { analyzeEquipment: false };
          break;
        case "/api/crawl/records": {
          const scope = url.searchParams.get("scope") as SavedListingScope;
          scopes.push(scope);
          body = store.records(Number(url.searchParams.get("page") || 1), 20, scope);
          break;
        }
        case "/api/crawl/detail":
          body = store.detail(url.searchParams.get("key") || "");
          break;
        case "/api/scan/status":
          body = {
            config: {
              scheduleType: "daily",
              daily: { startTime: "09:00" },
              days: [],
              maxDurationMinutes: null,
            },
            mode: "disabled",
            state: "disabled",
            message: "未启用",
            timezone: "Asia/Shanghai",
          };
          break;
        default:
          throw new Error("未模拟接口：" + url.pathname);
      }
      return route.fulfill({ json: body });
    }
    const file = path.join("dist", url.pathname === "/" ? "index.html" : url.pathname);
    return route.fulfill({
      contentType: file.endsWith(".js")
        ? "application/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : "text/html",
      body: await readFile(file),
    });
  });
  try {
    await page.goto("http://cbg-ui.test/?recordsScope=tasks&recordsPage=3&record=pending");
    const products = page.getByRole("region", { name: "已采集角色" });
    await expect(products.getByText("共 21 条", { exact: false })).toBeVisible();
    await expect(products.getByRole("row")).toHaveCount(21);
    await expect(products.getByText("失败角色", { exact: false })).toHaveCount(0);
    await expect(products.getByText("排队角色", { exact: false })).toHaveCount(0);
    await expect(products.getByRole("button", { name: "完整商品", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "采集任务", exact: true })).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).not.toHaveURL(/recordsScope=|recordsPage=|record=/);
    await products.getByRole("button", { name: "下一页" }).click();
    await expect(products.getByRole("row")).toHaveCount(2);
    await expect(page).toHaveURL(/recordsPage=2/);
    await page.reload();
    await expect(products.getByRole("row")).toHaveCount(2);
    await expect(products.getByText("共 21 条", { exact: false })).toBeVisible();
    await expect(page).toHaveURL(/recordsPage=2/);
    await expect(page.getByRole("region", { name: "采集任务", exact: true })).toHaveCount(0);
    await products.screenshot({ path: testInfo.outputPath("single-complete-product-list.png") });
    expect(scopes).toContain("complete");
    expect(scopes).not.toContain("tasks");
    expect(scopes).not.toContain("all");
  } finally {
    await context.unrouteAll({ behavior: "wait" });
    store.close();
  }
});
