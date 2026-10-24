import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vite-plus/test";
import { chromium, type Browser, type Route } from "playwright-core";
import { captureBrowserStep, registerBrowserEvidence } from "./browser-evidence";
import { diagnostics } from "./diagnostics";
import { createHiddenPage } from "./session";
import { openWorkTransport } from "./work-transport";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
afterAll(async () => {
  await browser?.close();
});

it("实际Playwright将开页、切页、读取完成及报错现场写入同一索引", async () => {
  const parent = path.resolve("artifacts/browser-business-step-regression");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, "run-"));
  const destination = vi.spyOn(diagnostics, "evidenceDirectory").mockReturnValue(directory);
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  registerBrowserEvidence(page);
  try {
    await page.route("https://xyq.cbg.163.com/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<html><meta charset="utf-8"><style>body{font:24px sans-serif;background:#112337;color:#eee;padding:48px}button{font:inherit;padding:16px}#panel{padding:32px;background:#23445f}</style><h1>业务步骤截图回归</h1><p>隔离模拟页 · 不访问真实网站</p><button onclick="document.querySelector('#panel').textContent='坐骑资料读取完成：成长 2.0'">坐骑</button><div id="panel">人物资料读取完成</div></html>`,
      }),
    );
    await page.goto("https://xyq.cbg.163.com/equip?s=367&eid=test");
    await captureBrowserStep(page, { flow: "query", stage: "opened" });
    await page.getByRole("button", { name: "坐骑" }).click();
    await captureBrowserStep(page, { flow: "collection", stage: "tab.changed", key: "367:test" });
    expect(await page.locator("#panel").innerText()).toContain("坐骑资料读取完成");
    await captureBrowserStep(page, {
      flow: "collection",
      stage: "read.completed",
      key: "367:test",
    });
    try {
      await page.locator("#missing-result").waitFor({ timeout: 100 });
    } catch (error) {
      await captureBrowserStep(page, {
        flow: "analysis",
        stage: "read.failed",
        key: "367:test",
        error,
      });
    }
    const entries = (await readFile(path.join(directory, "index.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries.map((entry) => entry.stage)).toEqual([
      "opened",
      "tab.changed",
      "read.completed",
      "read.failed",
    ]);
    for (const entry of entries)
      expect((await readFile(entry.screenshot)).subarray(0, 8).toString("hex")).toBe(
        "89504e470d0a1a0a",
      );
    expect(entries[3].error.name).toBe("TimeoutError");
    console.log("BUSINESS_STEP_EVIDENCE", directory);
  } finally {
    destination.mockRestore();
    await page.close();
  }
}, 30_000);

it("项目真实隐藏工作页也自动注册并能保存业务截图", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "cbg-hidden-step-"));
  const directory = await mkdtemp(path.join(os.tmpdir(), "cbg-hidden-evidence-"));
  const destination = vi.spyOn(diagnostics, "evidenceDirectory").mockReturnValue(directory);
  const persistent = await chromium.launchPersistentContext(profile, {
    channel: "chrome",
    headless: true,
    args: ["--remote-debugging-port=0"],
  });
  let connection: Browser | undefined;
  try {
    const [port, endpoint] = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8"))
      .trim()
      .split("\n");
    const transport = await openWorkTransport(`ws://127.0.0.1:${port}${endpoint}`);
    connection = await chromium.connectOverCDP(transport, { noDefaults: true });
    const page = await createHiddenPage(connection);
    await page.setContent("<h1>隐藏工作页业务截图</h1><p>角色资料读取完成</p>");
    await captureBrowserStep(page, { flow: "collection", stage: "hidden.read.completed" });
    const entries = (await readFile(path.join(directory, "index.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries.map((entry) => entry.stage)).toEqual(["page.created", "hidden.read.completed"]);
    expect(entries.every((entry) => entry.screenshot && !entry.screenshotError)).toBe(true);
    await page.close();
  } finally {
    destination.mockRestore();
    await connection?.close();
    await persistent.close();
    await rm(profile, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it("字体等待使用原生超时与取消，清理后下一步仍能截图", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cbg-native-screenshot-"));
  const destination = vi.spyOn(diagnostics, "evidenceDirectory").mockReturnValue(directory);
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  registerBrowserEvidence(page);
  let heldFont: Route | undefined;
  let requested!: () => void;
  let request = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route("https://cbg-fixture.test/*.woff", (route) => {
    heldFont = route;
    requested();
  });
  const loadStalledFont = async (name: string) => {
    await page.setContent(
      `<style id="stalled-font">@font-face{font-family:Stalled;src:url(https://cbg-fixture.test/${name}.woff)}h1{font-family:Stalled}</style><h1>Current role details</h1>`,
      { waitUntil: "domcontentloaded" },
    );
    await request;
  };
  try {
    await loadStalledFont("timeout");
    const started = Date.now();
    await captureBrowserStep(page, { flow: "collection", stage: "font.timeout" });
    expect(Date.now() - started).toBeLessThan(18000);
    let entries = (await readFile(path.join(directory, "index.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries[0].screenshot).toBeUndefined();
    expect(entries[0].screenshotError).toMatchObject({ name: "TimeoutError" });
    expect(entries[0].screenshotError.message).toContain("15000ms");
    expect(entries[0].screenshotError.message).toContain("waiting for fonts");
    await page.locator("#stalled-font").evaluate((node) => node.remove());
    await heldFont!.abort();
    await captureBrowserStep(page, { flow: "collection", stage: "font.recovered" });

    request = new Promise<void>((resolve) => {
      requested = resolve;
    });
    await loadStalledFont("abort");
    const control = new AbortController();
    const abort = setTimeout(() => control.abort(new Error("用户暂停")), 100);
    try {
      await captureBrowserStep(
        page,
        { flow: "collection", stage: "font.cancelled" },
        control.signal,
      );
    } finally {
      clearTimeout(abort);
    }
    await page.locator("#stalled-font").evaluate((node) => node.remove());
    await heldFont!.abort();
    await captureBrowserStep(page, { flow: "collection", stage: "abort.recovered" });
    entries = (await readFile(path.join(directory, "index.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries.map((entry) => entry.stage)).toEqual([
      "font.timeout",
      "font.recovered",
      "abort.recovered",
    ]);
    for (const entry of entries.slice(1)) {
      expect(entry.screenshotError).toBeUndefined();
      const png = await readFile(entry.screenshot);
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([800, 600]);
    }
  } finally {
    destination.mockRestore();
    await page.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it("暂态字体等待六秒后仍能在原生十五秒预算内保存真实截图", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cbg-slow-screenshot-"));
  const destination = vi.spyOn(diagnostics, "evidenceDirectory").mockReturnValue(directory);
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  registerBrowserEvidence(page);
  let heldFont: Route | undefined;
  let requested!: () => void;
  const request = new Promise<void>((resolve) => {
    requested = resolve;
  });
  let release: ReturnType<typeof setTimeout> | undefined;
  try {
    await page.route("https://cbg-fixture.test/slow.woff", (route) => {
      heldFont = route;
      requested();
    });
    await page.setContent(
      "<style>@font-face{font-family:Slow;src:url(https://cbg-fixture.test/slow.woff)}h1{font-family:Slow}</style><h1>Slow role evidence</h1>",
      { waitUntil: "domcontentloaded" },
    );
    await request;
    const started = Date.now();
    // Release only this isolated simulated resource; no site or daily Chrome is contacted.
    release = setTimeout(() => {
      void heldFont!.abort().catch(() => {});
    }, 6000);
    await captureBrowserStep(page, { flow: "collection", stage: "slow-font.completed" });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(5500);
    expect(elapsed).toBeLessThan(15000);
    const entries = (await readFile(path.join(directory, "index.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries).toHaveLength(1);
    expect(entries[0].screenshotError).toBeUndefined();
    const png = await readFile(entries[0].screenshot);
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([800, 600]);
  } finally {
    if (release) clearTimeout(release);
    destination.mockRestore();
    await page.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
