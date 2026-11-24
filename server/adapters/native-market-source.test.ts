import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { AccessGovernor, type OwnerFence } from "../access";
import type { PageSnapshot, SemanticTarget } from "./contracts";
import type { EquipmentPricingItem } from "../analysis/equipment-pricing";
import type { PetPricingItem } from "../analysis/pet-pricing";
import type { PetGearPricingItem } from "../analysis/pet-gear-inventory";
import {
  createNativeEquipmentSource,
  createNativePetGearSource,
  createNativePetSource,
  nativePlans,
  nativeProductSource,
} from "./native-market-source";
import { nativeEquipmentActions } from "./native-market-actions";
import { createEquipmentSource } from "../analysis/browser-equipment-source";
import { createPetSource } from "../analysis/browser-pet-source";
import { createPetGearSource } from "../analysis/browser-pet-gear-source";

const runtime = vi.hoisted(() => ({
  adapter: undefined as any,
  governor: undefined as any,
  owner: undefined as any,
  resolver: undefined as any,
  getBrowser: vi.fn(),
  createHiddenPage: vi.fn(),
}));
vi.mock("../native-access", () => ({
  nativeAccess: async () => runtime.adapter,
  nativeAccessOwner: () => runtime.owner,
  setNativeQueryContext: (resolver: any) => {
    runtime.resolver = resolver;
  },
}));
vi.mock("../official-access", () => ({ officialGovernor: () => runtime.governor }));
vi.mock("../browser-settings", async (original) => ({
  ...(await original<typeof import("../browser-settings")>()),
  browserSettings: () => ({ mode: "dedicated", accessAdapter: "extension-native" }),
}));
vi.mock("../session", () => ({
  getBrowser: runtime.getBrowser,
  createHiddenPage: runtime.createHiddenPage,
}));
let db: DatabaseSync;
let owner: OwnerFence;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  runtime.governor = new AccessGovernor(db);
  owner = runtime.governor.acquireOwner("native-source-test");
  runtime.owner = owner;
});
afterEach(() => db.close());
const equipment: EquipmentPricingItem = {
  key: "belt",
  name: "测试腰带",
  level: 100,
  category: "人物装备 · 腰带",
  description: "等级：100\n防御：50\n气血：250\n特效：愤怒\n修理失败：0",
  query: "",
  status: "no_match",
  referencePrice: null,
  candidates: [],
  issues: [],
};
const pet: PetPricingItem = {
  ...equipment,
  key: "pet",
  name: "画魂",
  category: "召唤兽",
  description: "等级：119\n成长：1.28",
  level: 119,
  fields: [{ name: "成长", value: "1.28" }],
  skills: [],
  innerSkills: [],
  equipment: [],
};
const gear: PetGearPricingItem = {
  ...equipment,
  key: "gear",
  petKey: "pet",
  petName: "画魂",
  name: "金环",
  category: "宝宝装备",
  level: 95,
  description: "等级 95\n速度 +20\n耐久100",
  accessory: false,
};
const config = {
  serverAreas: { "1": "area-1" },
  kinds: [[20, "腰带"]] as Array<[string | number, string]>,
  effects: [[3, "愤怒"]] as Array<[string | number, string]>,
  skills: [],
  gems: [],
  names: { "2001": "画魂" },
  highNeidans: [],
  lowNeidans: [],
};
function fixture(row = false, committed = true) {
  let snapshot: PageSnapshot = {
    context: {
      schemaVersion: 1,
      runId: "native-test",
      queryId: "query",
      actionId: null,
      pageId: "tab",
      pageGeneration: 1,
      browserSessionEpoch: "browser",
      stopEpoch: 0,
      observedAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      sourceKind: "extension-native",
    },
    url: "https://xyq.cbg.163.com/cgi-bin/equipquery.py",
    title: "市场",
    revision: "0",
    visible: true,
    loading: false,
    access: "normal",
    empty: !row,
    formValues: {},
    market: {
      category: "pet-gear",
      page: 1,
      totalPages: 1,
      order: "",
      conditions: {},
      rows: [],
      empty: !row,
      committed,
      config,
    },
  };
  let planned: Record<string, string | number> = {};
  let sequence = 0;
  const calls: SemanticTarget[] = [];
  runtime.adapter = {
    status: () => ({ adapter: "extension-native", idle: false, stopped: false, connected: true }),
    resumeForRun: vi.fn(async () => {}),
    snapshot: async () => structuredClone(snapshot),
    returnToList: async () => runtime.adapter.query({ kind: "market-entry", category: "pet-gear" }),
    beginQuery: (runId: string, queryId: string) => {
      snapshot.context.runId = runId;
      snapshot.context.queryId = queryId;
    },
    query: async (target: SemanticTarget) => {
      calls.push(target);
      snapshot.revision = String(++sequence);
      if (target.kind === "market-entry") {
        snapshot.context.pageGeneration++;
        snapshot.market = {
          category: target.category,
          page: 1,
          totalPages: 1,
          order: "",
          conditions: {},
          rows: [],
          empty: true,
          committed,
          config,
        };
        delete snapshot.marketProduct;
      }
      if (target.kind === "market-field") snapshot.formValues![target.field] = target.value;
      if (target.kind === "market-submit") {
        snapshot.market!.conditions = { ...planned };
        snapshot.market!.rows = row
          ? [{ url: "https://xyq.cbg.163.com/equip?s=1&eid=gear-1", name: "金环" }]
          : [];
        snapshot.market!.empty = !row;
      }
      if (target.kind === "listing-detail") {
        delete snapshot.market;
        snapshot.context.pageGeneration++;
        snapshot.url = "https://xyq.cbg.163.com/equip?s=1&eid=gear-1";
        snapshot.productIdentity = { serverId: "1", eid: "gear-1" };
        snapshot.marketProduct = {
          kind: "pet-gear",
          directPanel: true,
          observation: {
            name: "金环",
            tooltip: "",
            description: "等级 95\n速度 +20\n耐久100",
            typeDescription: "装备对象：召唤兽",
            prices: ["100"],
            rawPrice: 100,
            body: "状态：已上架",
            selling: 1,
            productName: "金环",
            productId: "gear-1",
            serverId: "1",
            modelId: "200",
            kindId: 29,
          },
        };
      }
      return structuredClone(snapshot);
    },
  };
  return {
    calls,
    setArgs: (args: Record<string, string | number>) => {
      planned = args;
    },
    snapshot: () => snapshot,
  };
}

it.each(["equipment", "pet", "pet-gear"] as const)(
  "native %s full source accepts normal empty with an actual identity and emits a current transaction proof",
  async (kind) => {
    const x = fixture();
    const item = kind === "equipment" ? equipment : kind === "pet" ? pet : gear;
    x.snapshot().market!.category = kind;
    const plans = await nativePlans(kind, item, "1", x.snapshot().market!);
    const original = runtime.adapter.query;
    let mode = 0;
    runtime.adapter.query = async (target: SemanticTarget) => {
      if (target.kind === "market-submit")
        x.setArgs(plans[Math.min(mode++, plans.length - 1)].args);
      return original(target);
    };
    const signal = new AbortController().signal;
    const source =
      kind === "equipment"
        ? await createNativeEquipmentSource(signal, "1")
        : kind === "pet"
          ? await createNativePetSource(signal, "1")
          : await createNativePetGearSource(signal, "1");
    const result = await source.findCandidates([item] as any, signal);
    expect(result.items[0]).toMatchObject({ searchState: "completed", candidates: [] });
    expect(x.calls.some((call) => call.kind === "market-submit")).toBe(true);
    expect(result.accessProofs).toHaveLength(1);
    expect(() => runtime.governor.withProgress(result.accessProofs![0], () => {})).not.toThrow();
    await source.close();
  },
);
it("native gear source opens only the principal listed product, revalidates the list, and uses the ordinary gear matcher", async () => {
  const x = fixture(true);
  const [plan] = await nativePlans("pet-gear", gear, "1", x.snapshot().market!);
  x.setArgs(plan.args);
  const signal = new AbortController().signal;
  const source = await createNativePetGearSource(signal, "1");
  const result = await source.findCandidates([gear], signal);
  expect(result.items[0].candidates).toHaveLength(1);
  expect(result.items[0].candidates[0]).toMatchObject({
    verified: true,
    price: 100,
    priceType: "listing",
    matchType: "exact",
  });
  expect(x.calls.filter((call) => call.kind === "listing-detail")).toHaveLength(1);
  expect(x.calls.filter((call) => call.kind === "market-submit")).toHaveLength(2);
  expect(() => runtime.governor.withProgress(result.accessProofs![0], () => {})).not.toThrow();
  await source.close();
});
it("an uncommitted native empty never publishes exhausted/cursor/quote output", async () => {
  const x = fixture(false, false);
  const [plan] = await nativePlans("pet-gear", gear, "1", x.snapshot().market!);
  x.setArgs(plan.args);
  const signal = new AbortController().signal;
  const source = await createNativePetGearSource(signal, "1");
  await expect(source.findCandidates([gear], signal)).rejects.toThrow("健康核验");
  expect(runtime.governor.read().state).toBe("ready");
  await source.close();
});
it("principal product identity/price checks and unsupported argument mapping stay shared and fail closed", async () => {
  const x = fixture(true);
  await runtime.adapter.query({ kind: "listing-detail", serverId: "1", eid: "gear-1" });
  x.snapshot().marketProduct!.observation.rawPrice = 101;
  expect(() => nativeProductSource(x.snapshot(), "pet-gear")).toThrow("价格不一致");
  await expect(
    nativeEquipmentActions(
      {
        serverid: "1",
        level_min: 100,
        level_max: 100,
        front_status: "pass_fair_show",
        invented_filter: 1,
      },
      config,
      "equipment",
    ),
  ).rejects.toThrow("invented_filter");
});
it("all three production factories select native sources before touching a browser/CDP connection", async () => {
  fixture();
  runtime.getBrowser.mockClear();
  runtime.createHiddenPage.mockClear();
  const signal = new AbortController().signal;
  const sources = [
    await createEquipmentSource(signal, "1"),
    await createPetSource(signal, "1"),
    await createPetGearSource(signal, "1"),
  ];
  expect(runtime.getBrowser).not.toHaveBeenCalled();
  expect(runtime.createHiddenPage).not.toHaveBeenCalled();
  for (const source of sources) await source.close();
});
