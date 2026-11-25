import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { ExtensionNativeRuntime } from "./extension-native";
import type { PageSnapshot } from "./contracts";

const source = readFileSync(new URL("../../extension/cbg-access/main.js", import.meta.url), "utf8");
type Globals = Record<string, unknown>;
function fixture(result: unknown) {
  const frames: { value: { kind: string; globals: Globals } }[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const ticks: (() => void)[] = [];
  let domWrites = 0;
  const query = Object.freeze({
    server_type: "1,2,3",
    page: 3,
    order_by: "expire_time DESC",
    price_min: "120",
    level_max: "175",
  });
  const window: Record<PropertyKey, unknown> = {
    IsLogin: 1,
    LoginInfo: { login: 1 },
    QueryArgs: query,
    QueryResult: result,
    postMessage(value: { channel: string; value: { kind: string; globals: Globals } }) {
      if (value.channel === "cbg-passive-v1") frames.push(value);
    },
    addEventListener: (name: string, listener: (event: unknown) => void) =>
      listeners.set(name, listener),
  };
  class XHR {
    open() {}
    send() {}
  }
  const location = {
    origin: "https://xyq.cbg.163.com",
    href: "https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py?act=role",
  };
  const document = new Proxy(
    {
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
      addEventListener() {},
      removeEventListener() {},
      createElement() {
        domWrites++;
        throw new Error("No DOM writes permitted");
      },
    },
    {
      set() {
        domWrites++;
        throw new Error("No DOM writes permitted");
      },
    },
  );
  runInNewContext(source, {
    window,
    location,
    document,
    XMLHttpRequest: XHR,
    setInterval: (callback: () => void) => (ticks.push(callback), ticks.length),
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    URL,
    TextEncoder,
    TextDecoder,
  });
  listeners.get("message")!({
    source: window,
    origin: location.origin,
    data: { channel: "cbg-observer-control-v1", command: "bind", token: "projection-fixture" },
  });
  return { frames, window, query, ticks, domWrites: () => domWrites };
}

// Field coverage: ISOLATED matches game_ordersn and preserves these product IDs;
// parseListing consumes server_name/selling_time/create_time/expire_time (listing.ts).
// The real decoder passes row.raw directly to that parser. Training stays in DOM attrs.
const metadata = (index: number) => ({
  eid: `role-${index}`,
  game_ordersn: `order-${index}`,
  server_id: 367,
  serverid: "367",
  serverId: "367",
  server_name: `服务器${index}`,
  selling_time: "2026-11-18 10:00:00",
  create_time: 1794960000,
  expire_time: "2026-12-18T10:00:00+08:00",
});

it("15行超过真实751728字符的列表仍完整发帧，身份/时间/四修经真实解码保持一致", () => {
  const expected = Array.from({ length: 15 }, (_, index) => metadata(index));
  const original = Object.freeze(
    expected.map((row) =>
      Object.freeze({
        ...row,
        desc: "x".repeat(100000),
        large_equip_desc: "y".repeat(7161),
        other_info: "z".repeat(1329),
      }),
    ),
  );
  expect(JSON.stringify(original).length).toBeGreaterThan(751728);
  const f = fixture(original);
  expect(f.frames).toHaveLength(1);
  const globals = f.frames[0].value.globals;
  expect(globals.QueryResult).toEqual(expected);
  expect(globals.QueryArgs).toEqual(f.query);
  expect(globals.authState).toBe(true);
  expect(JSON.stringify(f.frames[0]).length).toBeLessThan(200000);
  expect(f.window.QueryResult).toBe(original);
  expect(f.window.QueryArgs).toBe(f.query);
  expect(original.every((row) => row.desc.length === 100000)).toBe(true);
  expect(f.domWrites()).toBe(0);
  const projected = globals.QueryResult as typeof expected;
  const db = new DatabaseSync(":memory:");
  try {
    const runtime = new ExtensionNativeRuntime({
      db,
      socketPath: "/private/tmp/projection-not-started.sock",
      stopEpoch: () => 0,
      onRisk: async () => {},
      runAction: async (_plan, dispatch) => dispatch(),
    });
    const decoder = runtime as unknown as {
      pageContexts: Map<string, unknown>;
      decodeSnapshot(input: unknown): PageSnapshot;
    };
    decoder.pageContexts.set("projection-page", {
      runId: "run",
      queryId: "query",
      stopEpoch: 0,
      pageGeneration: 1,
      browserSessionEpoch: "session",
      boundAt: Date.now() - 100,
    });
    const snapshot = decoder.decodeSnapshot({
      pageId: "projection-page",
      pageGeneration: 1,
      observedAt: new Date().toISOString(),
      url: "https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py?act=role",
      revision: "projection",
      title: "列表",
      visible: true,
      loading: false,
      access: "normal",
      queryArgs: globals.QueryArgs,
      listing: {
        page: 3,
        totalPages: 3,
        order: "expire_time DESC",
        serverType: "1,2,3",
        items: [...expected].reverse().map((row) => ({
          href: `/equip?s=367&eid=${row.eid}`,
          attrs: {
            data_ordersn: row.game_ordersn,
            攻修: "21/25",
            防修: "20/25",
            法修: "0/25",
            抗法: "19/25",
          },
          summary: null,
          raw: projected.find((value) => value.game_ordersn === row.game_ordersn),
        })),
      },
    });
    expect(snapshot.listing?.items).toHaveLength(15);
    for (const [index, row] of snapshot.listing!.items.entries()) {
      const originalIndex = 14 - index;
      expect(row).toMatchObject({
        key: `367:role-${originalIndex}`,
        ordersn: `order-${originalIndex}`,
        serverName: `服务器${originalIndex}`,
        sellingTime: "2026-11-18T02:00:00.000Z",
        createdTime: new Date(1794960000 * 1000).toISOString(),
        orderTime: "2026-12-18T02:00:00.000Z",
        attrs: { 攻修: "21/25", 防修: "20/25", 法修: "0/25", 抗法: "19/25" },
      });
    }
  } finally {
    db.close();
  }
});

it("不读取无关大字段/循环/BigInt/toJSON/getter，不改网站原对象", () => {
  let calls = 0;
  const row: Record<string, unknown> = { ...metadata(0), huge: 1n };
  row.desc = row;
  for (const key of ["large_equip_desc", "toJSON"])
    Object.defineProperty(row, key, {
      get() {
        calls++;
        throw new Error("Must not invoke unrelated getter");
      },
    });
  Object.freeze(row);
  const f = fixture(Object.freeze([row]));
  expect(f.frames).toHaveLength(1);
  expect(f.frames[0].value.globals.QueryResult).toEqual([metadata(0)]);
  expect(calls).toBe(0);
  expect(row.desc).toBe(row);
  expect(row.huge).toBe(1n);
  expect(f.domWrites()).toBe(0);
});

it("列表投影不裁剪详情全局中的装备、宝宝、技能及四币资产", () => {
  const f = fixture([metadata(0)]);
  const info = Object.freeze({ server_id: 367, eid: "detail-role" });
  const detail = Object.freeze({
    AllEquip: [{ name: "详情装备", desc: "x".repeat(60000) }],
    AllSummon: [{ name: "详情宝宝", skills: [1, 2, 3] }],
    all_skills: { 101: 175 },
    iCash: 0,
    iSaving: 120,
    iLearnCash: 0,
    xianyu: 80,
  });
  f.window.EquipInfo = info;
  f.window.RoleData = detail;
  f.ticks[0]();
  const globals = f.frames.at(-1)!.value.globals;
  expect(globals.EquipInfo).toEqual(info);
  expect(globals.RoleData).toEqual(detail);
  expect(f.window.RoleData).toBe(detail);
  expect(f.window.EquipInfo).toBe(info);
  expect(f.domWrites()).toBe(0);
});

it.each([
  null,
  {},
  [metadata(0), null],
  Array.from({ length: 1001 }, (_, index) => metadata(index)),
])("不支持的结果不截成部分数组或伪造空数组", (result) => {
  const f = fixture(result);
  expect(f.frames).toHaveLength(1);
  expect(f.frames[0].value.globals).not.toHaveProperty("QueryResult");
  expect(f.frames[0].value.globals.QueryArgs).toEqual(f.query);
  expect(f.window.QueryResult).toBe(result);
  expect(f.domWrites()).toBe(0);
});

it("投影字段本身超预算也不截字段/行伪造提交数量", () => {
  const rows = [{ ...metadata(0), server_name: "x".repeat(110000) }],
    f = fixture(rows);
  expect(f.frames).toHaveLength(1);
  expect(f.frames[0].value.globals).not.toHaveProperty("QueryResult");
  expect(rows[0].server_name).toHaveLength(110000);
  expect(f.domWrites()).toBe(0);
});
