import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { browserEvidenceUrl } from "./regression-browser-evidence.mjs";
import { chromium } from "playwright-core";

async function moduleUrl(file, replacements = {}) {
  let source = ts.transpileModule(await readFile(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const [name, url] of Object.entries(replacements))
    source = source.replaceAll(`from "${name}"`, `from "${url}"`);
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}
const { createBackgroundPage } = await import(
  await moduleUrl("server/session.ts", {
    "./chrome": await moduleUrl("server/chrome.ts"),
    "./work-transport": await moduleUrl("server/work-transport.ts"),
    "./browser-evidence": browserEvidenceUrl,
    "./diagnostics": await moduleUrl("server/diagnostics.ts"),
    "./viewport": await moduleUrl("server/viewport.ts"),
    "./config": await moduleUrl("server/config.ts"),
    "playwright-core": import.meta.resolve("playwright-core"),
  })
);
const { openWorkTransport } = await import(await moduleUrl("server/work-transport.ts"));
const { hoverForInspection } = await import(await moduleUrl("server/viewport.ts"));
// 专门创建空白测试配置；不读取日常浏览器的 DevToolsActivePort，也不访问真实网站。
const directory = await mkdtemp(path.join(os.tmpdir(), "cbg-window-regression-"));
let persistent;
let browser;
try {
  persistent = await chromium.launchPersistentContext(directory, {
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--remote-debugging-port=0"],
  });
  const [port, endpoint] = (await readFile(path.join(directory, "DevToolsActivePort"), "utf8"))
    .trim()
    .split("\n");
  const transport = await openWorkTransport(`ws://127.0.0.1:${port}${endpoint}`);
  browser = await chromium.connectOverCDP(transport, {
    noDefaults: true,
  });
  const context = browser.contexts()[0];
  assert.equal(context.pages().length, 0, "existing daily tabs are excluded from initialization");
  await context.route("**/*", (route) =>
    route.fulfill({ contentType: "text/html", body: "隔离工作窗口测试" }),
  );
  await context.addCookies([
    { name: "test_session", value: "shared", domain: "cbg-window.test", path: "/" },
  ]);
  const before = context.pages();
  const worker = await createBackgroundPage(browser);
  assert.equal(worker.context(), context);
  assert.equal(context.pages().length, before.length + 1);
  assert.ok(!before.includes(worker));
  const session = await context.newCDPSession(worker);
  await assert.rejects(session.send("Browser.getWindowForTarget"), /window|web contents/i);
  await worker.goto("https://cbg-window.test/");
  assert.equal(await worker.evaluate(() => document.cookie), "test_session=shared");
  await worker.setViewportSize({ width: 1, height: 1 });
  await worker.setContent(
    '<style>body{overflow:hidden}a{position:fixed;left:1100px;top:100px;width:50px;height:50px;display:block}</style><a id="role" onmouseover="this.dataset.hovered=\'yes\'">角色</a>',
  );
  await assert.rejects(worker.locator("#role").hover({ timeout: 700 }), /outside of the viewport/);
  await hoverForInspection(worker, worker.locator("#role"));
  assert.equal(await worker.locator("#role").getAttribute("data-hovered"), "yes");
  assert.deepEqual(worker.viewportSize(), { width: 1440, height: 1080 });
  await worker.setContent(
    `<style>img{position:absolute;top:80px;width:40px;height:40px}#RoleSkillTipsBox{display:none;position:absolute;left:125px;top:70px;width:160px;height:100px;background:white;z-index:9}</style><img id="skill1" style="left:80px" data_tip_box="RoleSkillTipsBox" onmouseover="RoleSkillTipsBox.style.display='block';RoleSkillTipsBox.innerText='清明自在'"><img id="skill2" style="left:140px" data_tip_box="RoleSkillTipsBox" onmouseover="RoleSkillTipsBox.style.display='block';RoleSkillTipsBox.innerText='宁气诀 防御提升'"><div id="RoleSkillTipsBox" class="soldDetail"></div>`,
  );
  await worker.locator("#skill1").hover();
  await assert.rejects(
    worker.locator("#skill2").hover({ timeout: 700 }),
    /intercepts pointer events/,
  );
  await hoverForInspection(worker, worker.locator("#skill2"));
  assert.equal(await worker.locator("#RoleSkillTipsBox").innerText(), "宁气诀 防御提升");
  console.log(
    "PASS: reproduced skill tooltip intercepting the next icon; real hover now updates the visible tooltip without force",
  );
  await worker.setViewportSize({ width: 1, height: 1 });
  assert.equal(await createBackgroundPage(browser), worker);
  assert.deepEqual(worker.viewportSize(), { width: 1440, height: 1080 });
  await assert.rejects(session.send("Browser.getWindowForTarget"), /window|web contents/i);
  assert.equal(context.pages().length, before.length + 1);
  await session.detach();
  console.log(
    "PASS: actual CDP creates a hidden page without a browser window in the existing profile; cookies are shared and retry reuses only the work page",
  );
  console.log(
    "PASS: reproduced outside-of-viewport hover failure; real hover succeeds after repair, and cached work pages recover without creating a window",
  );
} finally {
  await browser?.close();
  await persistent?.close();
  await rm(directory, { recursive: true, force: true });
}
