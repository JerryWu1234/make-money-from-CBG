import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { CrawlStore } from "../../server/crawler/store";
import { AnalysisStore } from "../../server/analysis/store";
import { createProfile, PROMPT_FILE } from "../../server/analysis/profile";
import { analysisRecord } from "../fixtures/analysis";

test("过期行情显示重新分析入口，点击建立新批次而非恢复旧批次", async ({ page, context }) => {
  const crawl = new CrawlStore(":memory:");
  const record = analysisRecord("expired");
  crawl.observe(record.listing);
  crawl.save(record.listing, record.detail!);
  const store = new AnalysisStore(crawl.db);
  const id = store.createRun("codex", "test-model");
  const profile = createProfile(await readFile(PROMPT_FILE, "utf8"));
  const expired = {
    ...profile,
    marketSources: [
      {
        serverId: record.listing.serverId,
        serverName: "测试服",
        source: "auto",
        age: "older",
        rank: 1,
        goldPrice: 210,
        goldUnit: 30000000,
        baselineUnitConfirmed: true,
        sources: [],
        fetchedAt: new Date(Date.now() - 25 * 3600000).toISOString(),
      },
    ],
  };
  crawl.db
    .prepare("UPDATE analysis_runs SET status='paused',profile_json=? WHERE id=?")
    .run(JSON.stringify(expired), id);
  let starts = 0,
    resumes = 0;
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://cbg-expiry.test") return route.abort();
    if (url.pathname.startsWith("/api/")) {
      let body: unknown;
      const run = store.run(id)!;
      const fresh = { ...run, id: "fresh-run", status: "running", marketExpired: false };
      switch (url.pathname) {
        case "/api/ai/status":
          body = {
            codex: { state: "connected", model: "test-model", response: "READY" },
            deepseek: { state: "unconfigured" },
            deepseekModels: [],
          };
          break;
        case "/api/ai/models":
          body = {
            provider: "codex",
            defaultModel: "test-model",
            models: [{ id: "test-model", name: "测试模型" }],
          };
          break;
        case "/api/analysis/status":
          body = {
            ...store.overview(),
            run: starts ? fresh : run,
            activeRun: starts ? fresh : null,
            profile,
          };
          break;
        case "/api/analysis/start":
          expect(route.request().postDataJSON()).toMatchObject({
            provider: "codex",
            concurrency: 10,
          });
          starts++;
          body = fresh;
          break;
        case "/api/analysis/resume":
          resumes++;
          return route.fulfill({ status: 400, json: { error: "不能恢复过期批次" } });
        default:
          throw new Error("未模拟接口：" + url.pathname);
      }
      return route.fulfill({ json: body });
    }
    const file = path.join(
      "dist",
      url.pathname === "/analysis-preview" ? "index.html" : url.pathname,
    );
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
    await page.goto("http://cbg-expiry.test/analysis-preview");
    const button = page.getByRole("button", { name: "刷新行情并重新分析", exact: true });
    await expect(button).toBeEnabled();
    await expect(
      page.getByText("本批次区服行情已过期。重新分析将刷新行情并使用新批次，已有结果保留。"),
    ).toBeVisible();
    await button.click();
    await expect.poll(() => starts).toBe(1);
    expect(resumes).toBe(0);
    expect(store.run(id)?.marketExpired).toBe(true);
    expect(store.run(id)?.status).toBe("paused");
  } finally {
    await page.close();
    crawl.close();
  }
});
