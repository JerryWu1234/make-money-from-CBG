import { expect, it, vi } from "vite-plus/test";
import { valuationRecord } from "../../tests/fixtures/analysis";
import { searchEquipmentPrices, type EquipmentSource } from "./equipment-pricing";
import { pricingSearchAdvanced } from "./pricing-progress";

// Failure boundaries: count actual per-item query/detail failures once per response;
// preserve the count across retries, exclude at two, and keep the audit.
// Empty results, untouched rows, special assets, access gates and cancellation must not count.
function record(category = "人物装备 · 腰带") {
  const value = valuationRecord("failure-budget");
  value.listing.serverId = "1";
  value.detail!.equipmentCapture = {
    version: 1,
    complete: true,
    issues: [],
    collectedAt: value.detail!.collectedAt,
  };
  value.detail!.tabs.push({
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
        name: "测试装备",
        category,
        description: category.includes("灵饰")
          ? "等级80\n防御21\n精炼等级0\n附加属性：\n速度8"
          : "等级100\n防御50\n气血250",
      },
    ],
  });
  return value;
}
const key = "道具/法宝:0";
function failedSource(queries: string[] = ["实际装备查询"]): EquipmentSource {
  let attempt = 0;
  return {
    findCandidates: vi.fn<EquipmentSource["findCandidates"]>(async () => ({
      queries,
      items: [
        { key, candidates: [], searchState: "read_failed", note: `详情读取失败${++attempt}` },
      ],
      searchItems: [{ key, failure: { stage: "candidate_read", attempt } }],
    })),
    readSource: vi.fn(),
  };
}

it.each(["人物装备 · 腰带", "灵饰 · 戒指"])(
  "%s首次失败续查，累计第二次跳过并保留审计",
  async (category) => {
    const value = record(category);
    const source = failedSource();
    const signal = new AbortController().signal;
    const first = await searchEquipmentPrices(value, signal, source);
    expect(first.items[0]).toMatchObject({
      searchState: "pending",
      searchFailureCount: 1,
      referencePrice: null,
    });
    expect(pricingSearchAdvanced(undefined, first)).toBe(true);
    expect(pricingSearchAdvanced(first, structuredClone(first))).toBe(false);
    const second = await searchEquipmentPrices(value, signal, source, undefined, first);
    expect(second.items[0]).toMatchObject({
      searchState: "skipped",
      status: "no_match",
      searchFailureCount: 2,
      referencePrice: null,
      candidates: [],
    });
    expect(second.items[0].skipReason).toContain("详情读取失败2");
    expect(second.items[0].similarEstimate).toBeUndefined();
    expect(second.items[0].baselineEstimate).toBeUndefined();
    expect(second.searchComplete).toBe(true);
    expect(second.knownTotal).toBe(0);
    expect(second.searchItems).toHaveLength(2);
    expect(second.searchAttempts).toHaveLength(2);
    await searchEquipmentPrices(value, signal, source, undefined, second);
    expect(source.findCandidates).toHaveBeenCalledTimes(2);
  },
);

it("组件失败尚无实际查询记录也累计两次，未读取的skipped响应不重复计数", async () => {
  const value = record();
  const signal = new AbortController().signal;
  const source = failedSource([]);
  const first = await searchEquipmentPrices(value, signal, source);
  expect(first.items[0]).toMatchObject({ searchState: "pending", searchFailureCount: 1 });
  const untouched = await searchEquipmentPrices(
    value,
    signal,
    {
      findCandidates: async () => ({
        queries: [],
        items: [{ key, candidates: [], searchState: "read_failed", skipped: true }],
      }),
      readSource: vi.fn(),
    },
    undefined,
    first,
  );
  expect(untouched.items[0]).toMatchObject({ searchState: "pending", searchFailureCount: 1 });
  const second = await searchEquipmentPrices(value, signal, source, undefined, untouched);
  expect(second.items[0]).toMatchObject({ searchState: "skipped", searchFailureCount: 2 });
});

it.each(["上古玉魄", "元身", "精魄"])("%s不套用普通装备失败预算", async (category) => {
  const value = await searchEquipmentPrices(
    record(category),
    new AbortController().signal,
    failedSource(),
  );
  expect(value.items[0].searchState).toBe("read_failed");
  expect(value.items[0].searchFailureCount).toBeUndefined();
});

it("正常查完没有样本直接排除，不累计失败", async () => {
  const result = await searchEquipmentPrices(record(), new AbortController().signal, {
    findCandidates: async () => ({
      queries: ["实际查询"],
      items: [{ key, candidates: [], searchState: "completed" }],
    }),
    readSource: vi.fn(),
  });
  expect(result.items[0].searchState).toBe("skipped");
  expect(result.items[0].searchFailureCount).toBeUndefined();
});

it("多个候选中详情失败只算本件一次，第二次清掉已有核验样本与估价", async () => {
  const value = record();
  const description = value.detail!.tabs.at(-1)!.items![0].description;
  const candidates = ["good", "bad"].map((id) => ({
    url: `https://xyq.cbg.163.com/equip/1/${id}`,
    title: "测试装备",
    price: 100,
    priceType: "listing" as const,
    quote: "测试装备\n" + description + "\n挂牌价：¥100",
    verified: false,
    reason: "",
    fetchedAt: null,
    sourceHash: null,
  }));
  const source: EquipmentSource = {
    findCandidates: vi.fn<EquipmentSource["findCandidates"]>(async () => ({
      queries: ["实际查询"],
      items: [{ key, candidates, searchState: "completed" }],
    })),
    readSource: async (url) => {
      if (url.endsWith("bad")) throw new Error("该候选详情无法读取");
      return `<p>在售</p><h1>测试装备</h1><pre>${description}</pre><div>挂牌价：¥100</div>`;
    },
  };
  const signal = new AbortController().signal;
  const first = await searchEquipmentPrices(value, signal, source);
  expect(first.items[0].searchFailureCount).toBe(1);
  expect(first.items[0].candidates.filter((candidate) => candidate.verified)).toHaveLength(1);
  expect(first.items[0].referencePrice).toBeNull();
  const second = await searchEquipmentPrices(value, signal, source, undefined, first);
  expect(second.items[0]).toMatchObject({
    searchState: "skipped",
    searchFailureCount: 2,
    candidates: [],
    referencePrice: null,
  });
  expect(second.items[0].similarEstimate).toBeUndefined();
  expect(second.items[0].skipReason).toContain("该候选详情无法读取");
  expect(second.searchAttempts).toHaveLength(2);
  expect(second.searchAttempts![1].rawResponse).toContain("/good");
});

it("快照过期后仍累计失败次数，已达两次的装备不会第三次查询", async () => {
  const value = record();
  const source = failedSource();
  const signal = new AbortController().signal;
  const first = await searchEquipmentPrices(value, signal, source);
  first.searchedAt = new Date(Date.now() - 25 * 3600_000).toISOString();
  const second = await searchEquipmentPrices(value, signal, source, undefined, first);
  expect(second.items[0]).toMatchObject({ searchState: "skipped", searchFailureCount: 2 });
  expect(second.searchItems).toHaveLength(2);
  second.searchedAt = first.searchedAt;
  const third = await searchEquipmentPrices(value, signal, source, undefined, second);
  expect(third.items[0]).toMatchObject({ searchState: "skipped", searchFailureCount: 2 });
  expect(source.findCandidates).toHaveBeenCalledTimes(2);
});

it("期间正常的待续查响应不重置累计失败次数", async () => {
  const value = record();
  const source = failedSource();
  const signal = new AbortController().signal;
  const first = await searchEquipmentPrices(value, signal, source);
  const advanced = await searchEquipmentPrices(
    value,
    signal,
    {
      findCandidates: async () => ({
        queries: ["实际查询"],
        items: [{ key, candidates: [], searchState: "pending" }],
      }),
      readSource: vi.fn(),
    },
    undefined,
    first,
  );
  expect(advanced.items[0].searchFailureCount).toBe(1);
  const second = await searchEquipmentPrices(value, signal, source, undefined, advanced);
  expect(second.items[0]).toMatchObject({ searchState: "skipped", searchFailureCount: 2 });
});

it("用户取消仍抛出，不产生一次装备失败", async () => {
  const controller = new AbortController();
  await expect(
    searchEquipmentPrices(record(), controller.signal, {
      findCandidates: async () => {
        controller.abort(new Error("用户暂停"));
        return { queries: [], items: [] };
      },
      readSource: vi.fn(),
    }),
  ).rejects.toThrow("用户暂停");
});

it.each(["藏宝阁登录已失效", "需要安全验证", "没有访问权限", "实际市场查询未确认三年以上服"])(
  "访问门禁仍抛出而非累计失败：%s",
  async (message) => {
    await expect(
      searchEquipmentPrices(record(), new AbortController().signal, {
        findCandidates: async () => ({
          queries: ["实际查询"],
          items: [{ key, candidates: [], searchState: "read_failed", note: message }],
        }),
        readSource: vi.fn(),
      }),
    ).rejects.toThrow(message);
  },
);

it("候选读取遇登录门禁也立即抛出，不能转换成装备失败次数", async () => {
  await expect(
    searchEquipmentPrices(record(), new AbortController().signal, {
      findCandidates: async () => ({
        queries: ["实际查询"],
        items: [
          {
            key,
            candidates: [
              {
                url: "https://xyq.cbg.163.com/equip/1/login-required",
                title: "测试装备",
                price: 100,
                priceType: "listing",
                quote: "挂牌价：¥100",
                verified: false,
                reason: "",
                fetchedAt: null,
                sourceHash: null,
              },
            ],
          },
        ],
      }),
      readSource: async () => {
        throw new Error("藏宝阁登录已失效");
      },
    }),
  ).rejects.toThrow("藏宝阁登录已失效");
});

it.each([
  "https://xyq.cbg.163.com/equip/2/other-server",
  "https://xyq.cbg.163.com/equip?s=2&eid=other-server",
])("外服候选属于范围门禁，不读取、不计失败：%s", async (url) => {
  const source = {
    findCandidates: vi.fn<EquipmentSource["findCandidates"]>(async () => ({
      queries: ["实际查询"],
      items: [
        {
          key,
          candidates: [
            {
              url,
              title: "测试装备",
              price: 100,
              priceType: "listing",
              quote: "挂牌价：¥100",
              verified: false,
              reason: "",
              fetchedAt: null,
              sourceHash: null,
            },
          ],
        },
      ],
    })),
    readSource: vi.fn(),
  };
  await expect(
    searchEquipmentPrices(record(), new AbortController().signal, source),
  ).rejects.toThrow("候选所属服务器与角色服务器不一致，未采用报价");
  expect(source.findCandidates).toHaveBeenCalledOnce();
  expect(source.readSource).not.toHaveBeenCalled();
});
