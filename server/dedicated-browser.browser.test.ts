// 隔离浏览器回归：仅使用临时专用配置和拦截模拟页，不读取日常 Chrome 数据，
// 不访问藏宝阁或其他真实网站；持久化成功不代表官网登录永不过期。
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vite-plus/test";
import type { BrowserContext } from "playwright-core";
import { openDedicatedBrowser } from "./dedicated-browser";

const origin = "http://dedicated-cbg.test";
const cookieName = "dedicated-session-fixture";
const storageName = "dedicated-session-marker";

it("专用配置重开后保留持久 cookie 和 localStorage，其他配置保持隔离", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cbg-dedicated-profile-regression-"));
  vi.stubEnv("CBG_SHOW_WORK_PAGES", "0");
  const directory = path.join(root, "persistent-profile");
  const otherDirectory = path.join(root, "isolated-profile");
  const artifacts = path.resolve("artifacts/dedicated-browser-regression");
  const contexts = new Set<BrowserContext>();
  let failed = false;
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];

  const open = async (profile: string) => {
    const context = await openDedicatedBrowser(profile);
    contexts.add(context);
    await context.route("**/*", (route) => {
      if (new URL(route.request().url()).origin !== origin) return route.abort();
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<meta charset="utf-8"><style>body{font:24px sans-serif;padding:48px;background:#142538;color:#e9f4fa}pre{padding:24px;background:#203c50}</style><h1>专用浏览器持久化回归</h1><p>临时隔离配置 · 全部页面请求已拦截</p><pre id="state"></pre>`,
      });
    });
    const page = await context.newPage();
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    return { context, page };
  };
  const close = async (context: BrowserContext) => {
    await context.close();
    contexts.delete(context);
  };

  try {
    await mkdir(artifacts, { recursive: true });
    const first = await open(directory);
    await first.context.addCookies([
      {
        name: cookieName,
        value: "saved-login-fixture",
        url: origin,
        expires: Math.floor(Date.now() / 1000) + 3600,
      },
    ]);
    await first.page.evaluate(({ key }) => localStorage.setItem(key, "saved-local-fixture"), {
      key: storageName,
    });
    await first.page.locator("#state").evaluate((element) => {
      element.textContent = "首次保存：持久 cookie 和 localStorage 已写入";
    });
    await first.page.screenshot({ path: path.join(artifacts, "01-session-saved.png") });
    await close(first.context);

    const reopened = await open(directory);
    const cookie = (await reopened.context.cookies(origin)).find(
      (item) => item.name === cookieName,
    );
    expect(cookie).toMatchObject({ value: "saved-login-fixture" });
    expect(cookie!.expires).toBeGreaterThan(Date.now() / 1000);
    expect(await reopened.page.evaluate((key) => localStorage.getItem(key), storageName)).toBe(
      "saved-local-fixture",
    );
    await reopened.page.locator("#state").evaluate((element) => {
      element.textContent = "同一配置重开：cookie 已保留；localStorage 已保留";
    });
    await reopened.page.screenshot({ path: path.join(artifacts, "02-session-restored.png") });
    await close(reopened.context);

    const isolated = await open(otherDirectory);
    expect((await isolated.context.cookies(origin)).find((item) => item.name === cookieName)).toBe(
      undefined,
    );
    expect(
      await isolated.page.evaluate((key) => localStorage.getItem(key), storageName),
    ).toBeNull();
    await isolated.page.locator("#state").evaluate((element) => {
      element.textContent = "不同配置目录：cookie 和 localStorage 均不存在";
    });
    await isolated.page.screenshot({ path: path.join(artifacts, "03-profile-isolated.png") });
    await close(isolated.context);
  } catch (error) {
    failed = true;
    primaryError = error;
  } finally {
    try {
      const results = await Promise.allSettled([...contexts].map((context) => context.close()));
      cleanupErrors.push(
        ...results.filter((result) => result.status === "rejected").map((result) => result.reason),
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      vi.unstubAllEnvs();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  const cleanupError = cleanupErrors.length
    ? new AggregateError(cleanupErrors, "隔离 Chrome 测试清理失败")
    : undefined;
  if (failed) {
    // 清理错误另行记录，断言或浏览器操作的原始错误保持为主失败。
    if (cleanupError) console.error(cleanupError);
    throw primaryError;
  }
  if (cleanupError) throw cleanupError;
}, 90_000);
