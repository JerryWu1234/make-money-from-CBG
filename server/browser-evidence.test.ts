import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { errors, type Page } from "playwright-core";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { captureBrowserStep, registerBrowserEvidence } from "./browser-evidence";
import { diagnostics } from "./diagnostics";
import { screenshotsEnabled } from "./runtime-settings";

vi.mock("./runtime-settings", () => ({ screenshotsEnabled: vi.fn(() => true) }));
beforeEach(() => vi.mocked(screenshotsEnabled).mockReturnValue(true));

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});
async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cbg-browser-steps-"));
  directories.push(directory);
  vi.spyOn(diagnostics, "evidenceDirectory").mockReturnValue(directory);
  const screenshot = vi.fn().mockResolvedValue(Buffer.from("png"));
  const page = {
    url: () => "https://xyq.cbg.163.com/equip?s=367&eid=abc&token=private#private",
    screenshot,
  } as unknown as Page;
  registerBrowserEvidence(page);
  return { directory, screenshot, page };
}
async function entries(directory: string) {
  return (await readFile(path.join(directory, "index.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

it("只记录项目注册的工作页", async () => {
  const screenshot = vi.fn();
  const page = { screenshot } as unknown as Page;
  await captureBrowserStep(page, { flow: "query", stage: "opened" });
  expect(screenshot).not.toHaveBeenCalled();
});

it("查询、采集和分析共用目录，有顺序、角色和可对应的PNG与JSON", async () => {
  const { directory, page } = await setup();
  for (const flow of ["query", "collection", "analysis"] as const)
    await captureBrowserStep(page, { flow, stage: "读取完成", key: "367:abc" });
  const records = await entries(directory);
  expect(records.map((record) => record.flow)).toEqual(["query", "collection", "analysis"]);
  expect(new Set(records.map((record) => record.pageId)).size).toBe(1);
  expect(records[2].sequence - records[0].sequence).toBe(2);
  for (const record of records) {
    expect(record.key).toBe("367:abc");
    expect(await readFile(record.screenshot, "utf8")).toBe("png");
    expect(JSON.parse(await readFile(record.metadata, "utf8"))).toEqual(record);
    expect(JSON.stringify(record)).not.toContain("private");
  }
});

it("截图失败保留业务错误与截图错误，后续页面仍可继续记录", async () => {
  const { directory, page, screenshot } = await setup();
  screenshot.mockRejectedValueOnce(new Error("page closed"));
  await captureBrowserStep(page, {
    flow: "collection",
    stage: "坐骑读取失败",
    error: new Error("原始读取超时"),
  });
  await captureBrowserStep(page, { flow: "analysis", stage: "读取完成" });
  const records = await entries(directory);
  expect(records[0]).toMatchObject({
    error: { message: "原始读取超时" },
    screenshotError: { message: "page closed" },
  });
  expect(records[0].screenshot).toBeUndefined();
  expect(records[1].screenshot).toBeTruthy();
});

it("同一工作页后续步骤继承当前角色，切换角色时更新关联", async () => {
  const { directory, page } = await setup();
  await captureBrowserStep(page, { flow: "collection", stage: "opened", key: "367:a" });
  await captureBrowserStep(page, { flow: "collection", stage: "技能读取完成" });
  await captureBrowserStep(page, { flow: "collection", stage: "opened", key: "367:b" });
  await captureBrowserStep(page, { flow: "collection", stage: "坐骑读取完成" });
  expect((await entries(directory)).map((entry) => entry.key)).toEqual([
    "367:a",
    "367:a",
    "367:b",
    "367:b",
  ]);
});

it("并发业务步骤最多同时发起两个截图请求，并记录排队耗时", async () => {
  const { directory, page, screenshot } = await setup();
  let active = 0;
  let maximum = 0;
  screenshot.mockImplementation(async () => {
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active--;
    return Buffer.from("png");
  });
  await Promise.all(
    Array.from({ length: 10 }, (_, index) => {
      const workPage = { url: () => page.url(), screenshot } as unknown as Page;
      registerBrowserEvidence(workPage);
      return captureBrowserStep(workPage, { flow: "collection", stage: `read-${index}` });
    }),
  );
  expect(maximum).toBe(2);
  const records = await entries(directory);
  expect(records).toHaveLength(10);
  expect(records.every((entry) => entry.screenshot)).toBe(true);
  expect(records.some((entry) => entry.queueWaitMs >= 20)).toBe(true);
});

it("原生截图超时及清理结束后才允许同页后续截图，保留完整原错", async () => {
  const { directory, page, screenshot } = await setup();
  const timeout = new errors.TimeoutError(
    "page.screenshot: Timeout 15000ms exceeded.\nCall log:\n  - waiting for fonts to load...",
  );
  let cleaned = false;
  screenshot
    .mockImplementationOnce(async (options) => {
      expect(options).toMatchObject({ fullPage: true, timeout: 15000 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      cleaned = true;
      throw timeout;
    })
    .mockImplementationOnce(async () => {
      expect(cleaned).toBe(true);
      return Buffer.from("next-png");
    });
  await Promise.all([
    captureBrowserStep(page, { flow: "collection", stage: "stalled" }),
    captureBrowserStep(page, { flow: "collection", stage: "next" }),
  ]);
  const records = await entries(directory);
  const failed = records.find((record) => record.stage === "stalled");
  expect(failed.screenshotError).toMatchObject({ name: "TimeoutError", message: timeout.message });
  expect(failed.screenshot).toBeUndefined();
  expect(records.find((record) => record.stage === "next").screenshot).toBeTruthy();
  expect((await readdir(directory)).filter((name) => name.endsWith(".png"))).toHaveLength(1);
});

it("同页并发截图串行，不叠加原生截图操作", async () => {
  const { page, screenshot } = await setup();
  let active = 0,
    maximum = 0;
  screenshot.mockImplementation(async () => {
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return Buffer.from("png");
  });
  await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      captureBrowserStep(page, { flow: "collection", stage: `same-${index}` }),
    ),
  );
  expect(maximum).toBe(1);
});

it("暂停取消原生截图并等它清理后再处理同页下一步，不保存取消后的图片", async () => {
  const { directory, page, screenshot } = await setup();
  const control = new AbortController();
  let cleaned = false;
  screenshot
    .mockImplementationOnce(
      (options) =>
        new Promise((_, reject) => {
          expect(options.signal).toBe(control.signal);
          options.signal.addEventListener(
            "abort",
            () => {
              setTimeout(() => {
                cleaned = true;
                reject(new Error("operation was aborted"));
              }, 20);
            },
            { once: true },
          );
        }),
    )
    .mockImplementationOnce(async () => {
      expect(cleaned).toBe(true);
      return Buffer.from("next");
    });
  const first = captureBrowserStep(
    page,
    { flow: "collection", stage: "cancelled" },
    control.signal,
  );
  await vi.waitFor(() => expect(screenshot).toHaveBeenCalledOnce());
  control.abort(new Error("用户暂停"));
  const second = captureBrowserStep(page, { flow: "collection", stage: "next" });
  await Promise.all([first, second]);
  expect((await entries(directory)).map((record) => record.stage)).toEqual(["next"]);
  expect((await readdir(directory)).filter((name) => name.endsWith(".png"))).toHaveLength(1);
});

it("暂停前未开始截图或排队时暂停不会新发起截图", async () => {
  const { page, screenshot } = await setup();
  const control = new AbortController();
  control.abort();
  await captureBrowserStep(page, { flow: "collection", stage: "cancelled" }, control.signal);
  expect(screenshot).not.toHaveBeenCalled();
});

it("关闭截图仍记录业务错误和步骤，重新开启后关联关闭期间切换的角色", async () => {
  const { directory, page, screenshot } = await setup();
  await captureBrowserStep(page, { flow: "collection", stage: "opened", key: "367:a" });
  vi.mocked(screenshotsEnabled).mockReturnValue(false);
  await captureBrowserStep(page, {
    flow: "collection",
    stage: "读取失败",
    key: "367:b",
    error: new Error("原始读取错误"),
  });
  vi.mocked(screenshotsEnabled).mockReturnValue(true);
  await captureBrowserStep(page, { flow: "analysis", stage: "读取完成" });
  const records = await entries(directory);
  expect(screenshot).toHaveBeenCalledTimes(2);
  expect(records[1]).toMatchObject({
    key: "367:b",
    screenshotDisabled: true,
    error: { message: "原始读取错误" },
  });
  expect(records[1].screenshot).toBeUndefined();
  expect(records[1].screenshotError).toBeUndefined();
  expect(records[2].key).toBe("367:b");
  expect(records[2].screenshot).toBeTruthy();
});

it("运行中关闭让当前截图完成，排队截图在开始前读取最新开关", async () => {
  const { directory, page, screenshot } = await setup();
  let finish!: (value: Buffer) => void;
  screenshot.mockImplementationOnce(() => new Promise<Buffer>((resolve) => (finish = resolve)));
  const first = captureBrowserStep(page, { flow: "analysis", stage: "in-progress" });
  await vi.waitFor(() => expect(screenshot).toHaveBeenCalledOnce());
  const queued = captureBrowserStep(page, { flow: "analysis", stage: "queued" });
  vi.mocked(screenshotsEnabled).mockReturnValue(false);
  finish(Buffer.from("completed-before-disable"));
  await Promise.all([first, queued]);
  expect(screenshot).toHaveBeenCalledOnce();
  const records = await entries(directory);
  expect(records.find((entry) => entry.stage === "in-progress").screenshot).toBeTruthy();
  expect(records.find((entry) => entry.stage === "queued")).toMatchObject({
    screenshotDisabled: true,
  });
  expect((await readdir(directory)).filter((name) => name.endsWith(".png"))).toHaveLength(1);
});
