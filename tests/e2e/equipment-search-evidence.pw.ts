import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { equipmentSearchEvidence } from "../../server/analysis/equipment-search-evidence";
import type { EquipmentEvidenceCapture } from "../../server/analysis/browser-equipment-source";

// Local fixture only: hold a font request so the first short screenshot really times out.
// The retry must use Chrome's real PNG, preserve the form and retain account masking.
test("截图超时后实际Chrome重新截图，保留全页、账号遮盖和可核验文件", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 2,
  });
  let releaseFont!: () => void;
  const fontReady = new Promise<void>((resolve) => {
    releaseFont = resolve;
  });
  let fontRequested!: () => void;
  const requested = new Promise<void>((resolve) => {
    fontRequested = resolve;
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://evidence.test") return route.abort();
    if (url.pathname === "/slow.woff2") {
      fontRequested();
      await fontReady;
      return route.fulfill({ status: 404, body: "fixture font unavailable" });
    }
    return route.fulfill({
      contentType: "text/html",
      body: `
      <style>@font-face { font-family: pending; src: url('/slow.woff2'); }
      body { font-family: pending, sans-serif; min-height: 1000px; }</style>
      <div id="userinfo">fixture account must be masked</div>
      <h1>Equipment search fixture</h1><label>Initial damage <input id="damage" value="592"></label>
      <p>Local fixture only. No official listing or price is requested.</p>`,
    });
  });
  const page = await context.newPage();
  try {
    await page.goto("http://evidence.test", { waitUntil: "domcontentloaded" });
    await requested;
    const screenshot = page.screenshot.bind(page);
    let calls = 0;
    page.screenshot = async (options) => {
      calls++;
      if (calls > 1) return screenshot(options);
      try {
        return await screenshot({ ...options, timeout: 50 });
      } finally {
        releaseFont();
      }
    };
    const input = {
      stage: "filled",
      equipmentKey: "fixture-equipment",
      equipmentName: "fixture sword",
      initialPolicy: "fixture",
      description: "initial damage 592",
      mode: "base-attributes",
      page: 1,
      plannedArgs: { init_damage_raw: 592, serverid: "1" },
      form: { controls: [{ id: "damage", value: "592" }] },
    } as unknown as Parameters<EquipmentEvidenceCapture>[1];
    const result = await equipmentSearchEvidence("fixture:chrome-timeout", "1")(
      page,
      input,
      async () => {
        expect(await page.locator("#damage").inputValue()).toBe("592");
      },
    );
    expect(calls).toBe(2);
    if (result.screenshotDisabled) throw new Error("隔离截图回归必须开启截图");
    const png = await readFile(result.screenshot);
    expect(png.readUInt32BE(16)).toBe(800);
    expect(png.readUInt32BE(20)).toBeGreaterThan(600);
    expect(createHash("sha256").update(png).digest("hex")).toBe(result.screenshotSha256);
    const parameters = await readFile(result.parameters);
    expect(createHash("sha256").update(parameters).digest("hex")).toBe(result.parametersSha256);
    expect(JSON.parse(parameters.toString())).toMatchObject({
      screenshotAttempts: 2,
      screenshotTimeoutMs: 15_000,
    });
    await testInfo.attach("recovered-evidence", { body: png, contentType: "image/png" });
    await testInfo.attach("recovered-parameters", {
      body: parameters,
      contentType: "application/json",
    });
  } finally {
    releaseFont();
    await context.close();
  }
});
