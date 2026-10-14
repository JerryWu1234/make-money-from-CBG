import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/live",
  testMatch: "**/*.live.ts",
  workers: 1,
  retries: 0,
  timeout: 0,
  expect: { timeout: 15_000 },
  outputDir: "data/live-valuation-e2e/test-results",
  reporter: "list",
  use: {
    browserName: "chromium",
    channel: "chrome",
    headless: true,
    viewport: { width: 1400, height: 1000 },
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
