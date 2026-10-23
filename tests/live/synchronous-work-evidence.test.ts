import { afterEach, describe, expect, it } from "vite-plus/test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Page } from "playwright-core";
import { instrumentWorkPage, startSynchronousWorkEvidence } from "./synchronous-work-evidence";

function fixture() {
  const order: string[] = [];
  const locator = {
    first() {
      return this;
    },
    nth() {
      return this;
    },
    filter() {
      return this;
    },
    locator() {
      return this;
    },
    toString() {
      return "locator('#actual_control')";
    },
    async fill(value: string) {
      order.push("fill:" + value);
    },
    async evaluate() {
      order.push("tooltip-read");
      return "水晶棒\n等级70\n未鉴定物品";
    },
    async click() {
      throw new Error("website_failure");
    },
  };
  const page = {
    locator() {
      return locator;
    },
    getByText() {
      return locator;
    },
    async evaluate() {
      order.push("query-read");
      return { kindid: "11" };
    },
    mouse: {
      async up() {
        order.push("mouse-up");
      },
    },
  };
  return { page: page as unknown as Page, locator, order };
}

describe("同步工作页截图接线", () => {
  it("填写及链式字符串详情读取必须等待证据完成再返回，并能恢复方法", async () => {
    const { page, order } = fixture();
    const original = Object.getOwnPropertyDescriptor(page, "locator")!.value;
    const restore = instrumentWorkPage(page, async (step) => {
      order.push("saved:" + step.method);
    });
    await page.locator("#actual_control").filter({ visible: true }).first().nth(0).fill("58");
    const text = await page.getByText("水晶棒").evaluate(() => "unused");
    await page.mouse.up();
    expect(text).toContain("未鉴定物品");
    expect(order).toEqual([
      "fill:58",
      "saved:locator.fill",
      "tooltip-read",
      "saved:locator.evaluate",
      "mouse-up",
      "saved:mouse.up",
    ]);
    restore();
    expect(Object.getOwnPropertyDescriptor(page, "locator")!.value).toBe(original);
    await page.locator("#actual_control").fill("59");
    expect(order.at(-1)).toBe("fill:59");
  });
  it("证据失败保持业务返回和原始网站异常，另报审核受阻", async () => {
    const { page } = fixture();
    const failures: string[] = [];
    const restore = instrumentWorkPage(
      page,
      async () => {
        throw new Error("disk_full");
      },
      (error) => failures.push(String(error)),
    );
    await expect(page.evaluate(() => ({}))).resolves.toEqual({ kindid: "11" });
    await expect(page.locator("#actual_control").click()).rejects.toThrow("website_failure");
    expect(failures).toEqual(["Error: disk_full", "Error: disk_full"]);
    restore();
  });
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function workConnection() {
  const observation = {
    gate: false,
    url: "https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py",
    title: "公开装备查询",
    controls: [{ id: "txt_init_defense", value: "" }],
    queryArgs: {},
    submittedArgs: { serverid: "94", kindid: "11" },
    product: { eid: "public-product", serverid: "94" },
    description: "等级70\n防御58",
    tooltips: [],
    visibleText: "装备查询",
  };
  let currentUrl = "about:blank",
    failScreenshot = false,
    screenshots = 0,
    drift = 0,
    readText = "等级70\n防御58";
  const control = {
    toString: () => "locator('#txt_init_defense')",
    async fill(value: string) {
      observation.controls[0].value = value;
    },
  };
  const page = {
    url: () => currentUrl,
    isClosed: () => false,
    locator: () => control,
    async goto(url: string) {
      currentUrl = url;
    },
    async evaluate(_callback: unknown, args: unknown) {
      return args ? structuredClone(observation) : readText;
    },
    async screenshot() {
      screenshots++;
      if (drift > 0) {
        observation.visibleText += "changed";
        drift--;
      }
      if (failScreenshot) throw new Error("screenshot_timeout");
      return Buffer.from("test-only-png");
    },
    mouse: {},
  } as unknown as Page;
  const context = Object.assign(new EventEmitter(), { pages: () => [] });
  const browser = Object.assign(new EventEmitter(), {
    contexts: () => [context],
    isConnected: () => true,
  });
  return {
    observation,
    page,
    context,
    browser: browser as unknown as Browser,
    disconnect: () => browser.emit("disconnected"),
    read: (value: string) => {
      readText = value;
    },
    fail: () => {
      failScreenshot = true;
    },
    screenshots: () => screenshots,
    drift: (count = 1) => {
      drift = count;
    },
  };
}

async function outputDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "cbg-sync-evidence-"));
  directories.push(directory);
  return directory;
}

describe("同步截图索引与审核边界", () => {
  it("新页事件同步安装，保存实际填写、提交参数和字符串详情，gate不落图", async () => {
    const connection = workConnection(),
      directory = await outputDirectory();
    const blocked: string[] = [];
    const evidence = await startSynchronousWorkEvidence(directory, connection.browser, (reason) =>
      blocked.push(reason),
    );
    connection.context.emit("page", connection.page);
    await connection.page.goto(connection.observation.url);
    await connection.page.locator("#txt_init_defense").fill("58");
    await connection.page.evaluate(() => "unused");
    connection.read("账号：private-account\n等级70\n防御58");
    await connection.page.evaluate(() => "body read");
    connection.observation.gate = true;
    await connection.page.locator("#txt_init_defense").fill("59");
    const indexFile = await evidence.stop();
    const index = JSON.parse(await readFile(path.join(directory, indexFile.name), "utf8"));
    expect(blocked).toEqual([]);
    expect(index.entries.map((entry: { state: string }) => entry.state)).toEqual([
      "captured",
      "captured",
      "captured",
      "captured",
      "gate",
    ]);
    expect(connection.screenshots()).toBe(4);
    const filled = JSON.parse(
      await readFile(path.join(directory, index.entries[1].files[1].name), "utf8"),
    );
    expect(filled.observation.controls).toEqual([{ id: "txt_init_defense", value: "58" }]);
    expect(filled.observation.submittedArgs).toEqual({ serverid: "94", kindid: "11" });
    const detail = JSON.parse(
      await readFile(path.join(directory, index.entries[2].files[1].name), "utf8"),
    );
    expect(detail.readResult).toEqual({ text: "等级70\n防御58" });
    const body = await readFile(path.join(directory, index.entries[3].files[1].name), "utf8");
    expect(JSON.parse(body).readResult).toBeUndefined();
    expect(body).not.toContain("private-account");
    expect(index.entries[4].files).toBeUndefined();
  });
  it("截图失败独立阻塞审核，原填写仍成功并保留断点原因", async () => {
    const connection = workConnection(),
      directory = await outputDirectory();
    const blocked: string[] = [];
    const evidence = await startSynchronousWorkEvidence(directory, connection.browser, (reason) =>
      blocked.push(reason),
    );
    connection.context.emit("page", connection.page);
    await connection.page.goto(connection.observation.url);
    connection.fail();
    await expect(connection.page.locator("#txt_init_defense").fill("58")).resolves.toBeUndefined();
    expect(evidence.auditBlocked).toContain("evidence_failed");
    const indexFile = await evidence.stop();
    const index = JSON.parse(await readFile(path.join(directory, indexFile.name), "utf8"));
    expect(index.entries[1].state).toBe("failed");
    expect(index.entries[1].files).toBeUndefined();
    expect(blocked).toHaveLength(1);
  });
  it("状态漂移不冒充已截图，断线审核必须重新安装后才能恢复", async () => {
    const connection = workConnection(),
      directory = await outputDirectory();
    const blocked: string[] = [];
    const evidence = await startSynchronousWorkEvidence(directory, connection.browser, (reason) =>
      blocked.push(reason),
    );
    connection.context.emit("page", connection.page);
    await connection.page.goto(connection.observation.url);
    connection.drift();
    await connection.page.locator("#txt_init_defense").fill("58");
    expect(evidence.auditBlocked).toBeUndefined();
    connection.drift(3);
    await connection.page.locator("#txt_init_defense").fill("59");
    expect(evidence.auditBlocked).toContain("evidence_failed");
    await evidence.rearm(connection.browser);
    expect(evidence.auditBlocked).toBeUndefined();
    connection.disconnect();
    expect(evidence.auditBlocked).toBe("production_browser_disconnected_reinstall_before_retry");
    const indexFile = await evidence.stop();
    const index = JSON.parse(await readFile(path.join(directory, indexFile.name), "utf8"));
    expect(index.entries[1].state).toBe("captured");
    expect(index.entries[1].attempts.map((attempt: { reason: string }) => attempt.reason)).toEqual([
      "state_changed_during_screenshot",
      "stable",
    ]);
    expect(index.entries[2].state).toBe("failed");
    expect(index.entries[2].files).toBeUndefined();
    expect(blocked).toHaveLength(2);
  });
});
