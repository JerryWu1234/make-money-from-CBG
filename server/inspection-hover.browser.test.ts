import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vite-plus/test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { bindOfficialPage, officialGovernor, officialPageSignal } from "./official-access";
import { openWorkTransport } from "./work-transport";
import { hoverForInspection } from "./viewport";

let persistent: BrowserContext, browser: Browser, profile: string;
let transport: Awaited<ReturnType<typeof openWorkTransport>>;
const resources: Array<{ page: Page; db: DatabaseSync }> = [];
beforeAll(async () => {
  profile = await mkdtemp(path.join(os.tmpdir(), "cbg-protected-hover-"));
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
}, 30000);
afterEach(async () => {
  for (const { page, db } of resources.splice(0)) {
    await page.close();
    db.close();
  }
});
afterAll(async () => {
  await browser?.close();
  await persistent?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});
async function fixture(content = '<button id="target">商品A</button>') {
  const db = new DatabaseSync(":memory:"),
    gate = officialGovernor(db),
    state = gate.read();
  gate.updatePolicy(
    { ...state.policy, version: 2, minIntervalMs: 0, maxActionsPerWindow: 100 },
    state.revision,
  );
  const page = await browser.newPage();
  resources.push({ page, db });
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><meta charset="utf-8"><style>body{margin:40px}button{width:160px;height:45px}</style><script>window.IsLogin=1;window.observed=[];document.addEventListener('mouseover',e=>{if(e.target.id==='target')observed.push({text:e.target.textContent,trusted:e.isTrusted})});</script>${content}`,
    }),
  );
  await page.goto("https://xyq.cbg.163.com/equip?s=1&eid=offline-hover");
  const control = new AbortController();
  await bindOfficialPage(page, {
    runId: "inspection-hover",
    sourceKind: "workflow",
    signal: control.signal,
  });
  const element = page.locator("#target"),
    nativeHover = vi.fn(async () => {
      throw new Error("Locator.hover must not run on a protected inspection");
    });
  element.hover = nativeHover;
  const originalMove = page.mouse.move.bind(page.mouse);
  const move = vi.spyOn(page.mouse, "move");
  return { page, element, nativeHover, move, originalMove, gate, db, control };
}
const events = (page: Page) => page.evaluate(() => Reflect.get(window, "observed"));

it("真实访问保护下不请求元素句柄，目标只移动一次且许可完成", async () => {
  const x = await fixture();
  const send = transport.send.bind(transport),
    handles: string[] = [];
  transport.send = (message) => {
    if (message.method === "DOM.resolveNode") handles.push(message.method);
    send(message);
  };
  try {
    await hoverForInspection(x.page, x.element);
    expect(x.nativeHover).not.toHaveBeenCalled();
    expect(handles).toEqual([]);
    expect(x.move).toHaveBeenCalledTimes(2); // Reset for mouseout, then one target move.
    expect(await events(x.page)).toEqual([{ text: "商品A", trusted: true }]);
    expect(x.db.prepare("SELECT status FROM access_permits").all()).toEqual([
      { status: "completed" },
    ]);
    expect(x.gate.read().state).toBe("ready");
  } finally {
    transport.send = send;
  }
});

it("重复同坐标悬停仍产生新mouseover，同位置换商品不沿用旧提示", async () => {
  const x = await fixture();
  await hoverForInspection(x.page, x.element);
  await hoverForInspection(x.page, x.element);
  expect(await events(x.page)).toEqual([
    { text: "商品A", trusted: true },
    { text: "商品A", trusted: true },
  ]);
  await x.page.evaluate(() => {
    const replacement = document.createElement("button");
    replacement.id = "target";
    replacement.textContent = "商品B";
    document.querySelector("#target")!.replaceWith(replacement);
  });
  // Let replacement-related layout settle while the pointer stays at the old coordinates.
  await x.page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await x.page.evaluate(() => Reflect.set(window, "observed", []));
  await hoverForInspection(x.page, x.element);
  expect(await events(x.page)).toEqual([{ text: "商品B", trusted: true }]);
  expect(x.nativeHover).not.toHaveBeenCalled();
  expect(
    x.db
      .prepare("SELECT status FROM access_permits")
      .all()
      .every((row) => row.status === "completed"),
  ).toBe(true);
});

it.each([
  '<button id="target" style="display:none">隐藏</button>',
  '<button id="target" style="opacity:0">透明</button>',
  '<button id="target" disabled>禁用</button>',
  '<div inert><button id="target">inert</button></div>',
  '<button id="target" aria-disabled="true">禁用</button>',
  '<button id="target">遮挡</button><div style="position:fixed;inset:0;background:#ddd">验证遮罩</div>',
  '<button id="target">A</button><button id="target">B</button>',
  "<p>目标已消失</p>",
])("不可见/非唯一/真实遮挡不派发鼠标：%s", async (content) => {
  const x = await fixture(content);
  await expect(hoverForInspection(x.page, x.element)).rejects.toMatchObject({
    name: "IncompleteDetailError",
  });
  expect(x.move).not.toHaveBeenCalled();
  expect(x.nativeHover).not.toHaveBeenCalled();
});

it.each(["replace", "move", "cancel"])("两次几何之间%s时不派发鼠标", async (kind) => {
  const x = await fixture();
  const original = x.element.evaluateAll.bind(x.element);
  let reads = 0;
  x.element.evaluateAll = (async (...args: Parameters<typeof original>) => {
    const result = await original(...args);
    if (++reads === 1) {
      if (kind === "cancel") x.control.abort(new Error("cancel-before-hover"));
      else
        await x.page.evaluate((kind) => {
          const target = document.querySelector<HTMLElement>("#target")!;
          if (kind === "replace") target.replaceWith(target.cloneNode(true));
          else target.style.marginLeft = "20px";
        }, kind);
    }
    return result;
  }) as typeof x.element.evaluateAll;
  await expect(hoverForInspection(x.page, x.element)).rejects.toThrow();
  expect(x.move).not.toHaveBeenCalled();
  expect(x.nativeHover).not.toHaveBeenCalled();
});

it("目标移入后节点替换只失败，不重发目标动作", async () => {
  const x = await fixture();
  await x.page.evaluate(() =>
    document.querySelector("#target")!.addEventListener(
      "mouseover",
      (event) => {
        const node = event.currentTarget as Element;
        node.replaceWith(node.cloneNode(true));
      },
      { once: true },
    ),
  );
  await expect(hoverForInspection(x.page, x.element)).rejects.toMatchObject({
    name: "IncompleteDetailError",
  });
  expect(x.move).toHaveBeenCalledTimes(2);
  expect(x.nativeHover).not.toHaveBeenCalled();
});

it.each([1, 2])("第%s次mouse.move未知失败保留原错并撤权，绝不重放", async (failingCall) => {
  const x = await fixture(),
    error = new Error("original-move-transport-failure");
  const original = x.originalMove;
  let calls = 0;
  x.move.mockImplementation(async (...args) => {
    if (++calls === failingCall) throw error;
    return original(...args);
  });
  await expect(hoverForInspection(x.page, x.element)).rejects.toBe(error);
  expect(x.move).toHaveBeenCalledTimes(failingCall);
  expect(x.nativeHover).not.toHaveBeenCalled();
  expect(x.db.prepare("SELECT status FROM access_permits").all()).toEqual([{ status: "unknown" }]);
  expect(x.gate.read().state).toBe("needs_action");
  await expect.poll(() => officialPageSignal(x.page)?.aborted).toBe(true);
});
