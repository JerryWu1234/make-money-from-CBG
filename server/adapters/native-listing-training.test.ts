import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { ExtensionNativeRuntime } from "./extension-native";
import type { PageSnapshot } from "./contracts";

it("真实Native snapshot解码与parseListing保留四修原文、未知缺键和已有attrs", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const runtime = new ExtensionNativeRuntime({
      db,
      socketPath: "/private/tmp/not-started-training-fixture.sock",
      stopEpoch: () => 0,
      onRisk: async () => {},
      runAction: async (_plan, dispatch) => dispatch(),
    });
    const reader = runtime as unknown as {
      pageContexts: Map<string, Record<string, unknown>>;
      decodeSnapshot(value: unknown): PageSnapshot;
    };
    reader.pageContexts.set("training-page", {
      runId: "run",
      queryId: "query",
      stopEpoch: 0,
      pageGeneration: 1,
      browserSessionEpoch: "session",
      boundAt: Date.now() - 100,
    });
    const attrs = [
      {
        data_price: "100",
        data_keep: "first",
        攻修: "21/25",
        防修: "20/25",
        法修: "0/25",
        抗法: "19 / 25",
      },
      { data_price: "200", data_keep: "second", 防修: "--", 法修: "0/0" },
    ];
    const decoded = reader.decodeSnapshot({
      pageId: "training-page",
      pageGeneration: 1,
      observedAt: new Date().toISOString(),
      url: "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=role",
      revision: "training-revision",
      title: "离线角色列表",
      visible: true,
      loading: false,
      access: "normal",
      listing: {
        page: 1,
        totalPages: 2,
        serverType: "1,2,3",
        order: "selling_time DESC",
        items: attrs.map((value, index) => ({
          href: `/equip?s=367&eid=role-${index}`,
          attrs: value,
          summary: { preserved: index },
        })),
      },
    });
    expect(decoded.listing?.items.map((item) => item.attrs)).toEqual(attrs);
    expect(
      decoded.listing?.items.map((item) => ({
        key: item.key,
        price: item.price,
        summary: item.summary,
      })),
    ).toEqual([
      { key: "367:role-0", price: "100", summary: { preserved: 0 } },
      { key: "367:role-1", price: "200", summary: { preserved: 1 } },
    ]);
    expect(decoded.listing?.items[1].attrs).not.toHaveProperty("攻修");
    expect(decoded.listing?.items[1].attrs).not.toHaveProperty("抗法");
  } finally {
    db.close();
  }
});
