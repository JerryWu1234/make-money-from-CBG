import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { createPlaywrightRoleDiagnostic } from "./role-list-diagnostic-driver";
import type { QueryIdentity } from "../query-health/store";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
afterAll(async () => {
  await browser?.close();
});
const original: QueryIdentity = {
  schemaVersion: 1,
  category: "role",
  server: "all",
  serverAge: "1,2,3",
  browserSessionEpoch: "session",
  conditions: {
    server_type: "1,2,3",
    price_min: "100.50",
    price_max: "200",
    level_min: "69",
    level_max: "175",
  },
  page: 2,
  sort: "expire_time DESC",
};
async function fixture(priceAttributes = "", duplicate = false) {
  const page = await browser.newPage();
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<form>
    <input name="price_min" value="100.50" type="number" min="0" max="9999" step="0.01" ${priceAttributes}>
    ${duplicate ? '<input name="price_min" value="100.50">' : ""}
    <input name="price_max" value="200"><input name="level_min" value="69" type="number" min="1" max="175">
    <input name="level_max" value="175" type="number" min="1" max="175"></form>
    <div id="query_result">没有符合条件<div id="soldList"></div><div id="pager_bar">第 2 页</div></div>
    <script>window.QueryArgs=${JSON.stringify({ ...original.conditions, page: 2, order_by: original.sort })};window.QueryResult=[];</script>`,
    }),
  );
  await page.goto("https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py?act=role-search");
  return page;
}
const diagnostic = (page: Page) =>
  createPlaywrightRoleDiagnostic(page, original, {
    available: async () => {},
    observe: async () => {},
    wait: async () => {},
    clear: async () => {},
  });
async function nativeControls(page: Page) {
  await page.evaluate(() => {
    const globals = window as unknown as Record<string, any>;
    globals.__snapshots = [];
    globals.chrome = {
      runtime: {
        id: "test-extension",
        sendMessage: async (message: unknown) => {
          globals.__snapshots.push(message);
        },
        onMessage: {
          addListener: (listener: unknown) => {
            globals.__observerListener = listener;
          },
        },
      },
    };
  });
  await page.addScriptTag({
    content: readFileSync(
      new URL("../../extension/cbg-access/isolated.js", import.meta.url),
      "utf8",
    ),
  });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        (window as unknown as Record<string, any>).__observerListener(
          { kind: "bind" },
          { id: "test-extension" },
          resolve,
        ),
      ),
  );
  await page.waitForFunction(() =>
    (window as unknown as Record<string, any>).__snapshots.some(
      (entry: any) => entry.payload?.roleQueryControls,
    ),
  );
  return page.evaluate(
    () => (window as unknown as Record<string, any>).__snapshots.at(-1).payload.roleQueryControls,
  );
}
it("both production DOM observers read all four visible values and numeric constraints", async () => {
  const page = await fixture();
  try {
    const captured = await diagnostic(page).prepare!();
    expect(captured).toMatchObject({
      fields: { price_min: "100.50", price_max: "200", level_min: "69", level_max: "175" },
      controls: { price_min: { value: "100.50", min: "0", max: "9999", step: "0.01" } },
    });
    expect(await nativeControls(page)).toMatchObject({
      price_min: { value: "100.50", min: "0", max: "9999", step: "0.01" },
      level_max: { value: "175", step: "1" },
    });
  } finally {
    await page.close();
  }
});
it.each(["hidden", "readonly", "disabled", "duplicate"])(
  "both observers reject a %s numeric entry",
  async (scenario) => {
    const page = await fixture(
      scenario === "hidden" ? 'style="display:none"' : scenario === "duplicate" ? "" : scenario,
      scenario === "duplicate",
    );
    try {
      await expect(diagnostic(page).prepare!()).rejects.toMatchObject({
        code: "unsupported_condition",
        fields: ["price_min"],
      });
      expect((await nativeControls(page)).price_min).toBeUndefined();
    } finally {
      await page.close();
    }
  },
);

it("both observers detect a visible server-age form that disagrees with the committed query", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() =>
      document.body.insertAdjacentHTML(
        "beforeend",
        '<ul id="server_type"><li>1年以内服</li><li>1到3年服</li><li class="on">3年以上服</li></ul>',
      ),
    );
    await expect(diagnostic(page).prepare!()).rejects.toMatchObject({
      code: "unsupported_condition",
      fields: ["server_type"],
    });
    await nativeControls(page);
    expect(
      await page.evaluate(
        () =>
          (window as unknown as Record<string, any>).__snapshots.at(-1).payload.roleQueryDimensions,
      ),
    ).toEqual({ server_type: "3" });
  } finally {
    await page.close();
  }
});
