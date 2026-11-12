import { readFile, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { Page } from "playwright-core";
import { equipmentSourceFromPages } from "../../server/analysis/browser-equipment-source";
import { petSourceFromPages } from "../../server/analysis/browser-pet-source";
import { petGearSourceFromPage } from "../../server/analysis/browser-pet-gear-source";
import { createMarketDetailReader } from "../../server/analysis/market-detail";
import { equipmentIdentity } from "../../server/analysis/equipment-pricing";
import type { EquipmentPricingItem } from "../../server/analysis/equipment-pricing";
import type { PetPricingItem } from "../../server/analysis/pet-pricing";
import type { PetGearPricingItem } from "../../server/analysis/pet-gear-inventory";
// These fixtures reproduce public DOM contracts. All network traffic is intercepted locally.
// @ts-expect-error JavaScript fixture has no declaration file.
import * as equipmentSite from "../fixtures/equipment-search-site.mjs";
// @ts-expect-error JavaScript fixture has no declaration file.
import * as petSite from "../fixtures/pet-search-site.mjs";
// @ts-expect-error JavaScript fixture has no declaration file.
import * as petGearSite from "../fixtures/pet-gear-search-site.mjs";
const { equipmentSearchDocument, equipmentDetailDocument, equipmentDescription, equipmentName } =
  equipmentSite;
const { petSearchDocument, petDetailDocument, petFields, petSkills } = petSite;
const { petGearSearchDocument, petGearDetailDocument } = petGearSite;

// Failure cases: direct navigation disguised as a click, cross-task popup ownership,
// premature quotation acceptance, cache opening more tabs, and pause leaving a late tab alive.
test("三类查价并发点击列表→新页核验→关闭→保存并重读结果", async ({ context }, info) => {
  const control = new AbortController();
  const kinds = ["equipment", "pet", "gear"] as const;
  const lists = await Promise.all(kinds.map(() => context.newPage()));
  const opened: Array<{ kind: string; url: string }> = [];
  const inFlight = new Set<Page>();
  const captured = new Set<string>();
  let maximum = 0;
  lists.forEach((list, index) =>
    list.on("popup", (popup) => {
      opened.push({ kind: kinds[index], url: popup.url() });
      inFlight.add(popup);
      maximum = Math.max(maximum, inFlight.size);
      popup.once("close", () => inFlight.delete(popup));
      const close = popup.close.bind(popup);
      popup.close = async (options) => {
        if (!popup.isClosed() && !captured.has(kinds[index])) {
          await popup.screenshot({
            path: info.outputPath(`${kinds[index]}-detail.png`),
            fullPage: true,
          });
          captured.add(kinds[index]);
        }
        return close(options);
      };
    }),
  );
  await context.addInitScript(() => {
    (window as unknown as { fixtureClicks: string[] }).fixtureClicks = [];
    document.addEventListener(
      "click",
      (event) => {
        const link = (event.target as Element).closest<HTMLAnchorElement>("a.soldImg");
        if (link) (window as unknown as { fixtureClicks: string[] }).fixtureClicks.push(link.href);
      },
      true,
    );
  });
  const details: string[] = [];
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://xyq.cbg.163.com") return route.abort();
    if (url.pathname === "/cgi-bin/recommend.py") return route.fulfill({ json: {} });
    if (url.pathname === "/equip") {
      const eid = url.searchParams.get("eid")!;
      details.push(eid);
      const body = eid.startsWith("equipment")
        ? equipmentDetailDocument({
            renderedPanel: true,
            selling: 1,
            kindId: 20,
            price: 300 + Number(eid.at(-1)),
            panelDelay: 400,
          })
        : eid.startsWith("pet")
          ? petDetailDocument({ price: 368.6, panelDelay: 400, cifuDecoration: false })
          : petGearDetailDocument({
              name: "测试护腕",
              level: 95,
              description: "等级95\n速度+20\n耐久100",
              price: 200 + Number(eid.at(-1)),
              panelDelay: 400,
            });
      return route.fulfill({ contentType: "text/html; charset=utf-8", body });
    }
    const act = url.searchParams.get("act");
    const body =
      act === "show_overall_search_pet"
        ? petSearchDocument({
            pages: [
              [
                { eid: "pet0", name: "宝宝昵称", type: "2001" },
                { eid: "pet1", name: "宝宝昵称", type: "2001" },
              ],
            ],
          })
        : act === "show_pet_equip_search_form"
          ? petGearSearchDocument({ pages: [["gear0", "gear1"]] })
          : equipmentSearchDocument({
              pages: [
                [
                  { eid: "equipment0", name: equipmentName },
                  { eid: "equipment1", name: equipmentName },
                ],
              ],
            });
    return route.fulfill({ contentType: "text/html; charset=utf-8", body });
  });
  const equipment = equipmentSourceFromPages(lists[0], control.signal, "1");
  const pets = petSourceFromPages(lists[1], control.signal, "1");
  const gear = await petGearSourceFromPage(lists[2], control.signal, "1");
  expect(context.pages()).toHaveLength(3); // No pre-created blank detail pages.
  const equipmentItem: EquipmentPricingItem = {
    key: "equipment",
    name: equipmentName,
    level: 100,
    category: "人物装备 · 腰带",
    description: equipmentDescription,
    query: "",
    status: "no_match",
    referencePrice: null,
    candidates: [],
    issues: [],
  };
  const petItem: PetPricingItem = {
    key: "pet",
    name: "画魂",
    level: 119,
    category: "召唤兽",
    description: petFields
      .map((field: { name: string; value: string }) => field.name + "：" + field.value)
      .join("\n"),
    query: "",
    status: "no_match",
    referencePrice: null,
    candidates: [],
    issues: [],
    fields: petFields,
    skills: petSkills,
    innerSkills: [{ name: "催心浪", level: "5" }],
    equipment: [],
  };
  const gearItem: PetGearPricingItem = {
    key: "gear",
    petKey: "pet",
    petName: "画魂",
    name: "测试护腕",
    level: 95,
    category: "召唤兽装备",
    description: "等级95\n速度+20\n耐久100",
    accessory: false,
    rawItem: { index: 0, kindId: "29", attributes: { 装备类型: "护腕" } },
    query: "",
    status: "no_match",
    referencePrice: null,
    candidates: [],
    issues: [],
  };
  try {
    const result = await Promise.all([
      equipment.findCandidates([equipmentItem], control.signal),
      pets.findCandidates([petItem], control.signal),
      gear.findCandidates([gearItem], control.signal),
    ]);
    await writeFile(info.outputPath("raw-results.json"), JSON.stringify(result, null, 2));
    for (let index = 0; index < kinds.length; index++)
      await lists[index].screenshot({
        path: info.outputPath(`${kinds[index]}-list.png`),
        fullPage: true,
      });
    for (const value of result) {
      expect(value.items[0].candidates).toHaveLength(2);
      expect(
        value.items[0].candidates.every(
          (candidate) =>
            candidate.verified &&
            candidate.sourceHash &&
            candidate.fetchedAt &&
            candidate.price !== null,
        ),
      ).toBe(true);
    }
    expect(result[0].items[0].searchState).toBe("completed");
    expect(result[1].items[0].searchState).toBe("completed");
    expect(result[2].items[0].searchStatus).toBe("completed");
    expect(opened).toHaveLength(6);
    expect(details).toHaveLength(6);
    expect(maximum).toBeGreaterThan(1);
    expect(inFlight.size).toBe(0);
    expect(captured.size).toBe(3);
    const clicks = await Promise.all(
      lists.map((list) =>
        list.evaluate(() => (window as unknown as { fixtureClicks: string[] }).fixtureClicks),
      ),
    );
    for (let index = 0; index < kinds.length; index++) {
      expect(clicks[index].map(equipmentIdentity).sort()).toEqual(
        opened
          .filter((value) => value.kind === kinds[index])
          .map((value) => equipmentIdentity(value.url))
          .sort(),
      );
      await lists[index].screenshot({
        path: info.outputPath(`${kinds[index]}-list.png`),
        fullPage: true,
      });
    }
    const beforeCache = opened.length;
    await equipment.readSource(result[0].items[0].candidates[0].url, control.signal);
    await pets.readSource(result[1].items[0].candidates[0].url, control.signal);
    expect(opened).toHaveLength(beforeCache);
    const artifact = {
      fixture: true,
      repeat: "vp exec playwright test tests/e2e/analysis-list-popup.pw.ts --workers=1",
      maximum,
      opened,
      clicks,
      result,
    };
    const file = info.outputPath("verified-results.json");
    await writeFile(file, JSON.stringify(artifact, null, 2));
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(artifact);
    await info.attach("可重跑的模拟网站核验结果", { path: file, contentType: "application/json" });
  } finally {
    await Promise.all([equipment.close(), pets.close(), gear.close()]);
  }
  expect(context.pages()).toHaveLength(0);
});

test("等待网站新页时暂停→关闭迟到页→保留列表", async ({ context }, info) => {
  await context.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<meta charset="utf-8"><script>var IsLogin=1</script><div id="search_result"><a class="soldImg" href="https://xyq.cbg.163.com/equip?s=1&eid=late" onclick="event.preventDefault();setTimeout(()=>window.open(this.href),300)">延迟打开的候选</a></div>`,
    }),
  );
  const list = await context.newPage();
  await list.goto("https://xyq.cbg.163.com/list");
  const control = new AbortController();
  const reader = createMarketDetailReader(list, control.signal);
  const click = list.waitForEvent("console", { predicate: (value) => value.text() === "clicked" });
  await list.evaluate(() =>
    document.querySelector("a")!.addEventListener("click", () => console.log("clicked")),
  );
  const reading = reader.read(
    "https://xyq.cbg.163.com/equip?s=1&eid=late",
    control.signal,
    async () => "must not read",
  );
  const rejected = expect(reading).rejects.toThrow("用户暂停");
  await click;
  const late = list.waitForEvent("popup");
  control.abort(new Error("用户暂停"));
  await rejected;
  const popup = await late;
  await expect.poll(() => popup.isClosed()).toBe(true);
  expect(context.pages()).toEqual([list]);
  const result = {
    paused: true,
    latePopupClosed: true,
    listKept: !list.isClosed(),
    repeat: "vp exec playwright test tests/e2e/analysis-list-popup.pw.ts --workers=1",
  };
  const file = info.outputPath("pause-cleanup.json");
  await writeFile(file, JSON.stringify(result, null, 2));
  await info.attach("暂停后的迟到页清理结果", { path: file, contentType: "application/json" });
  await reader.close();
  await list.close();
});

test("宝宝装备预算中断→重新搜索找回旧候选→点击续查并保存新结果", async ({ context }, info) => {
  const url = "https://xyq.cbg.163.com/equip?s=1&eid=";
  const visits: string[] = [];
  const clickTargets: string[] = [];
  await context.route("**/*", async (route) => {
    const address = new URL(route.request().url());
    if (address.origin !== "https://xyq.cbg.163.com") return route.abort();
    if (address.pathname === "/cgi-bin/recommend.py") return route.fulfill({ json: {} });
    if (address.pathname === "/equip") {
      const eid = address.searchParams.get("eid")!;
      visits.push(eid);
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: petGearDetailDocument({
          name: "测试护腕",
          level: 95,
          description: "等级95\n速度+20\n耐久100",
          price: eid === "one" ? 200 : 220,
        }),
      });
    }
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: petGearSearchDocument({ pages: [["one"], ["two"]] }),
    });
  });
  const item: PetGearPricingItem = {
    key: "gear",
    petKey: "pet",
    petName: "画魂",
    name: "测试护腕",
    level: 95,
    category: "召唤兽装备",
    description: "等级95\n速度+20\n耐久100",
    accessory: false,
    rawItem: { index: 0, kindId: "29", attributes: { 装备类型: "护腕" } },
    query: "",
    status: "no_match",
    referencePrice: null,
    candidates: [],
    issues: [],
  };
  const control = new AbortController();
  const create = async (maxDetails: number) => {
    const list = await context.newPage();
    list.on("popup", (popup) => clickTargets.push(popup.url()));
    return petGearSourceFromPage(list, control.signal, "1", { maxDetails });
  };
  const first = await create(1);
  const partial = await first.findCandidates([item], control.signal);
  await first.close();
  expect(partial.items[0].searchStatus).toBe("pending");
  expect(partial.items[0].candidates).toHaveLength(1);
  expect(partial.items[0].searchCursor).toBeDefined();
  const second = await create(24);
  let finished;
  try {
    finished = await second.findCandidates([{ ...item, ...partial.items[0] }], control.signal);
    expect(finished.items[0].searchStatus).toBe("completed");
    expect(finished.items[0].candidates.map((candidate) => candidate.url)).toEqual([
      url + "one",
      url + "two",
    ]);
    expect(
      finished.items[0].candidates.every((candidate) => candidate.verified && candidate.sourceHash),
    ).toBe(true);
    expect(visits).toEqual(["one", "one", "two"]);
    expect(clickTargets.map(equipmentIdentity)).toEqual(["1:one", "1:one", "1:two"]);
  } finally {
    await second.close();
  }
  expect(context.pages()).toHaveLength(0);
  const artifact = {
    fixture: true,
    repeat:
      "vp exec playwright test tests/e2e/analysis-list-popup.pw.ts --grep 预算中断 --workers=1",
    partial,
    finished,
    visits,
    clickTargets,
  };
  const file = info.outputPath("resume-results.json");
  await writeFile(file, JSON.stringify(artifact, null, 2));
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual(artifact);
  await info.attach("旧候选从列表找回后续跑的结果", {
    path: file,
    contentType: "application/json",
  });
});
