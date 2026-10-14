import { readFileSync } from "node:fs";
import { expect, it, vi } from "vite-plus/test";
import { valuationRecord } from "../../tests/fixtures/analysis";
import { CrawlStore } from "../crawler/store";
import { AnalysisStore } from "./store";
import { AnalysisRunner, type AnalysisClient } from "./runner";
import { createProfile, PROMPT_FILE } from "./profile";
import { equipmentInventory } from "./equipment-pricing";
import { petInventory, type PetPricingSnapshot } from "./pet-pricing";
import {
  PET_GEAR_ACCOUNTING,
  petGearInventory,
  type PetGearPricingSnapshot,
} from "./pet-gear-inventory";

function setup(captureComplete = true, petCount = 1) {
  const record = valuationRecord("generic-pet-gear");
  record.detail!.petCapture = {
    version: 1,
    collectedAt: record.detail!.collectedAt,
    complete: captureComplete,
    issues: captureComplete ? [] : ["宝宝资料需要补采"],
  };
  record.detail!.equipmentCapture = {
    version: 1,
    collectedAt: record.detail!.collectedAt,
    complete: true,
    issues: [],
    emptyProof: "explicit-text",
  };
  record.detail!.tabs.push({
    name: "道具/法宝",
    text: "没有装备",
    fields: [],
    tables: [],
    elements: [],
    tooltips: [],
    items: [],
  });
  record.detail!.tabs.push({
    name: "召唤兽/孩子",
    text: "",
    fields: [],
    tables: [],
    elements: [],
    tooltips: [],
    petCount: 1,
    pets: [
      {
        index: 1,
        name: "测试画魂",
        fields: Object.entries({
          类型: "画魂",
          等级: "115",
          成长: "1.28",
          攻击资质: "1200",
          防御资质: "1400",
          体力资质: "5000",
          法力资质: "2800",
          速度资质: "1200",
          躲闪资质: "1100",
          是否宝宝: "是",
        }).map(([name, value]) => ({ name, value })),
        skills: [{ index: 0, name: "须弥真言", kind: "skill" }],
        innerSkills: [],
        equipment: [
          {
            index: 0,
            kind: "equipment",
            name: "测试金环",
            description: "等级 115\n速度 +40\n耐久 100",
          },
        ],
      },
    ],
  });
  const petTab = record.detail!.tabs.find((tab) => tab.name === "召唤兽/孩子")!;
  const pet = petTab.pets![0];
  petTab.petCount = petCount;
  petTab.pets = Array.from({ length: petCount }, (_, index) => ({
    ...structuredClone(pet),
    index: index + 1,
  }));
  const crawl = new CrawlStore(":memory:");
  crawl.observe(record.listing);
  crawl.save(record.listing, record.detail!);
  const store = new AnalysisStore(crawl.db);
  const profile = createProfile(readFileSync(PROMPT_FILE, "utf8"), undefined, true, true);
  const base = {
    version: 1 as const,
    searchedAt: new Date().toISOString(),
    provider: "browser" as const,
    model: "browser",
    queries: [],
    rawResponse: null,
    captureComplete: true,
    searchComplete: true,
    total: null,
    knownTotal: 0,
    issues: [],
  };
  const equipment = { ...base, ...equipmentInventory(record), total: 0, searchComplete: true };
  const pets: PetPricingSnapshot = { ...base, ...petInventory(record), searchComplete: true };
  const gear: PetGearPricingSnapshot = {
    ...base,
    ...petGearInventory(record),
    accounting: PET_GEAR_ACCOUNTING,
    searchComplete: true,
  };
  const searchEquipment = vi
    .fn<NonNullable<AnalysisClient["searchEquipment"]>>()
    .mockResolvedValue(equipment);
  const searchPets = vi.fn<NonNullable<AnalysisClient["searchPets"]>>().mockResolvedValue(pets);
  const searchPetGear = vi
    .fn<NonNullable<AnalysisClient["searchPetGear"]>>()
    .mockResolvedValue(gear);
  const analyze = vi.fn<AnalysisClient["analyze"]>().mockResolvedValue({
    text: JSON.stringify({
      decision: "NEED_INFO",
      reason: "模拟查价样本不足，保留未定价。",
      extracted_facts: [],
    }),
  });
  const runner = new AnalysisRunner(store, async () => ({
    model: "test",
    analyze,
    searchEquipment,
    searchPets,
    searchPetGear,
  }));
  return {
    record,
    crawl,
    store,
    profile,
    gear,
    pets,
    runner,
    analyze,
    searchEquipment,
    searchPets,
    searchPetGear,
  };
}

it.each(["pet", "pet-gear"] as const)(
  "%s 每轮完成一件时自动查完全部六件，保留已完成阶段且只分析一次",
  async (phase) => {
    const c = setup(true, 6);
    let searches = 0;
    if (phase === "pet")
      c.searchPets.mockImplementation(async () => ({
        ...c.pets,
        searchComplete: ++searches >= 6,
        items: c.pets.items.map((item, index) => ({
          ...item,
          searchState: index < searches ? "completed" : "pending",
        })),
      }));
    else
      c.searchPetGear.mockImplementation(async () => ({
        ...c.gear,
        searchComplete: ++searches >= 6,
        items: c.gear.items.map((item, index) => ({
          ...item,
          searchState: index < searches ? "completed" : "pending",
          searchStatus: index < searches ? "completed" : "pending",
        })),
      }));
    try {
      const id = await c.runner.start("codex", true, c.profile);
      await c.runner.settled();
      const search = phase === "pet" ? c.searchPets : c.searchPetGear;
      expect(search.mock.calls[1][2]?.items[0].searchState).toBe("completed");
      expect(searches).toBe(6);
      expect(c.store.run(id)?.status).toBe("completed");
      expect(c.searchEquipment).toHaveBeenCalledOnce();
      expect(phase === "pet" ? c.searchPetGear : c.searchPets).toHaveBeenCalledOnce();
      expect(c.analyze).toHaveBeenCalledOnce();
    } finally {
      await c.runner.shutdown();
      c.crawl.db.close();
    }
  },
);

it.each([
  ["pet", "pending"],
  ["pet", "read_failed"],
  ["pet-gear", "pending"],
  ["pet-gear", "read_failed"],
] as const)("%s 没有新进展或详情读取失败时保存待补齐：%s", async (phase, state) => {
  const c = setup();
  if (phase === "pet")
    c.searchPets.mockResolvedValue({
      ...c.pets,
      searchComplete: false,
      items: c.pets.items.map((item) => ({ ...item, searchState: state })),
    });
  else
    c.searchPetGear.mockResolvedValue({
      ...c.gear,
      searchComplete: false,
      items: c.gear.items.map((item) => ({ ...item, searchState: state, searchStatus: state })),
    });
  try {
    const id = await c.runner.start("codex", true, c.profile);
    await c.runner.settled();
    expect(c.store.run(id)).toMatchObject({
      status: "completed",
      waitingPricing: 1,
      completed: 0,
      queued: 0,
    });
    expect(phase === "pet" ? c.searchPets : c.searchPetGear).toHaveBeenCalledOnce();
    expect(c.analyze).not.toHaveBeenCalled();
    const saved = c.store.detail(
      c.store.overview({ runId: id }).records.items[0].taskId!,
    )!.petPricing!;
    expect((phase === "pet" ? saved : saved.gearPricing!).items[0].searchState).toBe(state);
  } finally {
    await c.runner.shutdown();
    c.crawl.db.close();
  }
});

it("宝宝装备自动查价，暂停和刷新后复用父宝宝进度，完成后不重复分析", async () => {
  const c = setup();
  c.searchPetGear.mockResolvedValueOnce({
    ...c.gear,
    searchComplete: false,
    items: c.gear.items.map((item) => ({ ...item, searchStatus: "read_failed" })),
  });
  try {
    const id = await c.runner.start("codex", false, c.profile);
    await c.runner.settled();
    expect(c.store.run(id)).toMatchObject({
      status: "completed",
      waitingPricing: 1,
      completed: 0,
      queued: 0,
    });
    expect(c.analyze).not.toHaveBeenCalled();
    expect(
      c.store.detail(c.store.overview({ runId: id }).records.items[0].taskId!)?.petPricing,
    ).toMatchObject({
      searchComplete: true,
      gearPricing: { searchComplete: false },
    });
    await c.runner.resume(id, true);
    await c.runner.settled();
    expect(c.store.run(id)?.status).toBe("completed");
    expect(c.searchEquipment).toHaveBeenCalledTimes(1);
    expect(c.searchPets).toHaveBeenCalledTimes(1);
    expect(c.searchPetGear).toHaveBeenCalledTimes(2);
    expect(c.searchPetGear.mock.calls[1][2]?.items[0].searchStatus).toBe("read_failed");
    expect(c.analyze).toHaveBeenCalledTimes(1);
    expect(
      c.store.overview().results.items[0].result.valuation?.pet_pricing?.gearPricing?.accounting,
    ).toContain("不重复相加");
    expect(await c.runner.start("codex", false, c.profile)).toBe(id);
    await c.runner.settled();
    expect(c.searchPetGear).toHaveBeenCalledTimes(2);
    expect(c.analyze).toHaveBeenCalledTimes(1);
  } finally {
    await c.runner.shutdown();
    c.crawl.db.close();
  }
});

it("宠装暂停恢复后直接AI，已完成父宝宝不重复查", async () => {
  const c = setup(true);
  c.searchPetGear.mockResolvedValueOnce({
    ...c.gear,
    searchComplete: false,
    items: c.gear.items.map((item) => ({ ...item, searchStatus: "read_failed" })),
  });
  try {
    const id = await c.runner.start("codex", false, c.profile);
    await c.runner.settled();
    expect(c.store.run(id)).toMatchObject({
      status: "completed",
      waitingPricing: 1,
      completed: 0,
      queued: 0,
    });
    await c.runner.resume(id, true);
    await c.runner.settled();
    expect(c.store.run(id)?.status).toBe("completed");
    expect(c.searchEquipment).toHaveBeenCalledOnce();
    expect(c.searchPets).toHaveBeenCalledOnce();
    expect(c.analyze).toHaveBeenCalledOnce();
  } finally {
    await c.runner.shutdown();
    c.crawl.db.close();
  }
});

it.each(["identity", "total"])("拒绝不匹配或重复计价的宝宝装备快照：%s", async (kind) => {
  const c = setup();
  c.searchPetGear.mockResolvedValue(
    kind === "identity"
      ? { ...c.gear, inputHash: "other-role" }
      : { ...c.gear, total: 500, knownTotal: 500 },
  );
  try {
    const id = await c.runner.start("codex", false, c.profile);
    await c.runner.settled();
    expect(c.store.run(id)?.status).toBe("paused");
    expect(c.store.run(id)?.error).toContain("宝宝装备查价资料");
    expect(c.store.next(id)?.petPricing).toEqual(c.pets);
    expect(c.analyze).not.toHaveBeenCalled();
  } finally {
    await c.runner.shutdown();
    c.crawl.db.close();
  }
});

it("宝宝库存未采齐时留在采集阶段，不调用市场查价或输出缺项分析", async () => {
  const c = setup(false);
  try {
    await expect(c.runner.start("codex", false, c.profile)).rejects.toThrow("暂无详情完整的商品");
    expect(c.analyze).not.toHaveBeenCalled();
    expect(c.searchEquipment).not.toHaveBeenCalled();
    expect(c.searchPets).not.toHaveBeenCalled();
    expect(c.searchPetGear).not.toHaveBeenCalled();
    expect(c.store.counts()).toMatchObject({ complete: 0, waitingDetail: 1 });
    expect(c.crawl.retryItems()).toHaveLength(1);
  } finally {
    await c.runner.shutdown();
    c.crawl.db.close();
  }
});

it.each(["equipment", "pet", "pet-gear", "pet-and-gear", "fresh"] as const)(
  "刷新后继续分析会重新查过期的%s报价，仍有效的阶段不重复查",
  async (phase) => {
    const c = setup();
    try {
      const equipment = {
        ...structuredClone(c.pets),
        ...equipmentInventory(c.record),
        total: 0,
      };
      const pets = { ...structuredClone(c.pets), gearPricing: structuredClone(c.gear) };
      const stale = new Date(Date.now() - 24 * 60 * 60 * 1000 - 1000).toISOString();
      if (phase === "equipment") equipment.searchedAt = stale;
      if (phase === "pet" || phase === "pet-and-gear") pets.searchedAt = stale;
      if (phase === "pet-gear" || phase === "pet-and-gear") pets.gearPricing.searchedAt = stale;
      c.searchEquipment.mockImplementation(async () => {
        expect(c.store.activeRun()?.phase).toBe("equipment_search");
        return { ...equipment, searchedAt: new Date().toISOString() };
      });
      c.searchPets.mockImplementation(async () => {
        expect(c.store.activeRun()?.phase).toBe("pet_search");
        return c.pets;
      });
      c.searchPetGear.mockImplementation(async () => {
        expect(c.store.activeRun()?.phase).toBe("pet_gear_search");
        return c.gear;
      });
      const id = c.store.createRun("codex", "test", true, c.profile);
      const owner = "saved-pricing";
      expect(c.store.acquire(owner)).toBe(true);
      let task = c.store.next(id)!;
      c.store.beginEquipmentSearch(task, owner);
      task = c.store.saveEquipmentPricing(task, equipment, owner);
      c.store.beginPetSearch(task, owner);
      c.store.savePetPricing(task, pets, owner);
      c.store.setRun(id, "paused", null, owner);
      c.store.release(owner);
      await c.runner.resume(id);
      await c.runner.settled();
      expect(c.searchEquipment).toHaveBeenCalledTimes(Number(phase === "equipment"));
      expect(c.searchPets).toHaveBeenCalledTimes(
        Number(phase === "pet" || phase === "pet-and-gear"),
      );
      expect(c.searchPetGear).toHaveBeenCalledTimes(
        Number(phase === "pet-gear" || phase === "pet-and-gear"),
      );
      if (phase === "pet-gear" || phase === "pet-and-gear")
        expect(c.searchPetGear.mock.calls[0][2]).toEqual(pets.gearPricing);
      expect(c.store.run(id)?.status).toBe("completed");
      expect(c.analyze).toHaveBeenCalledOnce();
    } finally {
      await c.runner.shutdown();
      c.crawl.db.close();
    }
  },
);
