import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { chromium, type Browser } from "playwright-core";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 30_000);
afterAll(async () => {
  await browser?.close();
});
it("R-N3 actual ISOLATED rule selects official pet aptitude/star/trait and jewelry logic controls", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<input id="txt_defence_aptitude"><input id="txt_physical_aptitude"><input id="txt_speed_aptitude_min"><input id="txt_speed_aptitude_max">
      <div id="texing_panel"><ul><li data-value="1">特性</li></ul></div>
      <input type="radio" class="js_super_sum_star" value="0"><input type="radio" id="added_attr_logic_detail">`);
    await page.addScriptTag({
      content: readFileSync(
        new URL("../../extension/cbg-access/market-rules.js", import.meta.url),
        "utf8",
      ),
    });
    const selected = await page.evaluate(() => {
      const rules = (
        window as unknown as { __CBGMarketRules: { select(target: unknown): HTMLElement } }
      ).__CBGMarketRules;
      return [
        ...[
          "txt_defence_aptitude",
          "txt_physical_aptitude",
          "txt_speed_aptitude_min",
          "txt_speed_aptitude_max",
          "added_attr_logic_detail",
        ].map(
          (field) =>
            rules.select({
              kind: "market-field",
              field,
              value: field === "added_attr_logic_detail" ? "true" : "1000",
            }).id,
        ),
        rules.select({ kind: "market-choice", panel: "texing_panel", values: ["1"] }).textContent,
        rules.select({ kind: "market-choice", panel: "super_sum_star", values: ["0"] }).className,
      ];
    });
    expect(selected).toEqual([
      "txt_defence_aptitude",
      "txt_physical_aptitude",
      "txt_speed_aptitude_min",
      "txt_speed_aptitude_max",
      "added_attr_logic_detail",
      "特性",
      "js_super_sum_star",
    ]);
  } finally {
    await page.close();
  }
});
