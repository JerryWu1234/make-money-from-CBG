import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vite-plus/test";
import { valuationRecord } from "../../tests/fixtures/analysis";
import { CrawlStore } from "../crawler/store";
import { AnalysisStore } from "./store";
import { AnalysisRunner } from "./runner";
import { createProfile, DEFAULT_SETTINGS, PROMPT_FILE } from "./profile";
import { calculateValuation } from "./valuation-calculator";
import type { AnalysisProfile } from "./valuation-types";

function fixture(mode: "unrelated" | "relevant" | "stream") {
  const crawl = new CrawlStore(":memory:");
  const store = new AnalysisStore(crawl.db);
  const record = valuationRecord("scope-role");
  crawl.observe(record.listing);
  crawl.save(record.listing, record.detail!);
  const server = {
    serverId: record.listing.serverId,
    source: mode === "relevant" ? ("auto" as const) : ("manual" as const),
    age: "older" as const,
    rank: 10,
    goldPrice: 210,
    goldUnit: 30000000,
    baselineUnitConfirmed: true,
  };
  const profile: AnalysisProfile = {
    ...createProfile(
      readFileSync(PROMPT_FILE, "utf8"),
      { ...DEFAULT_SETTINGS, servers: [server] },
      false,
    ),
    marketSources: [
      {
        ...server,
        serverId: mode === "relevant" ? record.listing.serverId : "unused-server",
        serverName: "行情时效测试",
        source: "auto",
        fetchedAt: new Date(Date.now() - 25 * 3600000).toISOString(),
        sources: [],
      },
    ],
  };
  const analyze = vi.fn(async () => ({
    text: JSON.stringify({
      decision: calculateValuation(record, profile).decision,
      reason: "模拟裸号核对，仅验证过期检查范围。",
      extracted_facts: [],
    }),
    usage: { simulated: true },
  }));
  const connect = vi.fn(async () => ({ model: "fixture-model", analyze }));
  const runner = new AnalysisRunner(store, connect);
  return { crawl, store, runner, profile, analyze, connect };
}

describe("有限分析与流式分析的行情时效范围", () => {
  it.each(["start", "resume"] as const)(
    "%s：有限批次不被未使用的自动行情阻塞，概览一致",
    async (operation) => {
      const x = fixture("unrelated");
      try {
        let id: string;
        if (operation === "start") id = await x.runner.start("codex", true, x.profile, true);
        else {
          id = x.store.createRun("codex", "fixture-model", true, x.profile, true);
          expect(x.store.overview({ runId: id }).run?.marketExpired).toBe(false);
          await x.runner.resume(id);
        }
        await x.runner.settled();
        expect(x.analyze).toHaveBeenCalledOnce();
        expect(x.store.run(id)).toMatchObject({
          status: "completed",
          completed: 1,
          marketExpired: false,
        });
        expect(x.store.overview({ runId: id }).run?.marketExpired).toBe(false);
        expect(
          JSON.parse(
            String(
              x.crawl.db.prepare("SELECT profile_json FROM analysis_runs WHERE id=?").get(id)!
                .profile_json,
            ),
          ),
        ).toEqual(x.profile);
      } finally {
        await x.runner.shutdown();
        x.crawl.close();
      }
    },
  );

  it.each(["relevant", "stream"] as const)(
    "%s：本批次所需行情或流式未来区服行情过期仍阻止请求与恢复",
    async (mode) => {
      const x = fixture(mode);
      try {
        const id = await x.runner.start("codex", true, x.profile, mode !== "stream");
        await x.runner.settled();
        expect(x.store.run(id)).toMatchObject({
          status: "paused",
          marketExpired: true,
          error: expect.stringContaining("区服行情已过期"),
        });
        expect(x.store.overview({ runId: id }).run?.marketExpired).toBe(true);
        expect(x.analyze).not.toHaveBeenCalled();
        x.connect.mockClear();
        await expect(x.runner.resume(id)).rejects.toThrow("区服行情已过期");
        expect(x.connect).not.toHaveBeenCalled();
      } finally {
        await x.runner.shutdown();
        x.crawl.close();
      }
    },
  );
});
