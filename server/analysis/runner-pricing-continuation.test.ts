import { readFileSync } from "node:fs";
import { expect, it, vi } from "vite-plus/test";
import { valuationRecord } from "../../tests/fixtures/analysis";
import { CrawlStore } from "../crawler/store";
import { AnalysisStore } from "./store";
import { AnalysisRunner, type AnalysisClient } from "./runner";
import { createProfile, DEFAULT_SETTINGS, PROMPT_FILE } from "./profile";
import { equipmentInventory, type EquipmentPricingSnapshot } from "./equipment-pricing";
import { petInventory } from "./pet-pricing";

it.each([
  [2, false],
  [6, false],
  [6, true],
] as const)(
  "游标持续前进时查完%s轮，重启恢复%s；在查价预算内持续推进",
  async (finishAfter, restart) => {
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
    const profile = createProfile(
      readFileSync(PROMPT_FILE, "utf8"),
      {
        ...DEFAULT_SETTINGS,
        servers: [{ serverId: record.listing.serverId, age: "three", rank: 10 }],
      },
      true,
      true,
      false,
    );
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
    let rowIndex = 0;
    const startedAt = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const searchEquipment = vi
      .fn<NonNullable<AnalysisClient["searchEquipment"]>>()
      .mockImplementation(async (_record, _signal, _settings, previous) => {
        searches++;
        // Simulate successful long-running requests with a renewed service lease.
        clock.mockReturnValue(startedAt + searches * 60_000);
        const owner = String(store.db.prepare("SELECT owner FROM analysis_lock").get()!.owner);
        expect(store.acquire(owner)).toBe(true);
        if (searches > 1) expect(previous?.items[0].searchCursor?.rowIndex).toBe(rowIndex);
        if (!(restart && searches === 3)) rowIndex++;
        return {
          ...snapshot,
          searchComplete: rowIndex === finishAfter,
          items: snapshot.items.map((item) => ({
            ...item,
            searchState: rowIndex === finishAfter ? ("completed" as const) : ("pending" as const),
            searchCursor: {
              version: 1,
              planHash: "official-plan",
              modeIndex: 0,
              pageNumber: 1,
              rowIndex,
              pageRowsHash: "rows",
              seen: [],
              failed: [],
            },
          })),
        };
      });
    const connect = async () => ({
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
    });
    const runner = new AnalysisRunner(store, connect);
    let reopened: AnalysisRunner | undefined;
    try {
      const id = await runner.start("codex", true, profile);
      await runner.settled();
      if (restart) {
        expect(store.run(id)).toMatchObject({
          status: "completed",
          queued: 0,
          completed: 0,
          waitingPricing: 1,
        });
        expect(
          store.detail(store.overview({ runId: id }).records.items[0].taskId!)?.error,
        ).toContain("等待新的可核验数据");
        expect(
          store.detail(store.overview({ runId: id }).records.items[0].taskId!)?.equipmentPricing
            ?.items[0].searchCursor?.rowIndex,
        ).toBe(2);
        expect(analyze).not.toHaveBeenCalled();
        await runner.shutdown();
        const reloadedStore = new AnalysisStore(crawl.db);
        reopened = new AnalysisRunner(reloadedStore, connect);
        await reopened.resume(id, true);
        await reopened.settled();
      }
      expect(searches).toBe(finishAfter + Number(restart));
      expect(analyze).toHaveBeenCalledOnce();
      expect(store.run(id)?.status).toBe("completed");
      const saved = store.overview({ runId: id }).results.items[0].result.valuation!;
      expect(saved.equipment_pricing?.items[0].searchCursor?.rowIndex).toBe(finishAfter);
      expect(saved.equipment_pricing?.items[0].referencePrice).toBeNull();
      expect(saved.decision).toBe("NEED_INFO");
      expect(saved.model_value).toBeNull();
      // Recreating a runner after completion behaves like refresh without duplicate AI.
      reopened ||= new AnalysisRunner(new AnalysisStore(crawl.db), connect);
      expect(await reopened.start("codex", false, profile)).toBe(id);
      await reopened.settled();
      expect(searches).toBe(finishAfter + Number(restart));
      expect(analyze).toHaveBeenCalledOnce();
    } finally {
      await runner.shutdown();
      await reopened?.shutdown();
      clock.mockRestore();
      crawl.db.close();
    }
  },
);
