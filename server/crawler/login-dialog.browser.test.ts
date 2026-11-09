import { afterAll, beforeAll, expect, it, vi } from "vite-plus/test";
import { chromium, type Browser, type Page } from "playwright-core";
import {
  hasLoginRequiredDialog,
  watchLoginRequiredDialog,
  LoginRequiredDialogError,
} from "./login-dialog";
import { assertAvailable } from "./page";
import { clickForInspection, hoverForInspection } from "../viewport";
import { createCrawlSource } from "./source";
import { collectDetail } from "./detail";
import { crawl } from "./runner";
import { CrawlStore } from "./store";
import { IncompleteCaptureError } from "./capture-readiness";
import { analysisRecord } from "../../tests/fixtures/analysis";

vi.mock("./detail", () => ({
  MAIN_TABS: ["人物/修炼", "技能", "道具/法宝", "召唤兽/孩子", "坐骑", "锦衣/外观", "玩家之家"],
  collectDetail: vi.fn(),
  isOnShelf: vi.fn(),
}));
vi.mock("./page", async (original) => ({
  ...(await original<typeof import("./page")>()),
  pace: async () => {},
}));
vi.mock("../browser-evidence", () => ({
  captureBrowserStep: vi.fn().mockResolvedValue(undefined),
}));

const popup = `<div class="popupDialog" style="right:50%;margin-top:-67px;margin-right:-125px;width:251px"><div class="dialogWrap"><div class="blockTitle">提示</div><div class="dialogCont"><div class="f14px"><div>请登录后，再进行操作</div><div class="js_buttons_warp"><a href="javascript:;" class="btn1 js_alert_btn_0">去登录</a></div></div></div></div></div>`;
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
afterAll(async () => {
  await browser?.close();
});
async function fixture(content = "") {
  const page = await browser.newPage();
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<script>window.IsLogin=1;window.LoginInfo={login:1}</script>${content}`,
    }),
  );
  await page.goto("http://login-dialog.test/list");
  return page;
}

it.each([
  [popup, true],
  [popup.replace("请登录后，再进行操作", "请 登录 后, 再进行 操作。"), true],
  [popup.replace('style="right', 'style="display:none;right'), false],
  [popup.replace('style="right', 'style="opacity:0;right'), false],
  [popup.replace('style="right', 'style="visibility:hidden;right'), false],
  [popup.replace("请登录后，再进行操作", "请选择其他服务器，我知道了"), false],
  ["<p>帮助说明：请登录后，再进行操作</p>", false],
])("仅识别可见登录提示，旧登录标记不覆盖弹窗，匹配=%s", async (html, match) => {
  const page = await fixture(String(html));
  try {
    expect(await page.evaluate(hasLoginRequiredDialog)).toBe(match);
    if (match)
      await expect(assertAvailable(page)).rejects.toMatchObject({
        kind: "login",
        code: "CBG_LOGIN_REQUIRED_DIALOG",
      });
    else await expect(assertAvailable(page)).resolves.toBeUndefined();
  } finally {
    await page.close();
  }
});

it.each(["existing", "inserted", "reload", "css"])(
  "%s 弹窗触发一次，不点击去登录",
  async (mode) => {
    const page = await fixture(mode === "existing" || mode === "reload" ? popup : "");
    const control = new AbortController();
    const notified = vi.fn();
    let dispose: (() => Promise<void>) | undefined;
    try {
      if (mode === "reload")
        await page.evaluate(() => document.querySelector(".popupDialog")?.remove());
      await page.evaluate(() => {
        Reflect.set(window, "loginClicks", 0);
        document.addEventListener("click", () => Reflect.set(window, "loginClicks", 1));
      });
      dispose = await watchLoginRequiredDialog(page, control.signal, notified);
      if (mode === "inserted")
        await page.evaluate((html) => document.body.insertAdjacentHTML("beforeend", html), popup);
      if (mode === "reload") await page.reload();
      if (mode === "css")
        await page.evaluate((html) => {
          document.head.insertAdjacentHTML(
            "beforeend",
            "<style>@keyframes reveal{from{opacity:0}to{opacity:1}}.popupDialog{animation:reveal .3s .1s both}</style>",
          );
          document.body.insertAdjacentHTML("beforeend", html);
        }, popup);
      await vi.waitFor(() => expect(notified).toHaveBeenCalledOnce());
      expect(notified.mock.calls[0]![0]).toMatchObject({
        kind: "login",
        code: "CBG_LOGIN_REQUIRED_DIALOG",
      });
      await page.evaluate(() => document.body.setAttribute("data-extra-mutation", "1"));
      expect(notified).toHaveBeenCalledOnce();
      expect(await page.evaluate(() => Reflect.get(window, "loginClicks") || 0)).toBe(0);
    } finally {
      await dispose?.();
      await page.close();
    }
  },
);

it("结束和重新开始不重复绑定，旧一轮通知和清理不能暂停新一轮", async () => {
  const page = await fixture();
  const oldNotify = vi.fn(),
    nextNotify = vi.fn();
  const disposeOld = await watchLoginRequiredDialog(page, new AbortController().signal, oldNotify);
  const oldToken = await page.evaluate(() =>
    Reflect.get(window, "__cbgReportLoginDialog")({ type: "ready" }),
  );
  const disposeNew = await watchLoginRequiredDialog(page, new AbortController().signal, nextNotify);
  try {
    await disposeOld();
    await page.evaluate(
      (token) => Reflect.get(window, "__cbgReportLoginDialog")({ type: "dialog", token }),
      oldToken,
    );
    expect(nextNotify).not.toHaveBeenCalled();
    await page.evaluate((html) => document.body.insertAdjacentHTML("beforeend", html), popup);
    await vi.waitFor(() => expect(nextNotify).toHaveBeenCalledOnce());
    expect(oldNotify).not.toHaveBeenCalled();
    await disposeNew();
    await page.reload();
    await page.evaluate((html) => document.body.insertAdjacentHTML("beforeend", html), popup);
    await page.waitForTimeout(250);
    expect(nextNotify).toHaveBeenCalledOnce();
  } finally {
    await disposeNew();
    await page.close();
  }
});

it("全局取消后不再发送排队点击或悬停，保留原登录错误", async () => {
  const page = await fixture('<button id="target">角色标签</button>');
  const control = new AbortController();
  const dispose = await watchLoginRequiredDialog(page, control.signal, (error) =>
    control.abort(error),
  );
  try {
    const pending = clickForInspection(page.locator("#target"));
    const outcome = pending.catch((error: unknown) => error);
    await page.evaluate((html) => document.body.insertAdjacentHTML("beforeend", html), popup);
    await vi.waitFor(() => expect(control.signal.aborted).toBe(true));
    expect(await outcome).toBe(control.signal.reason);
    await expect(hoverForInspection(page, page.locator("#target"))).rejects.toBe(
      control.signal.reason,
    );
  } finally {
    await dispose();
    await page.close();
  }
});

it.each(["list", "detail"])(
  "%s 页触发后立即取消六个并发，完整资料和八条补采任务保留",
  async (where) => {
    vi.mocked(collectDetail).mockClear();
    const listPage = await fixture();
    const pages: Page[] = [];
    const disposers: (() => Promise<void>)[] = [];
    const control = new AbortController();
    const db = new CrawlStore(":memory:");
    const log = vi.fn();
    const notify = (error: LoginRequiredDialogError) => control.abort(error);
    const makePage = async () => {
      const page = await fixture();
      pages.push(page);
      disposers.push(await watchLoginRequiredDialog(page, control.signal, notify));
      return page;
    };
    vi.mocked(collectDetail).mockImplementation(
      async (_page, row, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(
                new IncompleteCaptureError(
                  "保留本轮资料",
                  { url: row.url, collectedAt: new Date().toISOString(), tabs: [], raw: {} },
                  signal.reason,
                ),
              ),
            { once: true },
          );
        }),
    );
    const complete = analysisRecord("complete-before-pause");
    db.observe(complete.listing);
    expect(db.save(complete.listing, complete.detail!)).toBe(true);
    const queued = Array.from({ length: 8 }, (_, index) => analysisRecord(`pending-${index}`));
    queued.forEach((row) => db.observe(row.listing));
    disposers.push(await watchLoginRequiredDialog(listPage, control.signal, notify));
    const source = createCrawlSource({
      listPage,
      detailPage: await makePage(),
      createDetailPage: makePage,
      signal: control.signal,
      log,
      onDetailProgress: vi.fn(),
    });
    const outcome = crawl(source, db, control.signal, vi.fn(), {
      watch: true,
      concurrency: 6,
    }).catch((error: unknown) => error);
    try {
      await vi.waitFor(
        () => {
          expect(log.mock.calls.filter(([event]) => event === "detail.start")).toHaveLength(6);
          expect(collectDetail).toHaveBeenCalledOnce();
        },
        { timeout: 5000 },
      );
      const before = vi.mocked(collectDetail).mock.calls.length;
      await (where === "list" ? listPage : pages[5]!).evaluate(
        (html) => document.body.insertAdjacentHTML("beforeend", html),
        popup,
      );
      const error = await outcome;
      expect(error).toMatchObject({ kind: "login", code: "CBG_LOGIN_REQUIRED_DIALOG" });
      expect(pages.every((page) => page.isClosed())).toBe(true);
      expect(vi.mocked(collectDetail).mock.calls.length).toBe(before);
      expect(db.count()).toBe(1);
      expect(
        db
          .retryItems()
          .map((row) => row.key)
          .sort(),
      ).toEqual(queued.map((row) => row.listing.key).sort());
      expect(
        db.db.prepare("SELECT count(*) AS n FROM listings WHERE status='failed'").get()?.n,
      ).toBe(0);
    } finally {
      control.abort(new Error("cleanup"));
      await outcome;
      await Promise.allSettled(disposers.map((dispose) => dispose()));
      await Promise.allSettled([listPage, ...pages].map((page) => page.close()));
      db.close();
    }
  },
  15_000,
);
