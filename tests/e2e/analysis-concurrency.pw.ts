import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { CrawlStore } from "../../server/crawler/store";
import type { SavedRoleRecord } from "../../server/crawler/types";
import { AnalysisRunner } from "../../server/analysis/runner";
import { AnalysisStore } from "../../server/analysis/store";
import { createProfile, PROMPT_FILE } from "../../server/analysis/profile";
import { calculateValuation } from "../../server/analysis/valuation-calculator";
import { valuationRecord } from "../fixtures/analysis";

// 失败方式：页面未传并发数、暂停遗漏在途项、错误角色结果入库、新采集角色未分析、恢复时配置失效。
test("分析并发10→保留报价并暂停→改为2继续→自动分析新增裸号", async ({ page }, testInfo) => {
  const database = testInfo.outputPath("analysis.sqlite");
  await mkdir(path.dirname(database), { recursive: true });
  const crawl = new CrawlStore(database);
  const add = (key: string) => {
    const record = valuationRecord(key);
    record.listing.price = String(500 + key.charCodeAt(0));
    record.detail!.equipmentCapture!.emptyProof = "explicit-text";
    record.detail!.tabs.push(
      {
        name: "道具/法宝",
        text: "没有装备",
        fields: [],
        tables: [],
        elements: [],
        tooltips: [],
        items: [],
        equipmentEmptyProof: "official-containers",
      },
      {
        name: "召唤兽/孩子",
        text: "召唤兽(0/10)",
        fields: [],
        tables: [],
        elements: [],
        tooltips: [],
        pets: [],
        petCount: 0,
      },
    );
    crawl.observe(record.listing);
    expect(crawl.save(record.listing, record.detail!)).toBe(true);
  };
  for (const key of "abcdefghijkl") add(key);
  const store = new AnalysisStore(crawl.db);
  const profile = createProfile(
    await readFile(PROMPT_FILE, "utf8"),
    {
      servers: [
        {
          serverId: "367",
          age: "older",
          rank: 13,
          goldPrice: 218.29,
          goldUnit: 30000000,
          baselineUnitConfirmed: true,
        },
      ],
    },
    false,
  );
  const gates = new Map<string, () => void>();
  const calls: string[] = [];
  const configurations: number[] = [];
  let active = 0,
    maximum = 0,
    batch = "";
  const runner = new AnalysisRunner(store, async () => ({
    model: "test-model",
    analyze: async (prompt, _schema, signal) => {
      const key = prompt.match(/商品 ID：([^。\n]+)[。\n]/)![1];
      calls.push(key);
      active++;
      maximum = Math.max(maximum, active);
      try {
        await new Promise<void>((resolve, reject) => {
          gates.set(key, resolve);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return {
          text: JSON.stringify({
            decision: calculateValuation(crawl.detail(key) as SavedRoleRecord, profile).decision,
            reason: "模拟AI核对本角色原文；金额由原有裸号公式复算。",
            extracted_facts: [],
          }),
        };
      } finally {
        active--;
      }
    },
  }));
  await page.context().route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://cbg-analysis.test") return route.abort();
    if (url.pathname.startsWith("/api/")) {
      const input = route.request().method() === "POST" ? route.request().postDataJSON() : {};
      let body: unknown;
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
            models: [{ id: "test-model", name: "模拟模型" }],
          };
          break;
        case "/api/analysis/status":
          body = { ...store.overview({ runId: batch || undefined }), profile };
          break;
        case "/api/analysis/start":
          configurations.push(input.concurrency);
          batch = await runner.start(
            input.provider,
            false,
            profile,
            false,
            undefined,
            1,
            undefined,
            input.concurrency,
          );
          body = store.run(batch);
          break;
        case "/api/analysis/pause":
          await runner.pause(input.runId);
          body = store.run(batch);
          break;
        case "/api/analysis/resume":
          configurations.push(input.concurrency);
          await runner.resume(input.runId, false, input.concurrency);
          body = store.run(batch);
          break;
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
    await page.goto("http://cbg-analysis.test/analysis-preview");
    const count = page.getByRole("spinbutton", { name: "分析并发数" });
    await expect(count).toHaveValue("10");
    await expect(
      page.getByText("默认同时分析 10 个角色；修改后在下次开始、继续或重试时生效。"),
    ).toBeVisible();
    await page.getByRole("button", { name: "开始分析已有商品" }).click();
    await expect.poll(() => active).toBe(10);
    await expect(count).toBeDisabled();
    await expect(page.getByRole("status").filter({ hasText: "分析并发上限：10" })).toContainText(
      "当前在途：10",
    );
    gates.get("b")!();
    await expect.poll(() => store.run(batch)!.completed).toBe(1);
    await page.screenshot({ path: testInfo.outputPath("parallel-ten.png"), fullPage: true });
    await page.getByRole("button", { name: "暂停分析", exact: true }).click();
    await expect(count).toBeEnabled();
    expect(active).toBe(0);
    expect(store.run(batch)).toMatchObject({ status: "paused", completed: 1, queued: 11 });
    await count.fill("0");
    await page.getByRole("button", { name: "继续分析" }).click();
    await expect(page.getByRole("alert")).toContainText("分析并发数必须是正整数");
    expect(configurations).toEqual([10]);
    await count.fill("2");
    gates.clear();
    await page.getByRole("button", { name: "继续分析" }).click();
    await expect.poll(() => active).toBe(2);
    expect(configurations).toEqual([10, 2]);
    for (const key of "acdefghijkl") {
      await expect.poll(() => gates.has(key)).toBe(true);
      gates.get(key)!();
    }
    await expect.poll(() => store.run(batch)!.completed).toBe(12);
    add("m");
    add("n");
    expect(runner.appendCaptured()).toBe(2);
    await expect.poll(() => active).toBe(2);
    gates.get("m")!();
    gates.get("n")!();
    await expect.poll(() => store.run(batch)!.completed).toBe(14);
    await expect(page.getByText(/现有角色已处理完，等待新角色/)).toBeVisible();
    await page.getByRole("button", { name: "暂停分析", exact: true }).click();
    const run = store.run(batch)!;
    expect(run).toMatchObject({ failed: 0, queued: 0, concurrency: 2, runningCount: 0 });
    expect(calls.filter((key) => key === "b")).toHaveLength(1);
    const results = store.overview({ runId: batch }).results.items.map(({ result }) => {
      expect(result.valuation!.bare_role_value).toBeGreaterThan(0);
      expect(result.valuation!.asking_price).toBe(
        Number((crawl.detail(result.productKey) as SavedRoleRecord).listing.price),
      );
      return {
        id: result.productKey,
        asking: result.valuation!.asking_price,
        bare: result.valuation!.bare_role_value,
      };
    });
    expect(results).toHaveLength(14);
    expect(maximum).toBe(10);
    await page.reload();
    await expect(count).toHaveValue("10");
    expect(store.run(batch)!.concurrency).toBe(2);
    await page.screenshot({
      path: testInfo.outputPath("fourteen-bare-quotes.png"),
      fullPage: true,
    });
    const evidence = testInfo.outputPath("evidence.json");
    await writeFile(
      evidence,
      JSON.stringify(
        {
          fixture: true,
          repeat:
            "vp run build && vp exec playwright test tests/e2e/analysis-concurrency.pw.ts --workers=1 --output=data/analysis-concurrency-e2e",
          configurations,
          maximum,
          run,
          results,
        },
        null,
        2,
      ),
    );
    await testInfo.attach("并发裸号分析结果", { path: evidence, contentType: "application/json" });
  } finally {
    await runner.shutdown();
    crawl.close();
  }
});
