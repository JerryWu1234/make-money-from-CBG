import { afterAll, beforeAll, expect, it, vi } from "vite-plus/test";
import { chromium, type Browser, type Page } from "playwright-core";
import { readFileSync } from "node:fs";
import { collectDetail } from "./detail";
import { captureIssues, IncompleteCaptureError } from "./capture-readiness";
import { collectNativeDetail } from "../adapters/native-capture";
import type { PageSnapshot, SemanticTarget } from "../adapters/contracts";
import type { Listing, RoleDetail } from "./types";
// @ts-expect-error Offline fixture is shared with the Node regression runner.
import { completeRole, completeRoleDocument } from "../../tests/fixtures/complete-role.mjs";
vi.mock("./page", async (original) => ({
  ...(await original<typeof import("./page")>()),
  pace: async () => {},
}));
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
afterAll(async () => {
  await browser?.close();
});
const listing = {
  key: "367:coverage-role",
  serverId: "367",
  eid: "coverage-role",
  ordersn: "coverage",
  url: "https://xyq.cbg.163.com/equip?s=367&eid=coverage-role",
  attrs: {},
  summary: null,
} as Listing;
async function pageFixture(options = {}) {
  const page = await browser.newPage();
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body:
        new URL(route.request().url()).pathname === "/equip" ? completeRoleDocument(options) : "",
    }),
  );
  return page;
}
function assets(detail: RoleDetail) {
  const normalized = (fields: { name: string; value: string }[]) =>
    fields.map((f) => ({ ...f, name: f.name.replace(/[：:]$/, "").trim() }));
  const tab = (name: string) => detail.tabs.find((tab) => tab.name === name)!;
  const item = (item: NonNullable<ReturnType<typeof tab>["items"]>[number]) => ({
    name: item.name,
    kind: item.kind,
    category: item.category,
    location: item.location,
    level: item.level,
    description: item.description,
    attributes: item.attributes,
    observation: item.skillObservation,
  });
  return {
    person: normalized(tab("人物/修炼").fields).filter((field) =>
      ["名称", "等级", "攻击修炼", "气血"].includes(field.name),
    ),
    skills: tab("技能").items?.map(item),
    gear: tab("道具/法宝").items?.map(item),
    pets: tab("召唤兽/孩子").pets?.map((pet) => ({
      name: pet.name,
      fields: pet.fields,
      skills: pet.skills.map(item),
      equipment: pet.equipment.map(item),
      inner: pet.innerSkills.map(item),
    })),
    mounts: detail.tabs
      .filter((tab) => tab.name.startsWith("坐骑 /"))
      .map((tab) =>
        normalized(tab.fields).filter((field) => ["名称", "坐骑成长"].includes(field.name)),
      ),
    clothes: normalized(tab("锦衣/外观").fields).filter((field) =>
      ["锦衣", "祥瑞"].includes(field.name),
    ),
    home: normalized(tab("玩家之家").fields).filter((field) =>
      ["房屋", "庭院"].includes(field.name),
    ),
    valuation: detail.valuation?.fields,
  };
}
function verifyLedger(detail: RoleDetail) {
  const result = assets(detail);
  expect(result.person).toEqual([
    { name: "名称", value: completeRole.name },
    { name: "等级", value: completeRole.level },
    { name: "攻击修炼", value: completeRole.attackTraining },
    { name: "气血", value: "5000" },
  ]);
  expect(
    result.skills?.filter((s) => s.category === "师门技能").map((s) => [s.name, s.level]),
  ).toEqual(completeRole.schoolSkills.map((s: any) => [s.name, String(s.level)]));
  expect(
    result.skills?.filter((s) => s.category !== "师门技能").map((s) => [s.name, s.level]),
  ).toEqual([
    [completeRole.life.name, String(completeRole.life.level)],
    [completeRole.auxiliary.name, String(completeRole.auxiliary.level)],
  ]);
  expect(result.gear?.map((g) => [g.name, g.location])).toEqual(
    completeRole.gear.map((g: any) => [g.name, g.location]),
  );
  expect(result.gear?.map((item) => [item.kind, item.category])).toEqual([
    ["equipment", "武器"],
    ["equipment", "头盔"],
  ]);
  expect(result.gear?.[0].description).toContain("伤害：420");
  expect(result.gear?.[0].description).toContain("等级：100");
  expect(result.gear?.[0].description).toContain("命中：500");
  expect(result.gear?.[1].description).toContain("等级：100");
  expect(result.gear?.[1].description).toContain("防御：80");
  expect(result.gear?.[1].description).toContain("魔法：120");
  expect(
    result.pets?.map((p) => [
      p.name,
      p.skills.map((s) => s.name),
      p.equipment.map((e) => e.name),
      p.inner.map((s) => s.name),
    ]),
  ).toEqual(completeRole.pets.map((p: any) => [p.name, p.skills, [p.equipment], [p.inner]]));
  for (const [index, pet] of (result.pets || []).entries()) {
    const fields = Object.fromEntries(
      pet.fields.map((f) => [f.name.replace(/[：:]$/, ""), f.value]),
    );
    expect(fields).toMatchObject({
      名称: completeRole.pets[index].name,
      类型: "幽灵",
      等级: String(100 + index),
      成长: "1.280",
      ...Object.fromEntries(
        ["攻击资质", "防御资质", "体力资质", "法力资质", "速度资质", "躲闪资质"].map((k) => [
          k,
          String(1400 + index),
        ]),
      ),
    });
    expect(pet.inner.map((s) => s.level)).toEqual(["5"]);
    expect(pet.skills.every((s) => s.observation?.state === "current")).toBe(true);
  }
  expect(detail.tabs.find((t) => t.name.includes(completeRole.child))?.text).toContain(
    completeRole.child,
  );
  expect(detail.sourceEvidence).toMatchObject({
    version: 1,
    serverId: "367",
    eid: "coverage-role",
    stable: true,
  });
  expect(detail.sourceEvidence?.initialRevision).toMatch(/^[a-f0-9]{64}$/);
  expect(detail.sourceEvidence?.finalRevision).toBe(detail.sourceEvidence?.initialRevision);
  expect(detail.sourceEvidence?.fields).toEqual(
    expect.arrayContaining([
      { path: "tabs.道具/法宝.items[0].description", source: "tooltip", state: "observed" },
      { path: "tabs.锦衣/外观.content", source: "visible-text", state: "observed" },
      { path: "tabs.玩家之家.content", source: "visible-text", state: "observed" },
    ]),
  );
  expect(result.mounts).toEqual(
    completeRole.mounts.map((m: any) => [
      { name: "名称", value: m.name },
      { name: "坐骑成长", value: String(m.grow / 100) },
    ]),
  );
  expect(result.clothes).toEqual([
    { name: "锦衣", value: completeRole.clothes },
    { name: "祥瑞", value: completeRole.accessory },
  ]);
  expect(result.home).toEqual([
    { name: "房屋", value: completeRole.home },
    { name: "庭院", value: completeRole.garden },
  ]);
  expect(result.valuation).toEqual(
    expect.arrayContaining([
      { name: "坐骑总数", value: "2", tab: "坐骑" },
      { name: "现金", value: "1000", tab: "道具/法宝" },
      { name: "存银", value: "2000", tab: "道具/法宝" },
      { name: "储备金", value: "3000", tab: "道具/法宝" },
      { name: "仙玉", value: "400", tab: "道具/法宝" },
    ]),
  );
  expect(captureIssues(detail, true, true, listing)).toEqual([]);
  return result;
}
it("preserves every field and count while closed skill fields use attributes and equipment remains demand-read", async () => {
  const results = [];
  const hovers: string[][] = [];
  for (const demand of [false, true]) {
    const page = await pageFixture({ demand });
    try {
      const detail = await collectDetail(page, listing, new AbortController().signal);
      results.push(verifyLedger(detail));
      hovers.push(await page.evaluate(() => Reflect.get(window, "coverageHovers")));
      expect(await page.evaluate(() => Reflect.get(window, "coverageVisits"))).toEqual(
        expect.arrayContaining([
          "人物/修炼",
          "技能",
          "道具/法宝",
          "召唤兽/孩子",
          "坐骑",
          "锦衣/外观",
          "玩家之家",
        ]),
      );
    } finally {
      await page.close();
    }
  }
  expect(results[0]).toEqual(results[1]);
  expect(hovers[0]).toContain("覆盖武器");
  for (const skill of [...completeRole.schoolSkills, completeRole.life, completeRole.auxiliary])
    expect(hovers.flat()).not.toContain(skill.name);
  expect(hovers[0]).toContain("仓库头盔");
  expect(hovers[1]).toEqual(expect.arrayContaining(["覆盖武器", "仓库头盔"]));
}, 60000);

it.each(["getter", "serialization"])(
  "retains all seven tabs after a final raw %s failure",
  async (kind) => {
    const page = await pageFixture();
    try {
      await page.addInitScript((kind) => {
        document.addEventListener("click", (event) => {
          if ((event.target as HTMLElement)?.textContent?.trim() === "玩家之家") {
            Reflect.set(window, "rawFailureInjected", true);
            if (kind === "getter")
              Object.defineProperty(window, "RoleData", {
                configurable: true,
                get() {
                  throw new Error("raw getter regression");
                },
              });
            else
              Reflect.set(window, "RoleData", {
                toJSON() {
                  throw new Error("raw serialization regression");
                },
              });
          }
        });
      }, kind);
      const error = await collectDetail(page, listing, new AbortController().signal).then(
        () => null,
        (error) => error,
      );
      expect(await page.evaluate(() => Reflect.get(window, "rawFailureInjected"))).toBe(true);
      expect(error).toBeInstanceOf(IncompleteCaptureError);
      expect(error.detail.tabs.map((tab: { name: string }) => tab.name)).toEqual(
        expect.arrayContaining([
          "人物/修炼",
          "技能",
          "道具/法宝",
          "召唤兽/孩子",
          "坐骑",
          "锦衣/外观",
          "玩家之家",
        ]),
      );
      expect(error.cause.cause.message).toContain(`raw ${kind} regression`);
    } finally {
      await page.close();
    }
  },
  30000,
);

async function installObserver(page: Page) {
  await page.goto(listing.url);
  await page.evaluate(() => {
    const g = window as any;
    g.coverageSnapshots = [];
    g.coverageListeners = [];
    g.chrome = {
      runtime: {
        id: "coverage-extension",
        sendMessage: async (message: any) => {
          if (message.kind === "snapshot")
            g.coverageSnapshots.push(message.snapshot ?? message.payload ?? message);
        },
        onMessage: { addListener: (l: any) => g.coverageListeners.push(l) },
      },
    };
  });
  for (const file of [
    "market-config.js",
    "market-rules.js",
    "pet-product-observation.js",
    "main.js",
    "isolated.js",
  ])
    await page.addScriptTag({
      content: readFileSync(new URL(`../../extension/cbg-access/${file}`, import.meta.url), "utf8"),
    });
  await page.evaluate(async () => {
    const g = window as any;
    await new Promise((resolve) =>
      g.coverageListeners[0]({ kind: "bind" }, { id: "coverage-extension" }, resolve),
    );
  });
}
async function nativeSnapshot(page: Page): Promise<PageSnapshot> {
  await page.waitForFunction(() => {
    const g = window as any;
    return g.coverageSnapshots.some(
      (s: any) => s.productRevision && s.detail?.tabs?.[0]?.name !== "未知标签",
    );
  });
  return page.evaluate(() => {
    const g = window as any,
      s = g.coverageSnapshots.at(-1);
    return {
      ...s,
      context: {
        pageId: s.pageId,
        pageGeneration: s.pageGeneration,
        observedAt: s.observedAt,
        receivedAt: s.observedAt,
        stopEpoch: 0,
        browserSessionEpoch: "coverage",
        runId: "coverage",
        queryId: "coverage",
      },
    };
  });
}
it("compares the same complete source ledger with the actual MAIN/ISOLATED and native collector", async () => {
  const page = await pageFixture();
  try {
    await installObserver(page);
    const snapshot = () => nativeSnapshot(page);
    const query = async (target: SemanticTarget) => {
      const before = await page.evaluate(() => (window as any).coverageSnapshots.length);
      await page.evaluate((target) => {
        const g = window as any;
        if (target.kind === "detail-tab") g.show(target.name);
        else if (target.kind === "detail-entry") {
          if (target.section === "pet") g.selectPet(target.index);
          if (target.section === "mount") g.selectMount(target.index);
          if (target.section === "child")
            (document.querySelector("[data-child-id]") as HTMLElement).click();
        } else if (target.kind === "inspect-item") {
          const el = [...document.querySelectorAll<HTMLElement>("img[data_equip_name]")].find(
            (el) => el.getAttribute("data_equip_name") === target.name,
          )!;
          el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        } else throw new Error("Unexpected coverage operation " + target.kind);
        g.coverageListeners[0]({ kind: "capture" }, { id: "coverage-extension" }, () => {});
      }, target);
      await page.waitForFunction(
        (before) => (window as any).coverageSnapshots.length > before,
        before,
      );
      return snapshot();
    };
    const detail = await collectNativeDetail(
      {
        observer: {
          mode: "extension-native",
          snapshot,
          waitFor: async () => snapshot(),
          evidence: async () => {
            const s = await snapshot();
            return { context: s.context, revision: s.revision, snapshot: s };
          },
          close: async () => {},
        },
        query,
      },
      listing,
      new AbortController().signal,
    );
    verifyLedger(detail);
  } finally {
    await page.close();
  }
}, 60000);

it.each([{ missingRiders: true }, { missingPetSection: true }])(
  "keeps missing source evidence partial: %j",
  async (options) => {
    const page = await pageFixture(options);
    try {
      const result = await collectDetail(page, listing, new AbortController().signal).catch(
        (error) => {
          if (error instanceof IncompleteCaptureError) return error.detail;
          throw error;
        },
      );
      expect(captureIssues(result, true, true, listing).length).toBeGreaterThan(0);
      if (options.missingRiders)
        expect(result.valuation?.fields).not.toContainEqual({
          name: "坐骑总数",
          value: "0",
          tab: "坐骑",
        });
    } finally {
      await page.close();
    }
  },
  30000,
);
