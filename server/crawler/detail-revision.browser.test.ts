import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { chromium, type Browser, type Page } from "playwright-core";
import { readDetailRevision } from "./detail-read-state";
import type { Listing } from "./types";

const listing = { serverId: "367", eid: "stable-role" } as Listing;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
afterAll(async () => {
  await browser?.close();
});
async function fixture() {
  page = await browser.newPage();
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><div data-cbg-detail-root>价格：￥100</div><textarea id="equip_desc_value">stable-public-role</textarea><script>window.EquipInfo={server_id:"367",eid:"stable-role"};window.decode_desc=function(value){return value};window.RoleInfoParser=class {parse(value){return value}};window.CBG_GAME_CONFIG={equip_info:{},version:1};</script>`,
    }),
  );
  await page.goto("http://127.0.0.1:48180/revision-fixture");
  return page;
}
describe("商品资料版本只跟踪实际来源", () => {
  it("无关脚本增删及跟踪参数变化不使已读角色失效", async () => {
    const page = await fixture();
    try {
      const before = await readDetailRevision(page, listing);
      await page.evaluate(() => {
        const script = document.createElement("script");
        script.src = "data:text/javascript,void%200#tracking=1";
        document.head.appendChild(script);
      });
      expect(await readDetailRevision(page, listing)).toBe(before);
      await page.evaluate(() => {
        document.scripts[1].src = "data:text/javascript,void%200#tracking=2";
      });
      expect(await readDetailRevision(page, listing)).toBe(before);
    } finally {
      await page.close();
    }
  });
  it.each(["encoded", "price", "identity", "parser", "parser-prototype", "config"])(
    "真实%s变化仍使本轮已读资料失效",
    async (kind) => {
      const page = await fixture();
      try {
        const before = await readDetailRevision(page, listing);
        await page.evaluate((kind) => {
          const globals = window as unknown as {
            EquipInfo: { eid: string };
            RoleInfoParser: { prototype: { parse(value: unknown): unknown } };
            CBG_GAME_CONFIG: { version: number };
          };
          if (kind === "encoded")
            document.querySelector<HTMLTextAreaElement>("#equip_desc_value")!.value =
              "changed-source";
          if (kind === "price")
            document.querySelector<HTMLElement>("[data-cbg-detail-root]")!.innerText =
              "价格：￥200";
          if (kind === "identity") globals.EquipInfo.eid = "other-role";
          if (kind === "parser")
            globals.RoleInfoParser = class {
              parse(value: unknown) {
                return [value];
              }
            };
          if (kind === "parser-prototype")
            globals.RoleInfoParser.prototype.parse = (value: unknown) => [value];
          if (kind === "config") globals.CBG_GAME_CONFIG.version = 2;
        }, kind);
        expect(await readDetailRevision(page, listing)).not.toBe(before);
      } finally {
        await page.close();
      }
    },
  );
  it.each(["getter", "toJSON", "circular"])(
    "公开配置含%s时被动取证，不执行可选代码且版本稳定",
    async (kind) => {
      const page = await fixture();
      try {
        await page.evaluate((kind) => {
          const globals = window as unknown as {
            CBG_GAME_CONFIG: Record<string, unknown>;
            optionalCalls: number;
          };
          globals.optionalCalls = 0;
          const config = globals.CBG_GAME_CONFIG;
          if (kind === "getter")
            Object.defineProperty(config, "optional", {
              enumerable: true,
              get() {
                globals.optionalCalls++;
                throw new Error("optional getter must not run");
              },
            });
          if (kind === "toJSON")
            config.toJSON = () => {
              globals.optionalCalls++;
              throw new Error("optional toJSON must not run");
            };
          if (kind === "circular") config.self = config;
        }, kind);
        const before = await readDetailRevision(page, listing);
        expect(before).toMatch(/^[a-f0-9]{64}$/);
        expect(await readDetailRevision(page, listing)).toBe(before);
        expect(await page.evaluate(() => Reflect.get(window, "optionalCalls"))).toBe(0);
      } finally {
        await page.close();
      }
    },
  );
  it("全局配置accessor只摘要定义，不触发访问", async () => {
    const page = await fixture();
    try {
      await page.evaluate(() => {
        Reflect.set(window, "optionalCalls", 0);
        Object.defineProperty(window, "CBG_GAME_CONFIG", {
          configurable: true,
          get() {
            Reflect.set(window, "optionalCalls", Reflect.get(window, "optionalCalls") + 1);
            throw new Error("global config getter must not run");
          },
        });
      });
      const before = await readDetailRevision(page, listing);
      expect(before).toMatch(/^[a-f0-9]{64}$/);
      expect(await readDetailRevision(page, listing)).toBe(before);
      expect(await page.evaluate(() => Reflect.get(window, "optionalCalls"))).toBe(0);
    } finally {
      await page.close();
    }
  });
  it("不可读配置代理只使本件未完整，不能抛普通Error中断全轮", async () => {
    const page = await fixture();
    try {
      await page.evaluate(() => {
        Reflect.set(
          window,
          "CBG_GAME_CONFIG",
          new Proxy(
            {},
            {
              ownKeys() {
                throw new Error("unreadable config proxy");
              },
            },
          ),
        );
      });
      await expect(readDetailRevision(page, listing)).rejects.toMatchObject({
        name: "IncompleteDetailError",
      });
    } finally {
      await page.close();
    }
  });
});
