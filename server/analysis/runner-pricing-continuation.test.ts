import { readFileSync } from "node:fs";
import { expect, it, vi } from "vite-plus/test";
import { valuationRecord } from "../../tests/fixtures/analysis";
import { CrawlStore } from "../crawler/store";
import { AnalysisStore } from "./store";
import { AnalysisRunner, type AnalysisClient } from "./runner";
import { createProfile, DEFAULT_SETTINGS, PROMPT_FILE } from "./profile";
import { equipmentInventory, type EquipmentPricingSnapshot } from "./equipment-pricing";
import { petInventory } from "./pet-pricing";

it.each([false, true])(
  "游标前进自动完成查价，但超出续查次数仍保存暂停：%s",
  async (neverFinished) => {
    const crawl = new CrawlStore(":memory:");
    const record = valuationRecord("cursor-role");
    const captured = {
      version: 1 as const,
      collectedAt: record.detail!.collectedAt,
      complete: true,
      issues: [],
    };
    record.detail!.equipmentCapture = captured;
    record.detail!.petCapture = captured;
    record.detail!.tabs.push({
      name: "道具/法宝",
      text: "",
      fields: [],
      tables: [],
      elements: [],
      tooltips: [],
      items: [
        {
          index: 0,
          kind: "equipment",
          category: "腰带",
          name: "测试腰带",
          description: "等级100\n气血250\n防御50",
        },
      ],
    });
    record.detail!.tabs.push({
      name: "召唤兽/孩子",
      text: "无召唤兽",
      fields: [],
      tables: [],
      elements: [],
      tooltips: [],
      pets: [],
      petCount: 0,
    });
    crawl.observe(record.listing);
    crawl.save(record.listing, record.detail!);
    const store = new AnalysisStore(crawl.db);
    const profile = createProfile(readFileSync(PROMPT_FILE, "utf8"), {
      ...DEFAULT_SETTINGS,
      servers: [{ serverId: record.listing.serverId, age: "three", rank: 10 }],
    });
    const inventory = equipmentInventory(record),
      pets = petInventory(record);
    const snapshot: EquipmentPricingSnapshot = {
      version: 1,
      inputHash: inventory.inputHash,
      searchedAt: new Date().toISOString(),
      provider: "browser",
      model: "browser",
      queries: ["official-filter"],
      rawResponse: null,
      captureComplete: true,
      total: null,
      knownTotal: 0,
      items: inventory.items,
      issues: [],
    };
    const analyze = vi.fn<AnalysisClient["analyze"]>().mockResolvedValue({
      text: JSON.stringify({
        decision: "NEED_INFO",
        reason: "参考样本不足，保留装备待定价。",
        extracted_facts: [],
      }),
    });
    let searches = 0;
    const searchEquipment = vi
      .fn<NonNullable<AnalysisClient["searchEquipment"]>>()
      .mockImplementation(async (_record, _signal, _settings, previous) => {
        searches++;
        if (searches > 1) expect(previous?.items[0].searchCursor?.rowIndex).toBe(searches - 1);
        return {
          ...snapshot,
          searchComplete: !neverFinished && searches === 2,
          items: snapshot.items.map((item) => ({
            ...item,
            searchState:
              !neverFinished && searches === 2 ? ("completed" as const) : ("pending" as const),
            searchCursor: {
              version: 1,
              planHash: "official-plan",
              modeIndex: 0,
              pageNumber: 1,
              rowIndex: searches,
              pageRowsHash: "rows",
              seen: [],
              failed: [],
            },
          })),
        };
      });
    const runner = new AnalysisRunner(store, async () => ({
      model: "test",
      analyze,
      searchEquipment,
      searchPets: async () => ({
        ...snapshot,
        inputHash: pets.inputHash,
        items: [],
        total: 0,
        searchComplete: true,
      }),
    }));
    try {
      const id = await runner.start("codex", true, profile);
      await runner.settled();
      expect(searches).toBe(neverFinished ? 5 : 2);
      expect(analyze).toHaveBeenCalledTimes(neverFinished ? 0 : 1);
      expect(store.run(id)?.status).toBe(neverFinished ? "paused" : "completed");
      if (neverFinished)
        expect(store.next(id)?.equipmentPricing?.items[0].searchCursor?.rowIndex).toBe(5);
    } finally {
      await runner.shutdown();
      crawl.db.close();
    }
  },
);
