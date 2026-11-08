import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vite-plus/test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { createHiddenPage } from "./session";
import { openWorkTransport } from "./work-transport";
import { clickForInspection } from "./viewport";

vi.mock("./browser-evidence", () => ({
  registerBrowserEvidence: vi.fn(),
  captureBrowserStep: vi.fn().mockResolvedValue(undefined),
}));

let persistent: BrowserContext | undefined;
let browser: Browser | undefined;
let profile: string | undefined;
let transport: Awaited<ReturnType<typeof openWorkTransport>>;

beforeAll(async () => {
  vi.stubEnv("CBG_SHOW_WORK_PAGES", "0");
  profile = await mkdtemp(path.join(os.tmpdir(), "cbg-inspection-click-"));
  persistent = await chromium.launchPersistentContext(profile, {
    channel: "chrome",
    headless: true,
    args: ["--remote-debugging-port=0"],
  });
  const [port, endpoint] = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8"))
    .trim()
    .split("\n");
  transport = await openWorkTransport(`ws://127.0.0.1:${port}${endpoint}`);
  browser = await chromium.connectOverCDP(transport, { noDefaults: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await persistent?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function fixture(hidden = false, content = '<button id="target">角色标签</button>') {
  const page = hidden ? await createHiddenPage(browser!) : await browser!.newPage();
  await page.route("**/*", (route) => route.abort());
  await page.setContent(`<style>body{margin:40px}button{width:160px;height:45px}</style>${content}
    <script>
      window.observed = [];
      for (const type of ['mousedown','mouseup','click'])
        document.addEventListener(type, e => observed.push({ type, trusted:e.isTrusted }));
      HTMLElement.prototype.click = function(){ throw new Error('禁止脚本点击'); };
    </script>`);
  return page;
}
const events = (page: Page) => page.evaluate(() => Reflect.get(window, "observed"));

it.each([false, true])(
  "隐藏页=%s：产生一次浏览器鼠标点击，不使用DOM点击或元素句柄转换",
  async (hidden) => {
    const page = await fixture(hidden);
    const send = transport.send.bind(transport);
    const handles: string[] = [];
    transport.send = (message) => {
      if (message.method === "DOM.resolveNode") handles.push(message.method);
      send(message);
    };
    try {
      await clickForInspection(page.locator("#target"));
      expect(await events(page)).toEqual([
        { type: "mousedown", trusted: true },
        { type: "mouseup", trusted: true },
        { type: "click", trusted: true },
      ]);
      expect(handles).toEqual([]);
    } finally {
      transport.send = send;
      await page.close();
    }
  },
);

it.each([
  '<button id="target" style="display:none">隐藏</button>',
  '<button id="target" style="opacity:0">透明</button>',
  '<button id="target" disabled>禁用</button>',
  '<div inert><button id="target">不可交互</button></div>',
  '<button id="target" aria-disabled="true">禁用</button>',
  '<button id="target">遮挡</button><div style="position:fixed;inset:0;background:#ddd">验证遮罩</div>',
  '<button id="target">第一个</button><button id="target">第二个</button>',
  "<p>目标已消失</p>",
])("拒绝不可点击目标：%s", async (content) => {
  const page = await fixture(true, content);
  try {
    await expect(clickForInspection(page.locator("#target"))).rejects.toMatchObject({
      name: "IncompleteDetailError",
    });
    expect(await events(page)).toEqual([]);
  } finally {
    await page.close();
  }
});

it("鼠标移入时目标被重绘，不点击替换后的元素", async () => {
  const page = await fixture(true);
  try {
    await page.evaluate(() => {
      document.getElementById("target")!.addEventListener("mouseover", (event) => {
        const replacement = document.createElement("button");
        replacement.id = "target";
        replacement.textContent = "替换后的标签";
        (event.currentTarget as Element).replaceWith(replacement);
      });
    });
    await expect(clickForInspection(page.locator("#target"))).rejects.toMatchObject({
      name: "IncompleteDetailError",
    });
    expect(await events(page)).toEqual([]);
  } finally {
    await page.close();
  }
});
