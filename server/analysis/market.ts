import type { DatabaseSync } from "node:sqlite";
import type { AnalysisProfile, ValuationSettings } from "./valuation-types";
import { parseTravelHeatRanks } from "./market-travel";

export const EXPIRED_MARKET_NOTICE =
  "本批次区服行情已过期，请刷新行情并按当前设置重新分析；旧结果保留";
export function automaticMarketExpired(profile: AnalysisProfile, now = Date.now()) {
  return !!profile.marketSources?.some((source) => {
    const configured = profile.settings.servers.find((row) => row.serverId === source.serverId);
    if (configured && configured.source !== "auto") return false;
    const fetchedAt = Date.parse(source.fetchedAt);
    return !Number.isFinite(fetchedAt) || now - fetchedAt >= 24 * 60 * 60 * 1000;
  });
}

export const MARKET_URL = "https://www.aimhxy.com";
export const SERVER_DIRECTORY_URL = "https://cbg-xyq.res.netease.com/js/server_list_data.js";
export const TRAVEL_HEAT_URL = MARKET_URL + "/travel?status=2";
export type MarketServer = ValuationSettings["servers"][number] & {
  serverName: string;
  fetchedAt: string;
  sources: string[];
};
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;/g, " ")
    .trim();
function rows(html: string) {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => ({
    html: match[1],
    cells: [...match[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) =>
      text(cell[1]),
    ),
  }));
}
export function parseMarketPages(
  directory: string,
  hot: string,
  gold: string,
  age: MarketServer["age"],
  suffix: string,
  fetchedAt: string,
  travel?: string,
): MarketServer[] {
  const match = directory.match(/var\s+server_data\s*=\s*(\{[^\n]+\});/);
  if (!match) throw new Error("官方区服目录结构发生变化");
  const value: unknown = JSON.parse(match[1]);
  if (!value || typeof value !== "object") throw new Error("官方区服目录无效");
  const names = new Map<string, Set<string>>();
  for (const group of Object.values(value)) {
    if (!Array.isArray(group) || !Array.isArray(group[0]) || !Array.isArray(group[1])) continue;
    for (const server of group[1])
      if (Array.isArray(server) && typeof server[1] === "string") {
        const id = String(server[0]);
        if (!names.has(id)) names.set(id, new Set());
        names.get(id)!.add(String(group[0][0]) + "-" + server[1]);
      }
  }
  const ranks = new Map<string, number>();
  for (const row of rows(hot)) {
    if (!/^#\d+$/.test(row.cells[0] || "") || !row.cells[1]) continue;
    if (ranks.has(row.cells[1])) throw new Error("热度榜存在重名区服，暂不自动匹配");
    ranks.set(row.cells[1], Number(row.cells[0].slice(1)));
  }
  const result: MarketServer[] = [];
  const fallback = age === "older" && travel ? parseTravelHeatRanks(travel, fetchedAt) : null;
  for (const row of rows(gold)) {
    const id = row.html.match(/\/mhb\/info\/(\d+)/)?.[1];
    const price = Number(row.cells[3]?.replace(/[¥￥,\s]/g, ""));
    const name = row.cells[1];
    const rank = ranks.get(name) ?? fallback?.ranks.get(name);
    if (
      !id ||
      !names.get(id)?.has(name) ||
      !rank ||
      !Number.isFinite(price) ||
      price <= 0 ||
      price > 10000
    )
      continue;
    result.push({
      serverId: id,
      serverName: name,
      age,
      rank,
      goldPrice: price,
      goldUnit: 30000000,
      baselineUnitConfirmed: true,
      source: "auto",
      fetchedAt,
      sources: [
        MARKET_URL + "/hot" + suffix,
        MARKET_URL + "/mhb" + suffix,
        MARKET_URL + "/mhb/info/" + id,
        SERVER_DIRECTORY_URL,
        ...(!ranks.has(name) && fallback?.ranks.has(name)
          ? [
              TRAVEL_HEAT_URL,
              MARKET_URL + "/travel?dt=" + fallback.date.replace(/-/g, "") + "&status=2",
            ]
          : []),
      ],
    });
  }
  if (!result.length || new Set(result.map((server) => server.serverId)).size !== result.length)
    throw new Error("全服行情未能可靠匹配服务器，保留原有参数");
  return result;
}
export function marketServers(
  db: DatabaseSync,
  now = Date.now(),
  allowExpired = false,
): MarketServer[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='analysis_market'").get()) return [];
  const row = db.prepare("SELECT snapshot_json FROM analysis_market WHERE id=1").get();
  if (!row) return [];
  const data = JSON.parse(String(row.snapshot_json)) as {
    servers: MarketServer[];
    fetchedAt: string;
  };
  return allowExpired || now - Date.parse(data.fetchedAt) < 24 * 60 * 60 * 1000 ? data.servers : [];
}
let refreshing: Promise<MarketServer[]> | null = null;
export async function refreshMarket(
  db: DatabaseSync,
  force = false,
  fetcher: typeof fetch = fetch,
): Promise<MarketServer[]> {
  const cached = marketServers(db);
  if (cached.length && !force) return cached;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const request = async (url: string) => {
      const response = await fetcher(url, {
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
      if (!response.ok) throw new Error("行情来源暂不可用：" + response.status);
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > 2 * 1024 * 1024) throw new Error("行情页面过大");
      return new TextDecoder(url === SERVER_DIRECTORY_URL ? "gb18030" : "utf-8").decode(buffer);
    };
    const pages = await Promise.all([
      request(SERVER_DIRECTORY_URL),
      request(MARKET_URL + "/mhb/info/132"),
      request(MARKET_URL + "/hot"),
      request(MARKET_URL + "/mhb"),
    ]);
    if (!/每3000万两|\\u6bcf3000\\u4e07\\u4e24/.test(pages[1]))
      throw new Error("金价报价单位未能确认，保留原有参数");
    const fetchedAt = new Date().toISOString();
    const hotNames = new Set(
      rows(pages[2])
        .filter((row) => /^#\d+$/.test(row.cells[0] || ""))
        .map((row) => row.cells[1]),
    );
    const missingHeat = rows(pages[3]).some(
      (row) => /\/mhb\/info\/\d+/.test(row.html) && !hotNames.has(row.cells[1]),
    );
    let travel: string | undefined;
    if (missingHeat) {
      try {
        travel = await request(TRAVEL_HEAT_URL);
      } catch {
        // An optional weekly supplement must not discard reliable primary heat/gold rows.
      }
    }
    const servers = parseMarketPages(pages[0], pages[2], pages[3], "older", "", fetchedAt, travel);
    if (new Set(servers.map((server) => server.serverId)).size !== servers.length)
      throw new Error("行情区服年代存在冲突");
    db.exec(
      "CREATE TABLE IF NOT EXISTS analysis_market (id INTEGER PRIMARY KEY CHECK(id=1), snapshot_json TEXT NOT NULL)",
    );
    db.prepare(
      "INSERT INTO analysis_market VALUES(1,?) ON CONFLICT(id) DO UPDATE SET snapshot_json=excluded.snapshot_json",
    ).run(JSON.stringify({ fetchedAt, servers }));
    return servers;
  })();
  try {
    return await refreshing;
  } finally {
    refreshing = null;
  }
}
