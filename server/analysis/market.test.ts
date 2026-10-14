import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vite-plus/test";
import { marketServers, parseMarketPages, refreshMarket, SERVER_DIRECTORY_URL } from "./market";
import { DEFAULT_SETTINGS, loadProfile, PROMPT_FILE } from "./profile";
import { calculateValuation } from "./valuation-calculator";
import { valuationRecord } from "../../tests/fixtures/analysis";
const directory =
  'var server_data = {"1":[["北京1区",""],[[132,"西栅老街",0],[173,"逍遥城",0]]],"2":[["北京2区",""],[[132,"旧区别名",0]] ]};';
const heat =
  "<table><tr><td>#13</td><td>北京1区-西栅老街</td></tr><tr><td>#43</td><td>北京1区-逍遥城</td></tr></table>";
const gold =
  '<table><tr><td>#1</td><td><a href="/mhb/info/173">北京1区-逍遥城</a></td><td>3年外</td><td>￥210.00</td></tr><tr><td>#2</td><td><a href="/mhb/info/132">北京1区-西栅老街</a></td><td>3年外</td><td>218.29</td></tr></table>';
const parsed = () => parseMarketPages(directory, heat, gold, "older", "", new Date().toISOString());
describe("全服行情自动匹配", () => {
  it("以官方serverId及完整区服名交叉核对，热度排名不取金价排序", () => {
    const data = parsed();
    expect(data.find((row) => row.serverId === "132")).toMatchObject({
      rank: 13,
      goldPrice: 218.29,
      goldUnit: 30000000,
      age: "older",
      source: "auto",
    });
    expect(data.find((row) => row.serverId === "173")?.rank).toBe(43);
    expect(
      parseMarketPages(
        directory,
        heat,
        gold.replace("/mhb/info/132", "/mhb/info/999"),
        "older",
        "",
        new Date().toISOString(),
      ),
    ).toHaveLength(1);
  });
  it("只补已保存商品的区服，用户手动参数优先", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE listings(server_id TEXT); INSERT INTO listings VALUES('132'); CREATE TABLE analysis_market(id INTEGER PRIMARY KEY,snapshot_json TEXT); CREATE TABLE analysis_settings(id INTEGER PRIMARY KEY,settings_json TEXT)",
      );
      db.prepare("INSERT INTO analysis_market VALUES(1,?)").run(
        JSON.stringify({ fetchedAt: new Date().toISOString(), servers: parsed() }),
      );
      const profile = loadProfile(db);
      expect(profile.settings.servers).toHaveLength(1);
      expect(profile.settings.servers[0].rank).toBe(13);
      db.prepare("INSERT INTO analysis_settings VALUES(1,?)").run(
        JSON.stringify({
          ...DEFAULT_SETTINGS,
          settingsVersion: 2,
          servers: [{ ...parsed()[1], source: "manual", rank: 5 }],
        }),
      );
      expect(loadProfile(db).settings.servers[0].rank).toBe(5);
      expect(loadProfile(db).marketSources?.map((row) => row.serverId)).toEqual(["173"]);
      expect(profile.calculationCompatible).toBe(true);
      expect(profile.template).toBe(readFileSync(PROMPT_FILE, "utf8"));
    } finally {
      db.close();
    }
  });
  it("后采齐区服使用启动时的全服行情，手动设置仍优先，缺区服不借用其他服", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE listings(server_id TEXT); INSERT INTO listings VALUES('132'); CREATE TABLE analysis_market(id INTEGER PRIMARY KEY,snapshot_json TEXT)",
      );
      db.prepare("INSERT INTO analysis_market VALUES(1,?)").run(
        JSON.stringify({ fetchedAt: new Date().toISOString(), servers: parsed() }),
      );
      const frozen = loadProfile(db);
      const later = valuationRecord();
      later.listing.serverId = "173";
      later.listing.summary = {
        ...(later.listing.summary as Record<string, unknown>),
        iCash: 30000000,
      };
      const value = calculateValuation(later, frozen);
      expect(value.items.find((item) => item.name === "现金")).toMatchObject({
        confirmed: true,
        amount: 199.5,
      });
      const manuallyMissing = {
        ...frozen,
        settings: {
          ...frozen.settings,
          servers: [{ ...parsed()[0], source: "manual" as const, goldPrice: null }],
        },
      };
      expect(
        calculateValuation(later, manuallyMissing).items.find((item) => item.name === "现金")
          ?.confirmed,
      ).toBe(false);
      later.listing.serverId = "999";
      expect(
        calculateValuation(later, frozen).items.find((item) => item.name === "现金")?.confirmed,
      ).toBe(false);
    } finally {
      db.close();
    }
  });
  it("过期行情不继续当作当前值，失败刷新保留缓存且不能默认为零", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE analysis_market(id INTEGER PRIMARY KEY,snapshot_json TEXT)");
      const old = JSON.stringify({
        fetchedAt: new Date(Date.now() - 25 * 3600000).toISOString(),
        servers: parsed(),
      });
      db.prepare("INSERT INTO analysis_market VALUES(1,?)").run(old);
      expect(marketServers(db)).toEqual([]);
      const fetcher = vi.fn(async () => new Response("unavailable", { status: 503 }));
      await expect(refreshMarket(db, true, fetcher)).rejects.toThrow("503");
      expect(db.prepare("SELECT snapshot_json FROM analysis_market").get()?.snapshot_json).toBe(
        old,
      );
    } finally {
      db.close();
    }
  });
  it("必须核实3000万两报价单位再写入自动行情", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const fetcher = vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        return new Response(
          url === SERVER_DIRECTORY_URL
            ? directory
            : url.endsWith("/hot")
              ? heat
              : url.endsWith("/mhb")
                ? gold
                : "每100万两",
        );
      }) as typeof fetch;
      await expect(refreshMarket(db, true, fetcher)).rejects.toThrow("报价单位未能确认");
      expect(marketServers(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
