import type { Page } from "playwright-core";
import { expect, it, vi } from "vite-plus/test";
import { accessNavigationFailure } from "./access-navigation";

const destroyed = () =>
  new Error("page.evaluate: Execution context was destroyed, most likely because of a navigation");
const fakePage = (address: () => string, waitForURL = vi.fn().mockResolvedValue(undefined)) =>
  ({
    url: address,
    isClosed: () => false,
    waitForURL,
  }) as unknown as Page;

it.each(["/cgi-bin/login.py", "/cgi-bin/show_login.py", "/login"])(
  "识别登录路径 %s，不等待或重新请求详情",
  async (pathname) => {
    const wait = vi.fn();
    const page = fakePage(() => "https://xyq.cbg.163.com" + pathname, wait);
    const error = await accessNavigationFailure(page, destroyed());
    expect(error).toMatchObject({ kind: "login", name: "CrawlAccessError" });
    expect(wait).not.toHaveBeenCalled();
  },
);

it("上下文销毁后只等待一次登录导航，身份不明仍保留原错误", async () => {
  const wait = vi.fn();
  const page = fakePage(() => "https://xyq.cbg.163.com/equip?s=1&eid=other", wait);
  const error = destroyed();
  expect(await accessNavigationFailure(page, error)).toBeUndefined();
  expect(await accessNavigationFailure(page, error)).toBeUndefined();
  expect(wait).toHaveBeenCalledOnce();
});

it("延迟进入登录页时分类登录；等待过程中暂停则保留取消原因", async () => {
  let address = "https://xyq.cbg.163.com/equip?s=1&eid=a";
  const page = fakePage(
    () => address,
    vi.fn(async () => {
      address = "https://xyq.cbg.163.com/cgi-bin/show_login.py";
    }),
  );
  expect(await accessNavigationFailure(page, destroyed())).toMatchObject({ kind: "login" });
  const control = new AbortController(),
    reason = new Error("用户暂停");
  const cancelled = fakePage(
    () => "https://xyq.cbg.163.com/equip",
    vi.fn(async () => {
      control.abort(reason);
    }),
  );
  await expect(accessNavigationFailure(cancelled, destroyed(), control.signal)).rejects.toBe(
    reason,
  );
});

it("其它站点、未知错误和商品跳转不能被当作已登录或自动恢复", async () => {
  const wait = vi.fn();
  const page = fakePage(() => "https://example.test/cgi-bin/show_login.py", wait);
  expect(await accessNavigationFailure(page, new Error("未知错误"))).toBeUndefined();
  expect(wait).not.toHaveBeenCalled();
});
