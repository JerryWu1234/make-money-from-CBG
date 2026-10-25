import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vite-plus/test";
import { chromium, type BrowserContext } from "playwright-core";

const fixture = vi.hoisted(() => ({ dedicatedProfile: "" }));
vi.mock("./browser-settings", async (original) => ({
  ...(await original<typeof import("./browser-settings")>()),
  browserSettings: () => ({ mode: "dedicated", modes: ["dedicated", "daily"] }),
  enabledBrowserModes: () => ["dedicated", "daily"],
}));
vi.mock("./dedicated-browser", async (original) => {
  const actual = await original<typeof import("./dedicated-browser")>();
  return { openDedicatedBrowser: () => actual.openDedicatedBrowser(fixture.dedicatedProfile) };
});
vi.mock("./diagnostics", () => ({ diagnostics: { record: vi.fn() } }));
vi.mock("./browser-evidence", () => ({
  captureBrowserStep: vi.fn(),
  registerBrowserEvidence: vi.fn(),
}));

// Two temporary profiles and a local fixture only; never use the real collection profile.
let directory: string;
let daily: BrowserContext | undefined;
beforeAll(async () => {
  Reflect.deleteProperty(globalThis, Symbol.for("cbg.browser-session.v1"));
  directory = await mkdtemp(path.join(os.tmpdir(), "cbg-dual-browser-"));
  fixture.dedicatedProfile = path.join(directory, "dedicated");
  const dailyProfile = path.join(directory, "daily");
  vi.stubEnv("CBG_SHOW_WORK_PAGES", "0");
  vi.stubEnv("CBG_CHROME_USER_DATA_DIR", dailyProfile);
  daily = await chromium.launchPersistentContext(dailyProfile, {
    channel: "chrome",
    headless: true,
    args: ["--remote-debugging-port=0"],
  });
  await readFile(path.join(dailyProfile, "DevToolsActivePort"), "utf8");
}, 30_000);
afterAll(async () => {
  await (await import("./session")).shutdownBrowserSession();
  await daily?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  Reflect.deleteProperty(globalThis, Symbol.for("cbg.browser-session.v1"));
  vi.unstubAllEnvs();
});

it("真实双浏览器分别建页和保存登录，共享10个详情名额，退出不关闭日常Chrome", async () => {
  const session = await import("./session");
  const [dedicatedBrowser, dailyBrowser] = await Promise.all([
    session.getBrowser(true, "dedicated"),
    session.getBrowser(true, "daily"),
  ]);
  expect(dedicatedBrowser).not.toBe(dailyBrowser);
  const [dedicatedPage, dailyPage] = await Promise.all([
    session.createBackgroundPage(dedicatedBrowser, "dedicated"),
    session.createBackgroundPage(dailyBrowser, "daily"),
  ]);
  await dedicatedPage.setContent("<h1>专用浏览器夹具</h1>");
  await dailyPage.setContent("<h1>日常浏览器夹具</h1>");
  expect(await dedicatedPage.locator("h1").innerText()).toBe("专用浏览器夹具");
  expect(await dailyPage.locator("h1").innerText()).toBe("日常浏览器夹具");
  await dedicatedPage
    .context()
    .addCookies([
      { name: "login-fixture", value: "dedicated", url: "http://browser-fixture.test" },
    ]);
  await dailyPage
    .context()
    .addCookies([{ name: "login-fixture", value: "daily", url: "http://browser-fixture.test" }]);
  expect((await dedicatedPage.context().cookies("http://browser-fixture.test"))[0].value).toBe(
    "dedicated",
  );
  expect((await dailyPage.context().cookies("http://browser-fixture.test"))[0].value).toBe("daily");
  session.markBrowserReady("dedicated");
  session.markBrowserReady("daily");
  const allocated = await Promise.all(
    Array.from({ length: 10 }, () => session.getBrowser(true, undefined, "detail")),
  );
  expect(allocated.filter((browser) => browser === dedicatedBrowser)).toHaveLength(5);
  expect(allocated.filter((browser) => browser === dailyBrowser)).toHaveLength(5);
  expect(session.getCbgPage()).toBe(dedicatedPage);
  await session.shutdownBrowserSession();
  expect(dedicatedBrowser.isConnected()).toBe(false);
  expect(dailyBrowser.isConnected()).toBe(false);
  expect(daily!.browser()!.isConnected()).toBe(true);
}, 30_000);
