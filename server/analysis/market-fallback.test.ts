import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { parseMarketPages, refreshMarket, SERVER_DIRECTORY_URL, TRAVEL_HEAT_URL } from "./market";

const now = "2026-10-24T03:00:00Z";
const directory =
  'var server_data = {"1":[["北京1区",""],[[132,"西栅老街",0]]],"2":[["浙江2区",""],[[881,"忆江南",0]]]};';
// ASCII JSON escapes also survive the official directory's GB18030 decoder.
const wireDirectory = Array.from(directory, (char) =>
  char.charCodeAt(0) > 127 ? "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0") : char,
).join("");
const hot = "<table><tr><td>#13</td><td>北京1区-西栅老街</td></tr></table>";
const gold =
  '<table><tr><td>#1</td><td><a href="/mhb/info/132">北京1区-西栅老街</a></td><td>3年外</td><td>218.29</td></tr><tr><td>#2</td><td><a href="/mhb/info/881">浙江2区-忆江南</a></td><td>3年外</td><td>208.01</td></tr></table>';
const travel =
  "<h4>梦幻西游-2026年10月20日-三年外服务器-烟花列表</h4><table><tr><th>排名</th><th>服务器</th><th>金价（排名）</th><th>热度值（排名）</th></tr><tr><th>#30</th><td>浙江2区-忆江南</td><td>199.99(136)</td><td>26.7(152)</td></tr><tr><th>#1</th><td>北京1区-西栅老街</td><td>200(13)</td><td>99(99)</td></tr></table>";
const parse = (supplement = travel, goldPage = gold) =>
  parseMarketPages(directory, hot, goldPage, "older", "", now, supplement);
afterEach(() => vi.useRealTimers());

describe("热度主榜缺项时使用当周同源明确排名", () => {
  it("官方ID/完整区服名/当前金价交叉匹配，主榜现有排名不会被覆盖", () => {
    const rows = parse();
    expect(rows.find((row) => row.serverId === "881")).toMatchObject({
      serverName: "浙江2区-忆江南",
      rank: 152,
      goldPrice: 208.01,
      sources: expect.arrayContaining([
        TRAVEL_HEAT_URL,
        "https://www.aimhxy.com/travel?dt=20261020&status=2",
      ]),
    });
    expect(rows.find((row) => row.serverId === "132")?.rank).toBe(13);
    expect(rows.find((row) => row.serverId === "132")?.sources).not.toContain(TRAVEL_HEAT_URL);
  });
  it("过时、重复、错误热度列或区服名称不会污染主榜数据", () => {
    for (const invalid of [
      travel.replace("2026年10月20日", "2026年10月13日"),
      travel.replace(
        "</table>",
        "<tr><td>#31</td><td>浙江2区-忆江南</td><td>199(2)</td><td>27(151)</td></tr></table>",
      ),
      travel.replace("热度值（排名）", "金价（排名）"),
      travel.replace("浙江2区-忆江南", "浙江1区-忆江南"),
    ])
      expect(parse(invalid).map((row) => row.serverId)).toEqual(["132"]);
    expect(
      parse(travel, gold.replace("/mhb/info/881", "/mhb/info/999")).map((row) => row.serverId),
    ).toEqual(["132"]);
  });
  it("独立强制刷新可补齐有效但缺区服的缓存，不改冻结profile", async () => {
    vi.useFakeTimers({ now: new Date(now), toFake: ["Date"] });
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE analysis_market(id INTEGER PRIMARY KEY,snapshot_json TEXT); CREATE TABLE analysis_runs(id TEXT,profile_json TEXT)",
      );
      const frozen = JSON.stringify({
        marketSources: parseMarketPages(directory, hot, gold, "older", "", now),
      });
      db.prepare("INSERT INTO analysis_market VALUES(1,?)").run(
        JSON.stringify({ fetchedAt: now, servers: JSON.parse(frozen).marketSources }),
      );
      db.prepare("INSERT INTO analysis_runs VALUES('frozen',?)").run(frozen);
      const fetcher = vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        return new Response(
          url === SERVER_DIRECTORY_URL
            ? wireDirectory
            : url.endsWith("/hot")
              ? hot
              : url.endsWith("/mhb")
                ? gold
                : url === TRAVEL_HEAT_URL
                  ? travel
                  : "每3000万两",
        );
      }) as typeof fetch;
      expect(await refreshMarket(db, false, fetcher)).toHaveLength(1);
      expect(fetcher).not.toHaveBeenCalled();
      expect(await refreshMarket(db, true, fetcher)).toHaveLength(2);
      expect(fetcher).toHaveBeenCalledTimes(5);
      expect(db.prepare("SELECT profile_json FROM analysis_runs").get()!.profile_json).toBe(frozen);
    } finally {
      db.close();
    }
  });
  it.each([false, true])(
    "原四页已齐不抓补充页；补充抓取失败也保留主榜（热度缺项%s）",
    async (missing) => {
      vi.useFakeTimers({ now: new Date(now), toFake: ["Date"] });
      const db = new DatabaseSync(":memory:");
      try {
        const hotPage = missing
          ? hot
          : hot.replace("</table>", "<tr><td>#150</td><td>浙江2区-忆江南</td></tr></table>");
        const fetcher = vi.fn(async (input: string | URL | Request) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          return new Response(
            url === SERVER_DIRECTORY_URL
              ? wireDirectory
              : url.endsWith("/hot")
                ? hotPage
                : url.endsWith("/mhb")
                  ? gold
                  : url === TRAVEL_HEAT_URL
                    ? "unavailable"
                    : "每3000万两",
            { status: url === TRAVEL_HEAT_URL ? 503 : 200 },
          );
        }) as typeof fetch;
        expect(await refreshMarket(db, true, fetcher)).toHaveLength(missing ? 1 : 2);
        expect(fetcher).toHaveBeenCalledTimes(missing ? 5 : 4);
      } finally {
        db.close();
      }
    },
  );
});
