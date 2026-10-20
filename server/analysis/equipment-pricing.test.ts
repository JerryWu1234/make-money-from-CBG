import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vite-plus/test";
import { valuationRecord } from "../../tests/fixtures/analysis";
import { itemFromAttributes } from "../crawler/compact";
import type { DetailItem, SavedRoleRecord } from "../crawler/types";
import {
  combineEquipmentPricing,
  equipmentInventory,
  equipmentCoreSkipReason,
  safeEquipmentUrl,
  searchEquipmentPrices,
  verifyEquipmentCandidate,
  type EquipmentCandidate,
  type EquipmentPricingItem,
  type EquipmentPricingSnapshot,
} from "./equipment-pricing";
import { createProfile, DEFAULT_SETTINGS, PROMPT_FILE } from "./profile";
import { calculateValuation } from "./valuation-calculator";
import savedComparables from "../../tests/fixtures/equipment-comparables-20329459.json";
import { buildEquipmentEstimate } from "./pricing-estimate";
import { combinePetPricing, searchPetPricing } from "./pet-pricing";
import { applyValuationRange } from "./valuation-range";

const equipmentName = "测试腰带";
const description =
  "等级：100\n防御：50\n特效：愤怒\n宝石：黑宝石\n锻炼等级：8\n耐久：300\n修理失败：0";
const quote = (price: number, desc = description) =>
  equipmentName + "\n" + desc + "\n挂牌价：¥" + price;
const sourcePage = (price: number, desc = description, status = "在售") =>
  "<p>" +
  status +
  "</p><h1>" +
  equipmentName +
  "</h1><pre>" +
  desc +
  "</pre><div>挂牌价：¥" +
  price +
  "</div>";
function recordWithEquipment(empty = false): SavedRoleRecord {
  const record = valuationRecord();
  record.listing.serverId = "1";
  record.detail!.equipmentCapture = {
    version: 1,
    collectedAt: record.detail!.collectedAt,
    complete: true,
    issues: [],
  };
  record.detail!.tabs.push({
    name: "道具/法宝",
    text: empty ? "没有装备" : "",
    fields: [],
    tables: [],
    elements: [],
    tooltips: [],
    items: empty
      ? []
      : [
          {
            index: 0,
            name: equipmentName,
            kind: "equipment",
            category: "人物装备",
            description,
          },
        ],
  });
  return record;
}
function candidate(
  price = 100,
  url = "https://xyq.cbg.163.com/equip/1/fixture-100",
): EquipmentCandidate {
  return {
    url,
    title: equipmentName,
    price,
    priceType: "listing",
    quote: quote(price),
    verified: false,
    reason: "",
    fetchedAt: null,
    sourceHash: null,
  };
}
function searchResponse(candidates: EquipmentCandidate[], queries = ["测试腰带 100级 愤怒 8锻"]) {
  return {
    items: [{ key: "道具/法宝:0", candidates, note: "", query: queries[0] || "" }],
    queries,
    searchItems: queries.map((query, index) => ({
      id: "search-" + index,
      type: "browser_search",
      query,
    })),
  };
}
async function matchedPricing(record = recordWithEquipment()) {
  const prices = [300, 100, 200];
  const candidates = prices.map((price, index) =>
    candidate(price, "https://xyq.cbg.163.com/equip/1/fixture-" + index),
  );
  const pages = new Map(candidates.map((item) => [item.url, sourcePage(item.price!)]));
  const search = vi.fn().mockResolvedValue(searchResponse(candidates));
  const read = vi.fn(async (url: string) => pages.get(url)!);
  const pricing = await searchEquipmentPrices(record, new AbortController().signal, {
    findCandidates: search,
    readSource: read,
  });
  return { pricing, search, read };
}

describe("装备联网查价的来源核对", () => {
  it.each(
    ["人物装备", "灵饰"].flatMap((category) => [
      [category, equipmentName + "·另一型号", description],
      [category, "另一型号腰带", description + "\n说明：" + equipmentName],
    ]),
  )("%s主标题%s不同时，名称子串或描述中的目标名不能替代同种类证据", (category, name, desc) => {
    const item = { ...equipmentInventory(recordWithEquipment()).items[0], category, kindId: "24" };
    const text = quote(90, desc).replace(equipmentName, name);
    const html = "<main>" + sourcePage(90, desc).replace(equipmentName, name) + "</main>";
    const verified = verifyEquipmentCandidate(
      item,
      { ...candidate(90), quote: text },
      html,
      new Date().toISOString(),
    );
    expect(verified).toMatchObject({ verified: false, reason: expect.stringContaining("名称") });
  });

  it.each(["人物装备", "灵饰"])(
    "%s有相同官方种类时允许不同名称和型号，保留实际商品标题",
    (category) => {
      const kindId = category === "灵饰" ? "61" : "24";
      const item = {
        ...equipmentInventory(recordWithEquipment()).items[0],
        category,
        kindId,
        modelId: "2912",
      };
      const name = "另一型号腰带";
      const text = quote(90).replace(equipmentName, name);
      const verified = verifyEquipmentCandidate(
        item,
        { ...candidate(90), quote: text },
        `<main data-cbg-kind-id="${kindId}" data-cbg-model-id="2913">` +
          sourcePage(90).replace(equipmentName, name) +
          "</main>",
        new Date().toISOString(),
      );
      expect(verified).toMatchObject({ verified: true, title: name, price: 90 });
    },
  );

  it.each([
    [undefined, undefined],
    ["24", undefined],
    [undefined, "24"],
    ["24", "25"],
    ["0", "0"],
  ])("缺少可靠同种类证据时不放宽不同名称和型号：%s/%s", (kindId, sourceKind) => {
    const item = { ...equipmentInventory(recordWithEquipment()).items[0], kindId, modelId: "2912" };
    const text = quote(90).replace(equipmentName, "另一型号腰带");
    const html =
      `<main data-cbg-model-id="2913"${sourceKind ? ` data-cbg-kind-id="${sourceKind}"` : ""}>` +
      sourcePage(90).replace(equipmentName, "另一型号腰带") +
      "</main>";
    expect(
      verifyEquipmentCandidate(
        item,
        { ...candidate(90), quote: text },
        html,
        new Date().toISOString(),
      ).verified,
    ).toBe(false);
  });

  it.each([
    description.replace("等级：100", "等级：110"),
    description.replace("防御：50", "防御：51"),
    description.replace("特效：愤怒", "特效：神农"),
    description + "\n特技：晶清诀",
  ])("同种类跨名样本仍拒绝等级、上限、特效或特技不符：%s", (desc) => {
    const item = {
      ...equipmentInventory(recordWithEquipment()).items[0],
      kindId: "24",
      modelId: "2912",
    };
    const text = quote(90, desc).replace(equipmentName, "另一型号腰带");
    expect(
      verifyEquipmentCandidate(
        item,
        { ...candidate(90), quote: text },
        '<main data-cbg-kind-id="24" data-cbg-model-id="2913">' +
          sourcePage(90, desc).replace(equipmentName, "另一型号腰带") +
          "</main>",
        new Date().toISOString(),
      ).verified,
    ).toBe(false);
  });

  it("官网本项查询种类只用于临时二次核验，不写入库存身份", async () => {
    const record = recordWithEquipment();
    record.detail!.tabs.at(-1)!.items![0].modelId = "2912";
    const before = equipmentInventory(record);
    const text = quote(90).replace(equipmentName, "另一型号腰带");
    const pricing = await searchEquipmentPrices(record, new AbortController().signal, {
      findCandidates: async () => ({
        ...searchResponse([]),
        items: [
          {
            key: before.items[0].key,
            kindId: "24",
            candidates: [{ ...candidate(90), quote: text }],
          },
        ],
      }),
      readSource: async () =>
        '<main data-cbg-kind-id="24" data-cbg-model-id="2913">' +
        sourcePage(90).replace(equipmentName, "另一型号腰带") +
        "</main>",
    });
    expect(pricing.total).toBe(90);
    expect(pricing.items[0].kindId).toBeUndefined();
    expect(equipmentInventory(record)).toEqual(before);
    expect(pricing.inputHash).toBe(before.inputHash);
  });

  it.each(["25", "0", "-1", "1.2", "unknown"])(
    "本项查询种类%s冲突或无效时拒绝且不读候选，不累计失败",
    async (kindId) => {
      const record = recordWithEquipment();
      record.detail!.tabs.at(-1)!.items![0].kindId = "24";
      const readSource = vi.fn().mockResolvedValue(sourcePage(100));
      const checkpoint = vi.fn();
      await expect(
        searchEquipmentPrices(
          record,
          new AbortController().signal,
          {
            findCandidates: async () => ({
              ...searchResponse([]),
              items: [{ key: "道具/法宝:0", kindId, candidates: [candidate()] }],
            }),
            readSource,
          },
          undefined,
          undefined,
          checkpoint,
        ),
      ).rejects.toThrow("未采用报价");
      expect(readSource).not.toHaveBeenCalled();
      expect(checkpoint).not.toHaveBeenCalled();
      expect(equipmentInventory(record).items[0].kindId).toBe("24");
    },
  );

  it.each(["人物装备", "灵饰"])(
    "%s统一采用基础值不高于目标的前五条合格样本最低价，保持官方顺序",
    async (category) => {
      const record = recordWithEquipment();
      const targetDescription =
        category === "灵饰"
          ? "等级：100\n防御：50\n精炼等级：6\n附加属性：\n气血+100 [+168]"
          : description;
      Object.assign(record.detail!.tabs.at(-1)!.items![0], {
        modelId: "2912",
        category,
        description: targetDescription,
      });
      const prices = [900, 100, 1];
      const descriptions = [50, 49, 51].map((value) =>
        targetDescription.replace("防御：50", "防御：" + value),
      );
      const rows = prices.map((price, index) => ({
        ...candidate(price, `https://xyq.cbg.163.com/equip/1/unified-${index}`),
        quote: quote(price, descriptions[index]),
      }));
      const pricing = await searchEquipmentPrices(record, new AbortController().signal, {
        findCandidates: async () => searchResponse(rows),
        readSource: async (url) => {
          const index = rows.findIndex((row) => row.url === url);
          return (
            '<main data-cbg-model-id="2912">' +
            sourcePage(prices[index], descriptions[index]) +
            "</main>"
          );
        },
      });
      expect(pricing).toMatchObject({ total: 100, knownTotal: 100, searchComplete: true });
      expect(pricing.items[0]).toMatchObject({
        comparisonPolicy: "base-upper-bound-v1",
        status: "priced",
        referencePrice: 100,
      });
      expect(pricing.items[0].candidates.map((row) => row.url)).toEqual(rows.map((row) => row.url));
      expect(pricing.items[0].candidates.slice(0, 2).map((row) => row.matchType)).toEqual([
        "exact",
        "similar",
      ]);
      expect(pricing.items[0].candidates[1].differences?.length).toBeGreaterThan(0);
      expect(pricing.items[0].candidates[2]).toMatchObject({
        verified: false,
        reason: expect.stringContaining("高于目标"),
      });
      expect(pricing.items[0].similarEstimate).toBeUndefined();
      const profile = createProfile(readFileSync(PROMPT_FILE, "utf8"));
      const combined = combineEquipmentPricing(
        calculateValuation(record, profile),
        record,
        pricing,
      );
      const line = combined.items.find((row) => row.name.startsWith("装备："))!;
      expect(line).toMatchObject({ amount: 100, confirmed: true });
      expect(line.formula).toContain("基础属性≤目标");
      expect(line.formula).toContain("2条样本");
      expect(line.evidence).toHaveLength(2);
    },
  );

  it("旧快照缺少统一池身份时重新查询，不能沿用旧的同配优先报价", async () => {
    const record = recordWithEquipment();
    const { pricing } = await matchedPricing(record);
    const legacy = structuredClone(pricing);
    delete (legacy.items[0] as EquipmentPricingItem & { comparisonPolicy?: string })
      .comparisonPolicy;
    const findCandidates = vi.fn().mockResolvedValue(searchResponse([candidate(80)]));
    const refreshed = await searchEquipmentPrices(
      record,
      new AbortController().signal,
      {
        findCandidates,
        readSource: async () => sourcePage(80),
      },
      undefined,
      legacy,
    );
    expect(findCandidates).toHaveBeenCalledOnce();
    expect(refreshed.total).toBe(80);
  });

  it("本件首次读取失败保存检查点后待重试，不查询后续装备", async () => {
    const record = recordWithEquipment();
    const tab = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!;
    tab.items!.push({ ...tab.items![0], index: 1 }, { ...tab.items![0], index: 2 });
    const find = vi
      .fn()
      .mockResolvedValueOnce(searchResponse([candidate(100)]))
      .mockResolvedValueOnce({
        ...searchResponse([]),
        items: [{ key: "道具/法宝:1", candidates: [], searchState: "read_failed" }],
      });
    const checkpoint = vi.fn();
    const snapshot = await searchEquipmentPrices(
      record,
      new AbortController().signal,
      {
        findCandidates: find,
        readSource: async () => sourcePage(100),
      },
      undefined,
      undefined,
      checkpoint,
    );
    expect(find).toHaveBeenCalledTimes(2);
    expect(checkpoint).toHaveBeenCalledTimes(2);
    expect(snapshot.items.map((item) => item.searchState)).toEqual([
      "completed",
      "pending",
      "pending",
    ]);
    expect(snapshot.searchComplete).toBe(false);
    expect(snapshot.knownTotal).toBe(100);
  });
  it("逐件保存已核验快照，下一件失败后续跑只查询未完成件", async () => {
    const record = recordWithEquipment();
    const tab = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!;
    tab.items!.push({ ...tab.items![0], index: 1 });
    const find = vi
      .fn()
      .mockResolvedValueOnce(searchResponse([candidate(100)]))
      .mockRejectedValueOnce(new Error("藏宝阁登录已失效"));
    const checkpoints: EquipmentPricingSnapshot[] = [];
    await expect(
      searchEquipmentPrices(
        record,
        new AbortController().signal,
        {
          findCandidates: find,
          readSource: async () => sourcePage(100),
        },
        undefined,
        undefined,
        (snapshot) => checkpoints.push(structuredClone(snapshot)),
      ),
    ).rejects.toThrow("登录已失效");
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].items.map((item) => item.searchState)).toEqual(["completed", "pending"]);
    expect(checkpoints[0].knownTotal).toBe(100);
    const resumedFind = vi.fn(async (items: EquipmentPricingItem[]) => ({
      ...searchResponse([candidate(200, "https://xyq.cbg.163.com/equip/1/second")]),
      items: [
        {
          key: items[0].key,
          candidates: [candidate(200, "https://xyq.cbg.163.com/equip/1/second")],
        },
      ],
    }));
    const final = await searchEquipmentPrices(
      record,
      new AbortController().signal,
      {
        findCandidates: resumedFind,
        readSource: async () => sourcePage(200),
      },
      undefined,
      checkpoints[0],
      () => {},
    );
    expect(resumedFind).toHaveBeenCalledOnce();
    expect(resumedFind.mock.calls[0][0].map((item) => item.key)).toEqual(["道具/法宝:1"]);
    expect(final.total).toBe(300);
    expect(final.searchComplete).toBe(true);
  });
  it("首屏无样本跳过这一件，另一件正常计价；恢复旧查价进度也不重新查询空样本项", async () => {
    const record = recordWithEquipment();
    const tab = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!;
    tab.items!.push({ ...tab.items![0], index: 1 });
    const row = candidate(100);
    const find = vi.fn().mockResolvedValue({
      ...searchResponse([]),
      items: [
        {
          key: "道具/法宝:0",
          candidates: [],
          samplingStopped: true,
          searchState: "pending",
          searchCursor: {
            version: 1,
            planHash: "plan",
            modeIndex: 4,
            pageNumber: 1,
            rowIndex: 0,
            pageRowsHash: "",
            seen: [],
            failed: [],
            emptyFirstPageModes: [0, 1, 2, 3],
          },
        },
        { key: "道具/法宝:1", candidates: [row], searchState: "completed" },
      ],
      searchItems: [{ key: "道具/法宝:0", modes: [{ mode: "exact", exhausted: false }] }],
    });
    const source = { findCandidates: find, readSource: vi.fn().mockResolvedValue(sourcePage(100)) };
    const pricing = await searchEquipmentPrices(record, new AbortController().signal, source);
    expect(pricing).toMatchObject({ searchComplete: true, total: null, knownTotal: 100 });
    expect(pricing.items[0]).toMatchObject({ searchState: "skipped", referencePrice: null });
    expect(pricing.items[1]).toMatchObject({
      searchState: "completed",
      referencePrice: 100,
      status: "priced",
    });
    // Persisted snapshots from before the change used pending + samplingStopped.
    pricing.items[0].searchState = "pending";
    pricing.searchComplete = false;
    const resumed = await searchEquipmentPrices(
      record,
      new AbortController().signal,
      source,
      undefined,
      pricing,
    );
    expect(find).toHaveBeenCalledOnce();
    expect(resumed.searchComplete).toBe(true);
    expect(resumed.knownTotal).toBe(100);
    expect(resumed.items[0].searchState).toBe("skipped");
  });
  it("查价器误报完成但证据未穷尽时保持待续查，下一轮读完才采用价格", async () => {
    const record = recordWithEquipment();
    const row = candidate(100);
    const lookup = (exhausted: boolean) => ({
      ...searchResponse([row]),
      items: [{ key: "道具/法宝:0", candidates: [row], searchState: "completed" as const }],
      searchItems: [{ key: "道具/法宝:0", modes: [{ mode: "exact", exhausted }], exhausted }],
    });
    const first = await searchEquipmentPrices(record, new AbortController().signal, {
      findCandidates: async () => lookup(false),
      readSource: async () => sourcePage(100),
    });
    expect(first).toMatchObject({ searchComplete: false, total: null, knownTotal: 0 });
    expect(first.items[0]).toMatchObject({ searchState: "pending", referencePrice: null });
    expect(first.items[0].issues.join("；")).toContain("搜索记录显示结果尚未读完");
    const resumed = await searchEquipmentPrices(
      record,
      new AbortController().signal,
      {
        findCandidates: async (items) => {
          expect(items[0].candidates).toHaveLength(1);
          return lookup(true);
        },
        readSource: async () => sourcePage(100),
      },
      undefined,
      first,
    );
    expect(resumed).toMatchObject({ searchComplete: true, total: 100, knownTotal: 100 });
  });

  it("同一商品别名返回冲突报价时保留原因，不能任取一条计价", async () => {
    const rows = [
      candidate(100),
      candidate(200, "https://xyq.cbg.163.com/equip?s=1&eid=fixture-100"),
    ];
    const result = await searchEquipmentPrices(
      recordWithEquipment(),
      new AbortController().signal,
      {
        findCandidates: async () => searchResponse(rows),
        readSource: async () => sourcePage(100),
      },
    );
    expect(result.items[0]).toMatchObject({
      searchState: "pending",
      searchFailureCount: 1,
      referencePrice: null,
    });
    expect(result.items[0].candidates.at(-1)?.reason).toContain("报价冲突");
    expect(result.searchComplete).toBe(false);
    expect(result.total).toBeNull();
  });
  it("五件同配置有效报价取最低价，报告金额与表达式采用同一口径", async () => {
    const record = recordWithEquipment();
    const prices = [100, 110, 120, 130, 145];
    const rows = prices.map((price, index) =>
      candidate(price, `https://xyq.cbg.163.com/equip/1/average-${index}`),
    );
    const pages = new Map(rows.map((row) => [row.url, sourcePage(row.price!)]));
    const result = await searchEquipmentPrices(record, new AbortController().signal, {
      findCandidates: async () => searchResponse(rows),
      readSource: async (url) => pages.get(url)!,
    });
    expect(result).toMatchObject({ total: 100, knownTotal: 100, searchComplete: true });
    expect(result.items[0]).toMatchObject({
      priceMethod: "first-five-minimum-v4",
      referencePrice: 100,
      searchState: "completed",
    });
    const profile = createProfile(readFileSync(PROMPT_FILE, "utf8"));
    const combined = combineEquipmentPricing(calculateValuation(record, profile), record, result);
    expect(combined.equipment_value).toBe(100);
    expect(combined.items.at(-1)).toMatchObject({
      amount: 100,
      formula: expect.stringContaining("最低值（5条样本）"),
    });
  });

  it("不足五件且查询中断时保留报价继续搜，不能提前标记已定价", async () => {
    const record = recordWithEquipment();
    const prices = [100, 110, 120, 130, 145];
    const rows = prices.map((price, index) =>
      candidate(price, `https://xyq.cbg.163.com/equip/1/resume-average-${index}`),
    );
    const pages = new Map(rows.map((row) => [row.url, sourcePage(row.price!)]));
    const first = await searchEquipmentPrices(record, new AbortController().signal, {
      findCandidates: async () => ({
        ...searchResponse(rows.slice(0, 2)),
        items: [{ key: "道具/法宝:0", candidates: rows.slice(0, 2), searchState: "pending" }],
      }),
      readSource: async (url) => pages.get(url)!,
    });
    expect(first).toMatchObject({ total: null, knownTotal: 0, searchComplete: false });
    expect(first.items[0]).toMatchObject({ status: "no_match", referencePrice: null });
    expect(first.items[0].candidates).toHaveLength(2);
    const continued = await searchEquipmentPrices(
      record,
      new AbortController().signal,
      {
        findCandidates: async (items) => {
          expect(items[0].candidates).toHaveLength(2);
          return searchResponse(rows);
        },
        readSource: async (url) => pages.get(url)!,
      },
      undefined,
      first,
    );
    expect(continued).toMatchObject({ total: 100, searchComplete: true });
    expect(continued.searchAttempts).toHaveLength(2);
  });

  it("五件候选中有详情读取失败时不把其余四件提前计价，恢复后采用五件最低价", async () => {
    const record = recordWithEquipment();
    const prices = [100, 110, 120, 130, 145];
    const rows = prices.map((price, index) =>
      candidate(price, `https://xyq.cbg.163.com/equip/1/retry-average-${index}`),
    );
    const first = await searchEquipmentPrices(record, new AbortController().signal, {
      findCandidates: async () => searchResponse(rows),
      readSource: async (url) => {
        const index = rows.findIndex((row) => row.url === url);
        if (index === 0) throw new Error("模拟详情暂不可读");
        return sourcePage(prices[index]);
      },
    });
    expect(first).toMatchObject({ total: null, knownTotal: 0, searchComplete: false });
    expect(first.items[0]).toMatchObject({
      searchState: "pending",
      searchFailureCount: 1,
      referencePrice: null,
    });
    expect(first.items[0].candidates.filter((row) => row.verified)).toHaveLength(4);
    const recovered = await searchEquipmentPrices(
      record,
      new AbortController().signal,
      {
        findCandidates: async (items) => {
          expect(items[0].candidates).toHaveLength(4);
          return searchResponse(rows);
        },
        readSource: async (url) => sourcePage(prices[rows.findIndex((row) => row.url === url)]),
      },
      undefined,
      first,
    );
    expect(recovered).toMatchObject({ total: 100, searchComplete: true });
  });
  it("漏填基础条件的旧完成快照必须重查，新条件完成快照才可复用", async () => {
    const record = recordWithEquipment();
    const inventory = equipmentInventory(record);
    const legacyHash = createHash("sha256")
      .update(
        JSON.stringify({
          scopeVersion: "role-server-v1",
          searchUI: "official-form-ui-v2",
          comparisonVersion: "same-kind-exact-suit-v5",
          coreInitialPolicy: "required-slot-initial-attribute-v1",
          specialAssetPolicy: "ordered-special-slots-base-values-v1",
          exclusionPolicy: "exhausted-plain-equipment-up-to-80-v1",
          queryPolicy: "first-five-minimum-v4",
          resumePolicy: "revalidate-pages-and-completion-evidence-v3",
          serverId: record.listing.serverId,
          collectedAt: record.detail!.equipmentCapture!.collectedAt,
          captureComplete: inventory.captureComplete,
          issues: inventory.issues,
          items: inventory.items.map(
            ({ key, name, level, category, kindId, modelId, description, comparisonPolicy }) => ({
              key,
              name,
              level,
              category,
              ...(kindId ? { kindId } : {}),
              ...(modelId ? { modelId } : {}),
              description,
              ...(comparisonPolicy ? { comparisonPolicy } : {}),
            }),
          ),
        }),
      )
      .digest("hex");
    const { pricing: previous } = await matchedPricing(record);
    const findCandidates = vi.fn().mockResolvedValue(searchResponse([candidate(900)]));
    const readSource = vi.fn().mockResolvedValue(sourcePage(900));
    const fresh = await searchEquipmentPrices(
      record,
      new AbortController().signal,
      { findCandidates, readSource },
      undefined,
      { ...previous, inputHash: legacyHash },
    );
    expect(findCandidates).toHaveBeenCalledOnce();
    expect(fresh.total).toBe(900);
    findCandidates.mockClear();
    readSource.mockClear();
    const resumed = await searchEquipmentPrices(
      record,
      new AbortController().signal,
      { findCandidates, readSource },
      undefined,
      fresh,
    );
    expect(findCandidates).not.toHaveBeenCalled();
    expect(readSource).not.toHaveBeenCalled();
    expect(resumed.total).toBe(900);
  });
  it.each(["无全服范围", "旧全服范围", "旧熔炼规则", "旧表单字段规则", "旧额外条件核验"])(
    "%s报价必须重查，当前查询规则的报价仍可复用",
    async (version) => {
      const record = recordWithEquipment();
      const inventory = equipmentInventory(record);
      // Reproduce the pre-audit fingerprint so a genuine old-format cache is exercised.
      const legacyHash = createHash("sha256")
        .update(
          JSON.stringify({
            ...(version !== "无全服范围" ? { scopeVersion: "global-older-servers-v1" } : {}),
            ...(["旧熔炼规则", "旧表单字段规则", "旧额外条件核验"].includes(version)
              ? {
                  searchUI: "official-form-ui-v1",
                  comparisonVersion: "jewelry-sections-v1",
                }
              : {}),
            ...(["旧表单字段规则", "旧额外条件核验"].includes(version)
              ? {
                  queryPolicy:
                    version === "旧额外条件核验"
                      ? "observed-form-fields-without-melting-v2"
                      : "observed-values-without-melting-v1",
                }
              : {}),
            serverId: record.listing.serverId,
            collectedAt: record.detail!.equipmentCapture!.collectedAt,
            captureComplete: inventory.captureComplete,
            issues: inventory.issues,
            items: inventory.items.map(
              ({ key, name, level, category, kindId, modelId, description }) => ({
                key,
                name,
                level,
                category,
                ...(kindId ? { kindId } : {}),
                ...(modelId ? { modelId } : {}),
                description,
              }),
            ),
          }),
        )
        .digest("hex");
      const { pricing: previous } = await matchedPricing(record);
      expect(previous.total).toBe(100);
      expect(previous.inputHash).not.toBe(legacyHash);
      const legacy = { ...previous, inputHash: legacyHash, searchItems: undefined };
      const findCandidates = vi.fn().mockResolvedValue(searchResponse([candidate(900)]));
      const readSource = vi.fn().mockResolvedValue(sourcePage(900));
      const fresh = await searchEquipmentPrices(
        record,
        new AbortController().signal,
        { findCandidates, readSource },
        undefined,
        legacy,
      );
      expect(findCandidates).toHaveBeenCalledOnce();
      expect(readSource).toHaveBeenCalledOnce();
      expect(fresh.total).toBe(900);
      expect(fresh.inputHash).toBe(inventory.inputHash);
      const cachedSearch = vi.fn(),
        cachedRead = vi.fn();
      const resumed = await searchEquipmentPrices(
        record,
        new AbortController().signal,
        { findCandidates: cachedSearch, readSource: cachedRead },
        undefined,
        fresh,
      );
      expect(cachedSearch).not.toHaveBeenCalled();
      expect(cachedRead).not.toHaveBeenCalled();
      expect(resumed.total).toBe(900);
    },
  );
  it("预算中断保存逐件进度，继续只重查未完成装备并保留完整来源", async () => {
    const record = recordWithEquipment();
    record.detail!.tabs.at(-1)!.items!.push({ ...record.detail!.tabs.at(-1)!.items![0], index: 1 });
    const keys = equipmentInventory(record).items.map((item) => item.key);
    const read = vi.fn().mockResolvedValue(sourcePage(100));
    const firstSearch = vi.fn().mockResolvedValue({
      queries: ["first"],
      items: [
        { key: keys[0], candidates: [candidate()], searchState: "completed" },
        { key: keys[1], candidates: [], searchState: "pending", note: "时间预算耗尽" },
      ],
    });
    const first = await searchEquipmentPrices(record, new AbortController().signal, {
      findCandidates: firstSearch,
      readSource: read,
    });
    expect(first.searchComplete).toBe(false);
    expect(first.items.map((item) => item.searchState)).toEqual(["completed", "pending"]);
    const secondSearch = vi.fn().mockResolvedValue({
      queries: ["second"],
      items: [{ key: keys[1], candidates: [candidate(200)], searchState: "completed" }],
    });
    const second = await searchEquipmentPrices(
      record,
      new AbortController().signal,
      { findCandidates: secondSearch, readSource: async () => sourcePage(200) },
      undefined,
      first,
    );
    expect(secondSearch.mock.calls[0][0].map((item: { key: string }) => item.key)).toEqual([
      keys[1],
    ]);
    expect(second).toMatchObject({
      searchComplete: true,
      knownTotal: 300,
      total: 300,
      queries: ["first", "second"],
    });
    expect(second.items[0]).toEqual(first.items[0]);
    expect(second.searchAttempts).toHaveLength(2);
    expect(JSON.parse(second.searchAttempts![0].rawResponse).items[1].searchState).toBe("pending");
    const expired = { ...first, searchedAt: "2000-01-01T00:00:00.000Z" };
    await searchEquipmentPrices(
      record,
      new AbortController().signal,
      { findCandidates: firstSearch, readSource: read },
      undefined,
      expired,
    );
    expect(firstSearch.mock.calls.at(-1)![0]).toHaveLength(2);
  });
  it("前5条中排除更高属性样本，同值与较低基础值报价统一取最低价", async () => {
    const record = recordWithEquipment();
    record.detail!.tabs.at(-1)!.items![0].modelId = "2912";
    const descriptions = [48, 49, 52].map((value) =>
      description.replace("防御：50", "防御：" + value),
    );
    const candidates = descriptions.map((desc, index) => ({
      ...candidate([100, 120, 140][index], "https://xyq.cbg.163.com/equip/1/similar-" + index),
      quote: quote([100, 120, 140][index], desc),
    }));
    const pages = new Map(
      candidates.map((value, index) => [
        value.url,
        '<main data-cbg-model-id="2912">' +
          sourcePage(value.price!, descriptions[index]) +
          "</main>",
      ]),
    );
    const source = {
      findCandidates: vi.fn().mockResolvedValue(searchResponse(candidates)),
      readSource: vi.fn(async (url: string) => pages.get(url)!),
    };
    const result = await searchEquipmentPrices(record, new AbortController().signal, source);
    expect(result).toMatchObject({ total: 100, knownTotal: 100 });
    expect(result.items[0]).toMatchObject({
      status: "priced",
      referencePrice: 100,
    });
    expect(result.items[0].similarEstimate).toBeUndefined();
    expect(
      result.items[0].candidates
        .slice(0, 2)
        .every((value) => value.verified && value.matchType === "similar"),
    ).toBe(true);
    expect(result.items[0].candidates[2].reason).toContain("高于目标");
    const exact = candidate(110, "https://xyq.cbg.163.com/equip/1/exact");
    pages.set(exact.url, sourcePage(110));
    source.findCandidates.mockResolvedValue(searchResponse([...candidates, exact]));
    const mixed = await searchEquipmentPrices(record, new AbortController().signal, source);
    expect(mixed.items[0]).toMatchObject({ status: "priced", referencePrice: 100 });
    expect(mixed.total).toBe(100);
  });

  it("相近装备保留官方顺序前五件，不按属性距离另挑三件", async () => {
    const record = recordWithEquipment();
    record.detail!.tabs.at(-1)!.items![0].modelId = "2912";
    const stats = [45, 44, 49, 41, 48];
    const prices = [100, 110, 120, 130, 145];
    const descriptions = stats.map((value) => description.replace("防御：50", "防御：" + value));
    const candidates = descriptions.map((desc, index) => ({
      ...candidate(prices[index], "https://xyq.cbg.163.com/equip/1/cohort-" + index),
      quote: quote(prices[index], desc),
    }));
    const response = searchResponse(candidates);
    const pages = new Map(
      candidates.map((value, index) => [
        value.url,
        '<main data-cbg-model-id="2912">' +
          sourcePage(value.price!, descriptions[index]) +
          "</main>",
      ]),
    );
    const result = await searchEquipmentPrices(record, new AbortController().signal, {
      findCandidates: async () => response,
      readSource: async (url) => pages.get(url)!,
    });
    expect(result.items[0]).toMatchObject({ status: "priced", referencePrice: 100 });
    expect(result.items[0].similarEstimate).toBeUndefined();
    expect(result.items[0].candidates.map((value) => value.price)).toEqual(prices);
    expect(buildEquipmentEstimate(result.items[0].candidates).average).toBe(121);
    expect(JSON.parse(result.rawResponse!).items[0].candidates).toHaveLength(5);
  });

  it("离线重放历史样本，只采用基础值不高于目标且配置合格的样本", () => {
    const record = recordWithEquipment();
    record.detail!.tabs.at(-1)!.items = savedComparables.items.map(({ target }) => ({
      ...target,
      kind: "equipment",
      attributes: target.attributes as Record<string, string>,
    }));
    const inventory = equipmentInventory(record);
    for (const group of savedComparables.items) {
      const item = inventory.items.find((item) => item.name === group.target.name)!;
      const verified = group.candidates.map((source) => {
        // Reconstruct the primary-product boundary only for offline matching regression.
        const observedDescription = source.quote
          .slice(item.name.length)
          .replace(/\n挂牌价：¥[\d.]+$/, "")
          .replace(/在售$/, "");
        const html = `<main data-cbg-model-id="${item.modelId}"><h1>${item.name}</h1><pre>${observedDescription}</pre><p>在售\n挂牌价：¥${source.price}</p></main>`;
        return verifyEquipmentCandidate(
          item,
          { ...candidate(source.price, source.url), quote: source.quote },
          html,
          new Date().toISOString(),
        );
      });
      const expected: Record<string, number[]> = {
        水晶帽: [],
        神火扇: [],
        八卦坠: [1194.4, 1045, 1192, 888],
        龙骨甲: [],
      };
      const prices = verified.filter((row) => row.verified).map((row) => row.price!);
      expect(prices, item.name).toEqual(expected[item.name]);
      if (item.name === "龙骨甲")
        for (const row of verified.filter((row) => [2299, 611].includes(row.price!))) {
          expect(row.verified).toBe(false);
          expect(row.reason).toContain("高于目标");
        }
      const estimate = buildEquipmentEstimate(verified);
      if (!prices.length) {
        expect(estimate.status).toBe("insufficient");
        expect(estimate.range).toBeNull();
      } else {
        expect(estimate.sampleCount).toBe(prices.length);
        expect(estimate.range?.min).toBe(Math.min(...prices));
      }
    }
  });

  it("相近样本官方型号不一致或缺证据都拒绝，关键特效不放宽", () => {
    const item = { ...equipmentInventory(recordWithEquipment()).items[0], modelId: "2912" };
    const desc = description.replace("防御：50", "防御：49");
    for (const id of [undefined, "9999"]) {
      const html = `<main${id ? ' data-cbg-model-id="' + id + '"' : ""}>${sourcePage(100, desc)}</main>`;
      expect(
        verifyEquipmentCandidate(
          item,
          { ...candidate(), quote: quote(100, desc) },
          html,
          new Date().toISOString(),
        ).verified,
      ).toBe(false);
    }
    const effects = desc.replace("愤怒", "暴怒");
    expect(
      verifyEquipmentCandidate(
        item,
        { ...candidate(), quote: quote(100, effects) },
        '<main data-cbg-model-id="2912">' + sourcePage(100, effects) + "</main>",
        new Date().toISOString(),
      ).verified,
    ).toBe(false);
  });

  it("玉魄无需等级，必须核对阴阳型号和完整奇袭/到期描述", () => {
    const desc =
      "防御 +25\n耐久度 102\n抵抗封印等级 +13 [+48]\n气血 +67 [+168]\n奇袭特技：破血狂攻\n有效期：2026-12-01";
    const item = {
      ...equipmentInventory(recordWithEquipment()).items[0],
      name: "上古玉魄·阴",
      category: "上古玉魄",
      modelId: "61717",
      level: null,
      description: desc,
    };
    const quote = "上古玉魄·阴\n" + desc + "\n在售\n挂牌价：¥100";
    const html =
      '<main data-cbg-model-id="61717"><p>上古玉魄·阴</p><pre data-cbg-equipment-description>' +
      desc +
      "</pre><p>在售\n挂牌价：¥100</p></main>";
    expect(
      verifyEquipmentCandidate(item, { ...candidate(), quote }, html, new Date().toISOString())
        .verified,
    ).toBe(true);
    for (const changed of [
      html.replace("61717", "61718"),
      html.replace("2026-12-01", "2026-11-01"),
      html.replace("奇袭特技：破血狂攻", ""),
    ])
      expect(
        verifyEquipmentCandidate(item, { ...candidate(), quote }, changed, new Date().toISOString())
          .verified,
      ).toBe(false);
  });
  it("玉魄tooltip只剔除自身完整名称标题，未知行和到期条件仍逐项核验", () => {
    const description = "防御 +25\n耐久度 102\n有效期：2026-12-01";
    const item = {
      ...equipmentInventory(recordWithEquipment()).items[0],
      name: "上古玉魄·阴",
      category: "上古玉魄",
      modelId: "61717",
      level: null,
      description,
    };
    const source = (prefix: string, suffix = "") =>
      '<main data-cbg-model-id="61717"><pre data-cbg-equipment-description>' +
      prefix +
      "\n" +
      description +
      suffix +
      "</pre><p>在售\n挂牌价：¥100</p></main>";
    const quoted = {
      ...candidate(),
      quote: "防御 +25\n耐久度 102\n有效期：2026-12-01" + "\n在售\n挂牌价：¥100",
    };
    expect(
      verifyEquipmentCandidate(item, quoted, source("上古玉魄·阴"), new Date().toISOString())
        .verified,
    ).toBe(true);
    for (const html of [
      source("上古玉魄·阳"),
      source("上古玉魄·阴", "\n未识别的效形限制"),
      source("上古玉魄·阴").replace("2026-12-01", "2026-11-01"),
    ])
      expect(verifyEquipmentCandidate(item, quoted, html, new Date().toISOString()).verified).toBe(
        false,
      );
  });
  it("实际0级双短剑保留为装备并按规则排除，不当空装或发越界查询", async () => {
    const record = recordWithEquipment();
    const item = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items![0];
    delete item.category;
    item.name = "双短剑";
    item.description = "命中 +20\n伤害 +15\n耐久度 100";
    item.attributes = { 装备条件: "等级 0", 装备角色: "英女侠，飞燕女" };
    const inventory = equipmentInventory(record);
    expect(inventory).toMatchObject({ captureComplete: true, issues: [] });
    expect(inventory.items[0]).toMatchObject({
      name: "双短剑",
      level: 0,
      category: "人物装备",
      status: "unsupported",
      searchState: "skipped",
      skipReason: "官网检索不支持的等级装备，未计入参考合计",
      referencePrice: null,
    });
    expect(inventory.items[0].issues.join(" ")).toContain("0级装备尚缺");
    const search = vi.fn(),
      read = vi.fn();
    const pricing = await searchEquipmentPrices(record, new AbortController().signal, {
      findCandidates: search,
      readSource: read,
    });
    expect(pricing).toMatchObject({ total: null, knownTotal: 0 });
    expect(search).not.toHaveBeenCalled();
  });

  it.each([10, 20, 30, 40, 50, 170])(
    "%i级特殊人物装备不计价并跳过，后面的可查询装备继续查价",
    async (level) => {
      const record = recordWithEquipment();
      const tab = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!;
      tab.items!.unshift({
        ...tab.items![0],
        index: 1,
        name: "越界特殊腰带",
        description: description.replace("等级：100", "等级：" + level),
      });
      const { pricing, search } = await matchedPricing(record);
      expect(search.mock.calls[0][0].map((item: { name: string }) => item.name)).toEqual([
        equipmentName,
      ]);
      expect(pricing.items[0]).toMatchObject({
        level,
        status: "unsupported",
        searchState: "skipped",
        skipReason: "官网检索不支持的等级装备，未计入参考合计",
        referencePrice: null,
      });
      expect(pricing.items[0].issues.join(" ")).toContain(level + "级装备尚缺");
      expect(pricing.items[1]).toMatchObject({ status: "priced", referencePrice: 100 });
      expect(pricing).toMatchObject({ captureComplete: true, searchComplete: true, total: null });
    },
  );

  it.each([
    { level: 70, category: "人物装备 · 戒指" },
    { level: 90, category: "人物装备", kindId: "61" },
    { level: 110, category: "人物装备", description: "等级：110\n防御：50\n精炼等级：5" },
  ])("灵饰使用独立20级步长，不发送普通装备滑条条件：%j", (changes) => {
    const record = recordWithEquipment();
    Object.assign(record.detail!.tabs.at(-1)!.items![0], changes, {
      description:
        changes.description || description.replace("等级：100", "等级：" + changes.level),
    });
    expect(equipmentInventory(record).items[0]).toMatchObject({ status: "unsupported" });
    expect(equipmentInventory(record).items[0].issues.join(" ")).toContain("灵饰");
  });

  it("官方玉魄无需普通装备等级但独立缺价不算0，已核对的普通装备仍可查价", async () => {
    const record = recordWithEquipment();
    record
      .detail!.tabs.find((tab) => tab.name === "道具/法宝")!
      .items!.push({
        index: 1,
        name: "上古玉魄·阴",
        kind: "equipment",
        modelId: "61717",
        location: "仓库",
        description: "防御 +25\n耐久度 102\n抵抗封印等级 +13 [+48]\n气血 +67 [+168]",
      });
    const inventory = equipmentInventory(record);
    expect(inventory).toMatchObject({ captureComplete: true, issues: [] });
    expect(inventory.items[1]).toMatchObject({
      category: "上古玉魄",
      modelId: "61717",
      level: null,
      status: "no_match",
      referencePrice: null,
    });
    expect(inventory.items[1].issues).not.toContain("装备等级缺失");
    expect(inventory.items[1].comparisonPolicy).toBeUndefined();
    const { pricing, search } = await matchedPricing(record);
    expect(search.mock.calls[0][0].map((item: { name: string }) => item.name)).toEqual([
      equipmentName,
      "上古玉魄·阴",
    ]);
    expect(pricing).toMatchObject({ total: null, knownTotal: 100 });
    expect(pricing.items[1].issues.join(" ")).toContain("未返回");
  });

  it.each(["元身", "材料 · 元身", "已观察元身型号"])(
    "已采集的%s进入元身查价流程，不被误当空库存",
    async (category) => {
      const record = recordWithEquipment();
      const item = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items![0];
      item.name = "剑·元身";
      item.category = category === "已观察元身型号" ? "材料" : category;
      if (category === "已观察元身型号") item.modelId = "4223";
      item.description = "等级：160\n伤害：500\n命中：600";
      const inventory = equipmentInventory(record);
      expect(inventory.captureComplete).toBe(true);
      expect(inventory.items).toHaveLength(1);
      expect(inventory.items[0]).toMatchObject({
        name: "剑·元身",
        category: "元身",
        status: "no_match",
        referencePrice: null,
      });
      expect(inventory.items[0].comparisonPolicy).toBeUndefined();
      const findCandidates = vi.fn().mockResolvedValue({
          queries: ["元身独立表单"],
          items: [{ key: "道具/法宝:0", candidates: [] }],
        }),
        readSource = vi.fn();
      const pricing = await searchEquipmentPrices(record, new AbortController().signal, {
        findCandidates,
        readSource,
      });
      expect(pricing).toMatchObject({ total: null, knownTotal: 0 });
      expect(findCandidates).toHaveBeenCalledOnce();
      expect(readSource).not.toHaveBeenCalled();
    },
  );

  it("已核对的技能书模型归普通道具范围，旧记录只见名字不能凭名字排除", () => {
    const record = recordWithEquipment();
    const items = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items!;
    items.push({ index: 1, name: "魔兽要诀", kind: "equipment", modelId: "611" });
    expect(equipmentInventory(record)).toMatchObject({ captureComplete: true, issues: [] });
    expect(equipmentInventory(record).items).toHaveLength(1);
    delete items[1].modelId;
    expect(equipmentInventory(record)).toMatchObject({ captureComplete: false });
    expect(equipmentInventory(record).issues.join(" ")).toContain("物品类别或装备属性未识别");
  });

  it("旧库存只有数字类别时按已采到的腰带槽位补分类，不猜官网kindid", () => {
    const record = recordWithEquipment();
    const item = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items![0];
    item.category = "9";
    item.location = "role_using_equip_5";
    expect(equipmentInventory(record).items[0]).toMatchObject({ category: "人物装备 · 腰带" });
    expect(equipmentInventory(record).items[0].kindId).toBeUndefined();
  });
  function sameRoleModelRecord() {
    const record = recordWithEquipment(true);
    const items = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items!;
    items.push(
      {
        index: 0,
        name: "双魂引",
        kind: "equipment",
        category: "人物装备",
        modelId: "2911",
        location: "RoleEquipList:0",
        description: "等级：60\n防御：25\n气血：180\n特技：破血狂攻",
      },
      {
        index: 1,
        name: "双魂引",
        kind: "equipment",
        category: "人物装备",
        modelId: "2911",
        location: "role_using_equip_5",
        description: "等级：60\n防御：26\n气血：183\n特效：愤怒",
      },
    );
    return { record, items };
  }

  it.each([false, true])("同角色精确型号复用实际佩戴槽位，顺序倒置=%s也保留各自属性", (reverse) => {
    const { record, items } = sameRoleModelRecord();
    const untyped = structuredClone(record);
    untyped.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items![1].location =
      "RoleEquipList:1";
    const oldHash = equipmentInventory(untyped).inputHash;
    if (reverse) items.reverse();
    const before = JSON.stringify(record);
    const inventory = equipmentInventory(record);
    const bag = inventory.items.find((item) => item.key === "道具/法宝:0")!;
    expect(bag).toMatchObject({
      name: "双魂引",
      modelId: "2911",
      level: 60,
      category: "人物装备 · 腰带",
      description: "等级：60\n防御：25\n气血：180\n特技：破血狂攻",
      status: "no_match",
    });
    expect(bag.kindId).toBeUndefined();
    expect(JSON.stringify(record)).toBe(before);
    expect(inventory.inputHash).not.toBe(oldHash);
  });

  it.each<Partial<DetailItem>>([
    { modelId: "2910" },
    { name: "攫魂铃" },
    { description: "等级：70\n防御：26\n气血：183" },
    { modelId: undefined },
    { description: "防御：26\n气血：183" },
    { location: "RoleEquipList:1", category: "人物装备 · 腰带" },
  ])("类型证据不精确或不是佩戴位置时保持未知：%j", (changes) => {
    const { record, items } = sameRoleModelRecord();
    Object.assign(items[1], changes);
    expect(
      equipmentInventory(record).items.find((item) => item.key === "道具/法宝:0")!.category,
    ).toBe("人物装备");
  });

  it.each<Partial<DetailItem>>([{ category: "人物装备 · 饰品" }, { kindId: "21" }])(
    "来源有明确类别或未经核对的独立kind时不传播槽位推断：%j",
    (changes) => {
      const { record, items } = sameRoleModelRecord();
      Object.assign(items[1], changes);
      expect(equipmentInventory(record).items[0].category).toBe("人物装备");
    },
  );

  it("精确键的佩戴槽位冲突时不复用，也不跨角色复用", () => {
    const { record, items } = sameRoleModelRecord();
    items.push({ ...items[1], index: 2, location: "role_using_equip_4" });
    expect(equipmentInventory(record).items[0].category).toBe("人物装备");
    const other = sameRoleModelRecord();
    other.items.pop();
    expect(equipmentInventory(other.record).items[0].category).toBe("人物装备");
  });

  it.each<Partial<DetailItem>>([{ category: "人物装备 · 饰品" }, { kindId: "21" }])(
    "明确类别或官网kind不被同角色型号覆盖：%j",
    (changes) => {
      const { record, items } = sameRoleModelRecord();
      Object.assign(items[0], changes);
      expect(equipmentInventory(record).items[0]).toMatchObject(changes);
      expect(equipmentInventory(record).items[0].category).toBe(changes.category || "人物装备");
    },
  );

  it("复用佩戴类型后仍拒绝核心初始值缺失，不能只按特技查价", () => {
    const { record, items } = sameRoleModelRecord();
    items[0].description = "等级：60\n防御：25\n特技：破血狂攻";
    expect(equipmentInventory(record).items[0]).toMatchObject({
      category: "人物装备 · 腰带",
      status: "unsupported",
      searchState: "skipped",
      skipReason: expect.stringContaining("核心初始气血"),
    });
  });

  it("采齐的法宝灵宝神器不误报漏采或计装备价，混入真实装备仍正常查价", async () => {
    const record = recordWithEquipment();
    record
      .detail!.tabs.find((tab) => tab.name === "道具/法宝")!
      .items!.push(
        {
          index: 1,
          name: "测试法宝",
          kind: "equipment",
          category: "法宝",
          location: "RoleUsingFabao",
          description: "灵气：500\n修炼境界：第15层",
        },
        {
          index: 2,
          name: "测试灵宝",
          kind: "equipment",
          category: "灵宝",
          location: "RoleStoreLingbao",
        },
        {
          index: 3,
          name: "测试神器",
          kind: "equipment",
          category: "神器",
          location: "RoleStoreShenqi",
        },
      );
    const inventory = equipmentInventory(record);
    expect(inventory.captureComplete).toBe(true);
    expect(inventory.issues).toEqual([]);
    expect(inventory.items.map((item) => item.name)).toEqual([equipmentName]);
    const { pricing, search } = await matchedPricing(record);
    expect(search).toHaveBeenCalledOnce();
    expect(search.mock.calls[0][0].map((item: { name: string }) => item.name)).toEqual([
      equipmentName,
    ]);
    expect(pricing.items.map((item) => item.name)).toEqual([equipmentName]);
    expect(pricing.captureComplete).toBe(true);
    expect(pricing.total).toBe(100);
    expect(pricing.knownTotal).toBe(100);
  });
  it("官方kindid原值进入结构化查价且改变输入快照，不从物品类别推算", async () => {
    const record = recordWithEquipment();
    const item = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items![0];
    const oldHash = equipmentInventory(record).inputHash;
    expect(equipmentInventory(record).items[0].kindId).toBeUndefined();
    item.kindId = "025";
    expect(equipmentInventory(record).inputHash).not.toBe(oldHash);
    const { search, pricing } = await matchedPricing(record);
    expect(search.mock.calls[0][0][0].kindId).toBe("025");
    expect(pricing.items[0].kindId).toBe("025");
    expect(JSON.parse(pricing.requestText!)[0].kindId).toBe("025");
  });
  it("只有attributes的装备仍识别并查价，不误认为空装备", async () => {
    const record = recordWithEquipment();
    const item = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items![0];
    delete item.description;
    delete item.category;
    item.attributes = {
      装备: equipmentName,
      等级: "100",
      防御: "50",
      特效: "愤怒",
      宝石: "黑宝石",
      锻炼等级: "8",
      耐久: "300",
      修理失败: "0",
    };
    const inventory = equipmentInventory(record);
    expect(inventory.items).toHaveLength(1);
    expect(inventory.items[0]).toMatchObject({ level: 100, status: "no_match" });
    expect(inventory.items[0].description).toContain("防御：50");
    const { pricing, search } = await matchedPricing(record);
    expect(search).toHaveBeenCalledOnce();
    expect(pricing.total).toBe(100);
  });

  it("纳入道具子页；同明确槽位跨页序号不同仍只算一次，另一位置装备保留", () => {
    const record = recordWithEquipment();
    const tab = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!;
    tab.items![0].location = "装备槽位:腰带";
    record.detail!.tabs.push({
      ...tab,
      name: "道具/法宝 / 人物装备",
      items: [{ ...tab.items![0], index: 9 }],
    });
    record.detail!.tabs.push({
      ...tab,
      name: "道具/法宝 / 行囊",
      items: [{ ...tab.items![0], location: "行囊" }],
    });
    const inventory = equipmentInventory(record);
    expect(inventory.captureComplete).toBe(true);
    expect(inventory.items).toHaveLength(2);
    expect(inventory.items.map((item) => item.key)).toEqual(["道具/法宝:0", "道具/法宝 / 行囊:0"]);
  });

  it.each([1, 2, 3, 4, 5, 6, 187, 188, 189, 190])(
    "真实已核验穿戴槽位 role_using_equip_%i 跨页只查一次，仓库同配物品保留",
    async (slot) => {
      const record = recordWithEquipment();
      const tab = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!;
      tab.items![0].description = "等级100\n防御50\n气血250\n灵力100\n敏捷30\n伤害300";
      tab.items![0].location = "role_using_equip_" + slot;
      record.detail!.tabs.push({
        ...tab,
        name: "道具/法宝 / 人物装备",
        items: [{ ...tab.items![0], index: 9 }],
      });
      record.detail!.tabs.push({
        ...tab,
        name: "道具/法宝 / 仓库",
        items: [{ ...tab.items![0], location: "RoleStoreEquips" }],
      });
      const { pricing, search } = await matchedPricing(record);
      expect(pricing).toMatchObject({ captureComplete: true, issues: [] });
      expect(pricing.items.map((item) => item.key)).toEqual(["道具/法宝:0", "道具/法宝 / 仓库:0"]);
      expect(search).toHaveBeenCalledOnce();
      expect(search.mock.calls[0][0]).toHaveLength(2);
    },
  );

  it.each(["role_using_equip_7", "role_using_equip_05", "role_using_equip_187_copy"])(
    "未核验的类似槽位ID %s 不推测去重",
    (location) => {
      const record = recordWithEquipment();
      const tab = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!;
      tab.items![0].location = location;
      record.detail!.tabs.push({
        ...tab,
        name: "道具/法宝 / 人物装备",
        items: [{ ...tab.items![0], index: 9 }],
      });
      const inventory = equipmentInventory(record);
      expect(inventory.items).toHaveLength(2);
      expect(inventory.captureComplete).toBe(false);
      expect(inventory.issues.join(" ")).toContain("同一容器重复");
    },
  );

  it("跨页疑似重复但没有来源位置时阻塞查价，不能把同件重复加价", async () => {
    const record = recordWithEquipment();
    const tab = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!;
    record.detail!.tabs.push({
      ...tab,
      name: "道具/法宝 / 人物装备",
      items: [{ ...tab.items![0] }],
    });
    const search = vi.fn(),
      read = vi.fn();
    const pricing = await searchEquipmentPrices(record, new AbortController().signal, {
      findCandidates: search,
      readSource: read,
    });
    expect(pricing.captureComplete).toBe(false);
    expect(pricing.total).toBeNull();
    expect(pricing.issues.join(" ")).toContain("多页重复");
    expect(pricing.searchComplete).toBe(true);
    expect(pricing.items.some((item) => item.searchState === "pending")).toBe(false);
    expect(search).not.toHaveBeenCalled();
  });

  it("来源仅给容器名而非具体槽位时，不推测跨页重复是否同件", () => {
    const record = recordWithEquipment();
    const tab = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!;
    tab.items![0].location = "人物装备";
    record.detail!.tabs.push({
      ...tab,
      name: "道具/法宝 / 人物装备",
      items: [{ ...tab.items![0], index: 9 }],
    });
    const inventory = equipmentInventory(record);
    expect(inventory.captureComplete).toBe(false);
    expect(inventory.issues.join(" ")).toContain("同一容器重复");
  });

  it("同页两个相同配置的不同物品序号不误删；未识别装备不当作空", () => {
    const record = recordWithEquipment();
    const tab = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!;
    tab.items!.push({ ...tab.items![0], index: 1 });
    expect(equipmentInventory(record).items).toHaveLength(2);
    tab.items = [{ index: 0, kind: "equipment", name: "未识别图标" }];
    expect(equipmentInventory(record)).toMatchObject({ captureComplete: false, items: [] });
    expect(equipmentInventory(record).issues.join(" ")).toContain("不能当作没有装备");
  });

  it("旧详情或未采齐的装备不发搜索，不把未知当成0元", async () => {
    for (const legacy of [true, false]) {
      const record = recordWithEquipment();
      if (legacy) delete record.detail!.equipmentCapture;
      else record.detail!.equipmentCapture!.complete = false;
      const search = vi.fn(),
        read = vi.fn();
      const pricing = await searchEquipmentPrices(record, new AbortController().signal, {
        findCandidates: search,
        readSource: read,
      });
      expect(pricing).toMatchObject({ captureComplete: false, total: null, searchComplete: true });
      expect(pricing.items.some((item) => item.searchState === "pending")).toBe(false);
      expect(search).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    }
  });

  it("旧空库存仅有现金或法宝不能推断0，确认空容器后仍允许0", async () => {
    const record = recordWithEquipment(true);
    const tab = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!;
    tab.text = "现金：100\n存银：0";
    tab.items = [{ index: 0, name: "法宝", kind: "equipment", category: "法宝" }];
    const search = vi.fn(),
      read = vi.fn();
    const pricing = await searchEquipmentPrices(record, new AbortController().signal, {
      findCandidates: search,
      readSource: read,
    });
    expect(pricing).toMatchObject({ captureComplete: false, total: null, items: [] });
    expect(pricing.issues.join(" ")).toContain("库存是否为空尚未核对");
    expect(search).not.toHaveBeenCalled();
    tab.items = [{ index: 0, name: "图标 1" }];
    expect(equipmentInventory(record).captureComplete).toBe(false);
    tab.items = [];
    record.detail!.equipmentCapture!.emptyProof = "official-containers";
    const confirmed = await searchEquipmentPrices(record, new AbortController().signal, {
      findCandidates: search,
      readSource: read,
    });
    expect(confirmed).toMatchObject({ captureComplete: true, total: 0, items: [] });
  });

  it("只有采集元数据完整且装备页确认为空，才能记录装备价值0", async () => {
    const record = recordWithEquipment(true);
    const search = vi.fn(),
      read = vi.fn();
    const pricing = await searchEquipmentPrices(record, new AbortController().signal, {
      findCandidates: search,
      readSource: read,
    });
    expect(pricing).toMatchObject({ captureComplete: true, total: 0, knownTotal: 0, items: [] });
    record.detail!.tabs.pop();
    const missingTab = await searchEquipmentPrices(record, new AbortController().signal, {
      findCandidates: search,
      readSource: read,
    });
    expect(missingTab).toMatchObject({ captureComplete: false, total: null });
    record.detail!.tabs.push({
      name: "道具/法宝",
      text: "",
      fields: [],
      tables: [],
      elements: [],
      tooltips: [],
      items: [],
    });
    record.detail!.equipmentCapture!.issues = ["装备图标数量未核对"];
    const inconsistent = await searchEquipmentPrices(record, new AbortController().signal, {
      findCandidates: search,
      readSource: read,
    });
    expect(inconsistent).toMatchObject({ captureComplete: false, total: null });
    expect(search).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("3条独立可信挂牌取最低价，保留程序查询、结构化候选及逐条网页证据", async () => {
    const record = recordWithEquipment();
    record.detail!.raw = { privateContent: "must-not-send-raw" };
    record.listing.attrs = { login: "must-not-send-login" };
    const { pricing, search, read } = await matchedPricing(record);
    expect(pricing).toMatchObject({ captureComplete: true, total: 100, knownTotal: 100 });
    expect(pricing.items[0]).toMatchObject({ status: "priced", referencePrice: 100 });
    expect(pricing.items[0].candidates).toHaveLength(3);
    for (const source of pricing.items[0].candidates) {
      expect(source).toMatchObject({
        verified: true,
        priceType: "listing",
        fetchedAt: expect.any(String),
        sourceHash: expect.any(String),
      });
      expect(source.sourceHash).toHaveLength(64);
    }
    expect(pricing.queries).toEqual(["测试腰带 100级 愤怒 8锻"]);
    expect(pricing.items[0].query).toBe("测试腰带 100级 愤怒 8锻");
    expect(pricing.rawResponse).toBe(JSON.stringify(await search.mock.results[0].value));
    expect(pricing).toMatchObject({ provider: "browser", model: "browser" });
    expect(pricing.usage).toBeUndefined();
    expect(pricing.searchItems).toMatchObject([{ type: "browser_search" }]);
    expect(pricing.requestHash).toHaveLength(64);
    expect(pricing.requestText).toBe(JSON.stringify(search.mock.calls[0][0]));
    expect(search.mock.calls[0][0]).toMatchObject([{ name: equipmentName, description }]);
    expect(pricing.requestText).not.toContain("must-not-send-raw");
    expect(pricing.requestText).not.toContain("must-not-send-login");
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("程序候选没有实际查询记录时，不读取网页、不采纳金额", async () => {
    const search = vi.fn().mockResolvedValue(searchResponse([candidate()], []));
    const read = vi.fn();
    const pricing = await searchEquipmentPrices(
      recordWithEquipment(),
      new AbortController().signal,
      { findCandidates: search, readSource: read },
    );
    expect(pricing.total).toBeNull();
    expect(pricing.items[0].referencePrice).toBeNull();
    expect(pricing.issues.join(" ")).toContain("没有实际查询记录");
    expect(pricing.rawResponse).toContain("100");
    expect(read).not.toHaveBeenCalled();
  });

  it("首次组件失败没有实际查询时，保留诊断和失败计数等待重试且不采纳金额", async () => {
    const read = vi.fn();
    const pricing = await searchEquipmentPrices(
      recordWithEquipment(),
      new AbortController().signal,
      {
        findCandidates: async () => ({
          queries: [],
          items: [
            {
              key: "道具/法宝:0",
              candidates: [candidate()],
              searchState: "read_failed",
              note: "装备测试腰带查询失败（bootstrap）：Timeout；overallSearch=false",
            },
          ],
          searchItems: [{ key: "道具/法宝:0", failure: { stage: "bootstrap" } }],
        }),
        readSource: read,
      },
    );
    expect(pricing.items[0]).toMatchObject({
      searchState: "pending",
      searchFailureCount: 1,
      referencePrice: null,
    });
    expect(pricing.items[0].issues.join(" ")).toContain("bootstrap");
    expect(pricing.searchItems).toMatchObject([{ failure: { stage: "bootstrap" } }]);
    expect(pricing.searchComplete).toBe(false);
    expect(pricing.knownTotal).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });

  it("列表查询成功但详情读取失败仍需续查，恢复后核验真实来源再定价", async () => {
    const record = recordWithEquipment();
    const signal = new AbortController().signal;
    const failed = await searchEquipmentPrices(record, signal, {
      findCandidates: async () => searchResponse([candidate()]),
      readSource: async () => {
        throw new Error("主商品区域未识别");
      },
    });
    expect(failed).toMatchObject({ searchComplete: false, total: null, knownTotal: 0 });
    expect(failed.items[0]).toMatchObject({
      searchState: "pending",
      searchFailureCount: 1,
      referencePrice: null,
    });
    expect(failed.items[0].candidates[0].reason).toBe("主商品区域未识别");
    const find = vi.fn().mockResolvedValue(searchResponse([candidate()]));
    const retried = await searchEquipmentPrices(
      record,
      signal,
      { findCandidates: find, readSource: async () => sourcePage(100) },
      undefined,
      failed,
    );
    expect(find).toHaveBeenCalledOnce();
    expect(retried).toMatchObject({ searchComplete: true, total: 100 });
    expect(retried.items[0]).toMatchObject({ searchState: "completed", referencePrice: 100 });
  });

  it("1条可信挂牌可作参考，重复链接只核对一次；没有匹配仍保留未定价", async () => {
    const duplicate = candidate();
    const search = vi.fn().mockResolvedValue(searchResponse([duplicate, duplicate, duplicate]));
    const read = vi.fn().mockResolvedValue(sourcePage(100));
    const pricing = await searchEquipmentPrices(
      recordWithEquipment(),
      new AbortController().signal,
      { findCandidates: search, readSource: read },
    );
    expect(pricing).toMatchObject({ total: 100, knownTotal: 100 });
    expect(pricing.items[0]).toMatchObject({ status: "priced", referencePrice: 100 });
    expect(pricing.items[0].issues.join(" ")).toContain("仅1条挂牌样本");
    expect(pricing.items[0].candidates).toHaveLength(1);
    expect(read).toHaveBeenCalledOnce();
    search.mockResolvedValueOnce(searchResponse([]));
    const absent = await searchEquipmentPrices(
      recordWithEquipment(),
      new AbortController().signal,
      { findCandidates: search, readSource: read },
    );
    expect(absent.total).toBeNull();
    expect(absent.items[0].referencePrice).toBeNull();
  });

  it("程序查价的分页限制说明在定价后仍保留，不伪造AI搜索或用量", async () => {
    const response = searchResponse([candidate()]);
    response.items[0].note = "只读取前2页，已达到本次检索上限";
    const findCandidates = vi.fn().mockResolvedValue(response);
    const pricing = await searchEquipmentPrices(
      recordWithEquipment(),
      new AbortController().signal,
      {
        findCandidates,
        readSource: vi.fn().mockResolvedValue(sourcePage(100)),
      },
    );
    expect(pricing.items[0]).toMatchObject({ status: "priced", referencePrice: 100 });
    expect(pricing.items[0].issues.join("；")).toContain("前2页");
    expect(pricing.items[0].issues.join("；")).toContain("仅1条");
    expect(pricing.usage).toBeUndefined();
    expect(pricing.rawResponse).not.toContain("web_search");
  });

  it("装备角色及条件按已有attributes补入，不丢失性别限制也不推算属性", () => {
    const record = recordWithEquipment();
    const saved = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items![0];
    saved.attributes = { 装备角色: "女", 装备条件: "等级100" };
    const item = equipmentInventory(record).items[0];
    expect(item.description).toContain("装备角色：女");
    expect(item.description).toContain("装备条件：等级100");
    const compatible = description + "\n装备角色：女\n装备条件：等级100";
    expect(
      verifyEquipmentCandidate(
        item,
        { ...candidate(), quote: quote(100, compatible) },
        sourcePage(100, compatible),
        new Date().toISOString(),
      ).verified,
    ).toBe(true);
    const other = compatible.replace("装备角色：女", "装备角色：男");
    expect(
      verifyEquipmentCandidate(
        item,
        { ...candidate(), quote: quote(100, other) },
        sourcePage(100, other),
        new Date().toISOString(),
      ).verified,
    ).toBe(false);
  });

  it("描述和相同提示框不重复制造灵饰词条", () => {
    const record = recordWithEquipment();
    const saved = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items![0];
    saved.tooltip = description;
    expect(equipmentInventory(record).items[0].description).toBe(description);
  });

  it.each(["专用", "玩家 123 专用", "绑定", "不可交易", "不能交易"])(
    "%s装备跳过且不计价，不查询可交易装备来套价",
    async (restriction) => {
      const record = recordWithEquipment();
      record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items![0].description +=
        "\n" + restriction;
      const findCandidates = vi.fn(),
        readSource = vi.fn();
      const pricing = await searchEquipmentPrices(record, new AbortController().signal, {
        findCandidates,
        readSource,
      });
      expect(pricing.items[0]).toMatchObject({
        status: "untradable",
        searchState: "skipped",
        skipReason: "专用或绑定装备，未计入参考合计",
        referencePrice: null,
      });
      const profile = createProfile(readFileSync(PROMPT_FILE, "utf8"), DEFAULT_SETTINGS, false);
      const report = combineEquipmentPricing(calculateValuation(record, profile), record, pricing);
      const equipmentLine = report.items.find((item) => item.name.startsWith("装备："));
      expect(equipmentLine).toMatchObject({ amount: null, confirmed: false });
      expect(equipmentLine?.formula).toContain("专用或绑定装备，未计入参考合计");
      expect(equipmentLine?.formula).toContain("市场售价未知");
      expect(equipmentLine?.referenceBasis).toBe("excluded");
      expect(report.missing_fields.join(" ")).not.toContain("专用或绑定装备");
      expect(equipmentLine?.formula).not.toMatch(/中位数|0条样本|¥0/);
      expect(pricing.total).toBeNull();
      expect(findCandidates).not.toHaveBeenCalled();
      expect(readSource).not.toHaveBeenCalled();
    },
  );

  it.each(["修理失败：3", "修理失败 3次", "耐久度 300 修理失败 3 次"])(
    "明确%s的装备直接跳过，不发查询且不当0元计价",
    async (repairs) => {
      const record = recordWithEquipment();
      record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items![0].description =
        description.replace("修理失败：0", repairs);
      const findCandidates = vi.fn(),
        readSource = vi.fn();
      const pricing = await searchEquipmentPrices(record, new AbortController().signal, {
        findCandidates,
        readSource,
      });
      expect(pricing.items[0]).toMatchObject({
        status: "unsupported",
        searchState: "skipped",
        referencePrice: null,
        skipReason: expect.stringContaining("修理失败3次"),
      });
      expect(pricing.total).toBeNull();
      expect(pricing.knownTotal).toBe(0);
      expect(findCandidates).not.toHaveBeenCalled();
      expect(readSource).not.toHaveBeenCalled();
      const profile = createProfile(readFileSync(PROMPT_FILE, "utf8"), DEFAULT_SETTINGS, false);
      const report = combineEquipmentPricing(calculateValuation(record, profile), record, pricing);
      const equipmentLine = report.items.find((item) => item.name.startsWith("装备："));
      expect(equipmentLine).toMatchObject({
        amount: null,
        confirmed: false,
        referenceBasis: "excluded",
      });
      expect(equipmentLine?.formula).toContain("修理失败3次");
    },
  );

  it.each([
    "修理失败：0",
    "修理失败1次",
    "修理失败：2",
    "",
    "修理失败：未知",
    "修理失败：3次\n修理失败：0次",
  ])("%s不属于明确修理失败3次，保留正常查价资格", (repairs) => {
    const record = recordWithEquipment();
    record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items![0].description =
      description.replace("修理失败：0", repairs);
    expect(equipmentInventory(record).items[0]).toMatchObject({
      status: "no_match",
      referencePrice: null,
    });
    expect(equipmentInventory(record).items[0].searchState).toBeUndefined();
  });

  it("参考品明确修理失败3次时拒绝，不能拉低正常装备报价", () => {
    const item = equipmentInventory(recordWithEquipment()).items[0];
    const exhausted = description.replace("修理失败：0", "修理失败：3次");
    const result = verifyEquipmentCandidate(
      item,
      { ...candidate(), quote: quote(100, exhausted) },
      sourcePage(100, exhausted),
      new Date().toISOString(),
    );
    expect(result).toMatchObject({
      verified: false,
      reason: expect.stringContaining("修理失败3次"),
    });
  });

  it("官网实际内丹图标保留原说明但不进入人物装备库存或制造漏采", () => {
    const record = recordWithEquipment();
    const raw = itemFromAttributes(
      {
        data_equip_name: "高级召唤兽内丹",
        data_equip_type: "4103",
        data_equip_desc: "所带内丹技能：血债偿#r本方召唤兽被击飞时提升法术伤害",
      },
      1,
    );
    record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items!.push(raw);
    const inventory = equipmentInventory(record);
    expect(inventory.captureComplete).toBe(true);
    expect(inventory.issues).toEqual([]);
    expect(inventory.items.map((item) => item.name)).toEqual([equipmentName]);
    expect(raw.description).toContain("血债偿");
  });

  it("程序未给单件实际筛选条件时留空，不把建议关键词冒充实际查询", async () => {
    const response = searchResponse([candidate()]);
    response.items[0].query = "";
    const pricing = await searchEquipmentPrices(
      recordWithEquipment(),
      new AbortController().signal,
      {
        findCandidates: vi.fn().mockResolvedValue(response),
        readSource: vi.fn().mockResolvedValue(sourcePage(100)),
      },
    );
    expect(pricing.items[0].query).toBe("");
    expect(pricing.queries).toEqual(response.queries);
  });

  it("字段顺序与格式变化不阻断同配置装备的实际来源核验", () => {
    const item = equipmentInventory(recordWithEquipment()).items[0];
    const rearranged = "敏捷：0";
    const sourceDescription =
      "宝石 黑宝石 锻炼等级8\n修理失败0次\n等级100级 防御+50\n耐久度250\n【特效】愤怒";
    const result = verifyEquipmentCandidate(
      item,
      { ...candidate(), quote: quote(100, sourceDescription) },
      sourcePage(100, sourceDescription),
      new Date().toISOString(),
    );
    expect(result.verified).toBe(true);
    expect(
      verifyEquipmentCandidate(
        item,
        { ...candidate(), quote: quote(100, sourceDescription + "\n" + rearranged) },
        sourcePage(100, sourceDescription + "\n" + rearranged),
        new Date().toISOString(),
      ).verified,
    ).toBe(false);
  });

  it("同一官方商品的不同跟踪参数不能凑成3条独立报价", async () => {
    const candidates = ["a", "b", "c"].map((tracking) =>
      candidate(100, "https://xyq.cbg.163.com/equip/1/same-product?utm_source=" + tracking),
    );
    const search = vi.fn().mockResolvedValue(searchResponse(candidates));
    const read = vi.fn().mockResolvedValue(sourcePage(100));
    const pricing = await searchEquipmentPrices(
      recordWithEquipment(),
      new AbortController().signal,
      { findCandidates: search, readSource: read },
    );
    expect(pricing.total).toBe(100);
    expect(pricing.items[0].referencePrice).toBe(100);
    expect(pricing.items[0].candidates).toHaveLength(1);
    expect(read).toHaveBeenCalledOnce();
  });

  it("同eid和区服的s/serverid/server_id别名只保留一个真实样本", async () => {
    const candidates = ["s", "serverid", "server_id"].map((parameter) =>
      candidate(
        100,
        "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=buy_show_equip_info&eid=fixture-eid&" +
          parameter +
          "=1",
      ),
    );
    const search = vi.fn().mockResolvedValue(searchResponse(candidates));
    const read = vi.fn().mockResolvedValue(sourcePage(100));
    const pricing = await searchEquipmentPrices(
      recordWithEquipment(),
      new AbortController().signal,
      { findCandidates: search, readSource: read },
    );
    expect(pricing.total).toBe(100);
    expect(pricing.items[0].candidates).toHaveLength(1);
    expect(read).toHaveBeenCalledOnce();
  });

  it.each([
    "http://xyq.cbg.163.com/equip/1/fixture-100",
    "https://xyq.cbg.163.com.evil.invalid/equip/1/fixture-100",
    "https://127.0.0.1/equip/1/fixture-100",
    "https://user:password@xyq.cbg.163.com/equip/1/fixture-100",
    "https://xyq.cbg.163.com:8443/equip/1/fixture-100",
    "https://xyq.cbg.163.com/equip/",
  ])("不安全或非具体商品链接不进入网页读取：%s", async (url) => {
    expect(() => safeEquipmentUrl(url)).toThrow();
    const search = vi.fn().mockResolvedValue(searchResponse([candidate(100, url)]));
    const read = vi.fn();
    const pricing = await searchEquipmentPrices(
      recordWithEquipment(),
      new AbortController().signal,
      { findCandidates: search, readSource: read },
    );
    expect(pricing.total).toBeNull();
    expect(pricing.items[0].candidates[0].verified).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "伪造引文",
      source: sourcePage(100),
      changed: { quote: "网上大约能卖100元" },
      reason: "引用",
    },
    {
      label: "等级不匹配",
      source: sourcePage(100, description.replace("100", "110")),
      changed: {},
      reason: "等级",
    },
    {
      label: "特效不匹配",
      source: sourcePage(100, description.replace("愤怒", "暴怒")),
      changed: {},
      reason: "关键属性",
    },
    {
      label: "更高属性数字前缀相同",
      source: sourcePage(100, description.replace("防御：50", "防御：500")),
      changed: { quote: quote(100, description.replace("防御：50", "防御：500")) },
      reason: "高于目标",
    },
    {
      label: "整号总价",
      source: "<p>角色等级：109</p>" + sourcePage(100),
      changed: {},
      reason: "角色总价",
    },
    {
      label: "实际价格不同",
      source: sourcePage(120),
      changed: { quote: quote(120) },
      reason: "价格",
    },
    {
      label: "已售出",
      source: sourcePage(100, description, "商品已售出"),
      changed: {},
      reason: "已下架",
    },
    {
      label: "不确定报价性质",
      source: sourcePage(100),
      changed: { priceType: "unknown" as const },
      reason: "挂牌",
    },
    {
      label: "没有在售状态",
      source: sourcePage(100, description, "历史记录"),
      changed: {},
      reason: "在售状态",
    },
  ])("拒绝 $label 来源，不能把价格自动加到估值", ({ source, changed, reason }) => {
    const item = equipmentInventory(recordWithEquipment()).items[0];
    const result = verifyEquipmentCandidate(
      item,
      { ...candidate(), ...changed },
      source,
      new Date().toISOString(),
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toContain(reason);
  });

  it("正常耐久差异不推测折扣，破损装备只采用同状态独立报价", () => {
    const record = recordWithEquipment();
    const item = equipmentInventory(record).items[0];
    const sourceDescription = description.replace("耐久：300", "耐久：250");
    const result = verifyEquipmentCandidate(
      item,
      { ...candidate(), quote: quote(100, sourceDescription) },
      sourcePage(100, sourceDescription),
      new Date().toISOString(),
    );
    expect(result.verified).toBe(true);
    expect(result.price).toBe(100);
    expect(result.differences?.join(" ")).toContain("当前300，报价250");
    expect(result.differences?.join(" ")).toContain("未推测折扣");
    for (const broken of [
      description.replace("耐久：300", "耐久：0"),
      description + "\n无法修复",
    ]) {
      record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items![0].description = broken;
      const brokenItem = equipmentInventory(record).items[0];
      expect(brokenItem).toMatchObject({ status: "no_match", referencePrice: null });
      expect(
        verifyEquipmentCandidate(brokenItem, candidate(), sourcePage(100), new Date().toISOString())
          .verified,
      ).toBe(false);
      expect(
        verifyEquipmentCandidate(
          brokenItem,
          { ...candidate(), quote: quote(100, broken) },
          sourcePage(100, broken),
          new Date().toISOString(),
        ).verified,
      ).toBe(true);
    }
  });

  it("引用必须同时包含价格，不能用只有属性的引文证明价格", () => {
    const item = equipmentInventory(recordWithEquipment()).items[0];
    const result = verifyEquipmentCandidate(
      item,
      { ...candidate(), quote: equipmentName + "\n" + description },
      sourcePage(100),
      new Date().toISOString(),
    );
    expect(result.verified).toBe(false);
  });

  it.each(["特技：罗汉金钟", "法术暴击等级：10", "封印命中等级：10"])(
    "报价额外多出%s时不能套用到当前装备",
    (extra) => {
      const item = equipmentInventory(recordWithEquipment()).items[0];
      const extraDescription = description + "\n" + extra;
      const result = verifyEquipmentCandidate(
        item,
        { ...candidate(), quote: quote(100, extraDescription) },
        sourcePage(100, extraDescription),
        new Date().toISOString(),
      );
      expect(result.verified).toBe(false);
      expect(result.reason).toMatch(/多出|缺失/);
    },
  );

  it("目标没有对应双加基础值时不采用，0耐久修理次数也不放宽", () => {
    const item = { ...equipmentInventory(recordWithEquipment()).items[0], modelId: "2912" };
    const desc = description + "\n力量：20";
    const verified = verifyEquipmentCandidate(
      item,
      { ...candidate(), quote: quote(100, desc) },
      '<main data-cbg-model-id="2912">' + sourcePage(100, desc) + "</main>",
      new Date().toISOString(),
    );
    expect(verified).toMatchObject({ verified: false, price: 100 });
    expect(verified.reason).toContain("力量");
    const broken = description.replace("耐久：300", "耐久：0");
    const changed = broken.replace("修理失败：0", "修理失败：2");
    const rejected = verifyEquipmentCandidate(
      { ...item, description: broken },
      { ...candidate(), quote: quote(100, changed) },
      '<main data-cbg-model-id="2912">' + sourcePage(100, changed) + "</main>",
      new Date().toISOString(),
    );
    expect(rejected).toMatchObject({ verified: false });
    expect(rejected.reason).toContain("修理失败次数不一致");
  });

  it.each(["<table><tr><td>特效</td><td>愤怒</td></tr></table>", "<p>【特效】愤怒</p>"])(
    "额外特效没有冒号但由表格或括号分隔，也不能漏检：%s",
    (markup) => {
      const record = recordWithEquipment();
      const normal = description.replace("特效：愤怒\n", "");
      record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items![0].description = normal;
      const item = equipmentInventory(record).items[0];
      const html =
        "<main><p>在售</p><h1>" +
        equipmentName +
        "</h1><pre>" +
        normal +
        "</pre>" +
        markup +
        "<div>挂牌价：¥100</div></main>";
      const extraText = markup.includes("【") ? "【特效】愤怒" : "特效 愤怒";
      const quotedCandidate = { ...candidate(100), quote: quote(100, normal + "\n" + extraText) };
      const result = verifyEquipmentCandidate(
        item,
        quotedCandidate,
        html,
        new Date().toISOString(),
      );
      expect(result.verified).toBe(false);
      expect(result.reason).toMatch(/多出|缺失/);
    },
  );

  it("主商品1000元与推荐区100元不能串用，即使推荐引文含同样属性", () => {
    const item = equipmentInventory(recordWithEquipment()).items[0];
    const html = "<main>" + sourcePage(1000) + "</main><aside>" + sourcePage(100) + "</aside>";
    const result = verifyEquipmentCandidate(item, candidate(100), html, new Date().toISOString());
    expect(result.verified).toBe(false);
    const correct = verifyEquipmentCandidate(item, candidate(1000), html, new Date().toISOString());
    expect(correct.verified).toBe(true);
    expect(correct.price).toBe(1000);
  });

  it("无可辨认的主商品区域且整页出现多个价格时拒绝自动采价", () => {
    const item = equipmentInventory(recordWithEquipment()).items[0];
    const html = sourcePage(1000) + '<div class="recommendations">' + sourcePage(100) + "</div>";
    const result = verifyEquipmentCandidate(item, candidate(100), html, new Date().toISOString());
    expect(result.verified).toBe(false);
  });

  it("网页核对阶段中止会停止本次查价，不保留为已完成快照", async () => {
    const controller = new AbortController();
    const search = vi
      .fn()
      .mockResolvedValue(
        searchResponse([
          candidate(100, "https://xyq.cbg.163.com/equip/1/fixture-1"),
          candidate(200, "https://xyq.cbg.163.com/equip/1/fixture-2"),
        ]),
      );
    const read = vi.fn(async () => {
      controller.abort(new Error("fixture canceled"));
      throw controller.signal.reason;
    });
    await expect(
      searchEquipmentPrices(recordWithEquipment(), controller.signal, {
        findCandidates: search,
        readSource: read,
      }),
    ).rejects.toThrow("fixture canceled");
    expect(read).toHaveBeenCalledOnce();
  });

  it("同配偶数报价取最低价，查价金额与快照复算一致", async () => {
    const record = recordWithEquipment();
    const prices = [1050.01, 1050.02];
    const candidates = prices.map((price, index) =>
      candidate(price, "https://xyq.cbg.163.com/equip/1/half-cent-" + index),
    );
    const sourcePages = new Map(candidates.map((item) => [item.url, sourcePage(item.price!)]));
    const pricing = await searchEquipmentPrices(record, new AbortController().signal, {
      findCandidates: async () => searchResponse(candidates),
      readSource: async (url) => sourcePages.get(url)!,
    });
    expect(pricing.items[0]).toMatchObject({ status: "priced", referencePrice: 1050.01 });
    expect(pricing).toMatchObject({ total: 1050.01, knownTotal: 1050.01 });
    const profile = createProfile(readFileSync(PROMPT_FILE, "utf8"), DEFAULT_SETTINGS, false);
    const combined = combineEquipmentPricing(calculateValuation(record, profile), record, pricing);
    expect(combined.equipment_value).toBe(1050.01);
    expect(combined.missing_fields.join(" ")).not.toContain("快照与样本金额不一致");
  });

  it("完整装备价格只加一次，裸号中已有的现金不重复计算", async () => {
    const record = recordWithEquipment();
    record.listing.summary = { iCash: 3000000, iSaving: 0, xianyu: 0 };
    const profile = createProfile(
      readFileSync(PROMPT_FILE, "utf8"),
      {
        ...DEFAULT_SETTINGS,
        servers: [
          {
            serverId: record.listing.serverId,
            age: "older",
            rank: 70,
            goldPrice: 210,
            goldUnit: 30000000,
            baselineUnitConfirmed: true,
          },
        ],
      },
      false,
    );
    const bare = calculateValuation(record, profile);
    expect(bare.model_value).not.toBeNull();
    expect(bare.items.find((item) => item.name === "现金")?.amount).toBe(19.95);
    const { pricing } = await matchedPricing(record);
    const combined = combineEquipmentPricing(bare, record, pricing);
    expect(combined.model_value).toBe(bare.model_value! + 100);
    expect(combined.bare_role_value).toBe(bare.model_value);
    expect(combined.equipment_value).toBe(100);
    expect(combined.price_difference).toBe(combined.model_value! - bare.asking_price!);
    expect(combined.extra_cost).toBeNull();
    expect(combined.total_cost).toBeNull();
    record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items![0].description =
      description.replace("50", "55");
    const mismatched = combineEquipmentPricing(bare, record, pricing);
    expect(mismatched.model_value).toBeNull();
    expect(mismatched.equipment_value).toBeNull();
  });

  it("超过24小时的查价快照不能继续生成完整差额，并明确需要刷新", async () => {
    const record = recordWithEquipment();
    const { pricing } = await matchedPricing(record);
    pricing.searchedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const profile = createProfile(
      readFileSync(PROMPT_FILE, "utf8"),
      {
        ...DEFAULT_SETTINGS,
        servers: [{ serverId: record.listing.serverId, age: "three", rank: 10 }],
      },
      false,
    );
    const combined = combineEquipmentPricing(calculateValuation(record, profile), record, pricing);
    expect(combined.model_value).toBeNull();
    expect(combined.price_difference).toBeNull();
    expect(combined.missing_fields.join(" ")).toMatch(/过期|24小时/);
  });

  it("装备有报价也不能把不适用的裸号规则改成有效差价", async () => {
    const record = recordWithEquipment();
    record.listing.serverName = "时光-花样年华";
    const profile = createProfile(
      readFileSync(PROMPT_FILE, "utf8"),
      {
        ...DEFAULT_SETTINGS,
        servers: [{ serverId: record.listing.serverId, age: "three", rank: 10 }],
      },
      false,
    );
    const bare = calculateValuation(record, profile);
    expect(bare.decision).toBe("OUT_OF_SCOPE");
    const { pricing } = await matchedPricing(record);
    const combined = combineEquipmentPricing(bare, record, pricing);
    expect(combined.decision).toBe("OUT_OF_SCOPE");
    expect(combined.model_value).toBeNull();
    expect(combined.price_difference).toBeNull();
  });
});

describe("完整装备独立查价与符石限制来源", () => {
  it("一件装备只采到等级时不阻止其他完整装备查价，未知件及总价仍待补", async () => {
    const record = recordWithEquipment();
    record.detail!.tabs.at(-1)!.items!.push({
      index: 1,
      kind: "equipment",
      name: "鬼牙攫魂",
      category: "人物装备 · 饰品",
      description: "等级70",
    });
    record.detail!.equipmentCapture = {
      version: 1,
      collectedAt: record.detail!.collectedAt,
      complete: false,
      issues: ["道具/法宝：鬼牙攫魂 的装备属性未完整读取"],
    };
    const search = vi.fn().mockResolvedValue(searchResponse([candidate(100)]));
    const snapshot = await searchEquipmentPrices(record, new AbortController().signal, {
      findCandidates: search,
      readSource: async () => sourcePage(100),
    });
    expect(search.mock.calls[0][0].map((item: { name: string }) => item.name)).toEqual([
      equipmentName,
    ]);
    expect(snapshot).toMatchObject({ captureComplete: false, total: null, knownTotal: 100 });
    expect(snapshot.items[1]).toMatchObject({
      name: "鬼牙攫魂",
      status: "incomplete",
      referencePrice: null,
      candidates: [],
    });
  });
  it("疾风之铃已观察到的符石门派及部位条件不重复拼成装备硬限制", () => {
    const record = recordWithEquipment();
    const equipped = record.detail!.tabs.at(-1)!.items![0];
    equipped.name = "疾风之铃";
    equipped.description =
      "等级80\n灵力180\n耐久37\n锻炼等级8 镶嵌宝石 舍利子\n符石组合: 万灵诸念符石\n门派条件：神木林\n部位条件：项链\n熔炼效果：\n+2灵力\n装备条件：等级80";
    equipped.attributes = { 门派条件: "神木林", 部位条件: "项链", 装备条件: "等级80" };
    const inventory = equipmentInventory(record);
    expect(inventory.items[0].description.match(/门派条件/g)).toHaveLength(1);
    expect(inventory.items[0].description.match(/部位条件/g)).toHaveLength(1);
    const quotedDescription =
      "等级80\n灵力180\n耐久37\n锻炼等级8 镶嵌宝石 舍利子\n符石组合: 其他符石\n门派条件：无\n部位条件：无\n装备条件：等级80";
    const text = "疾风之铃\n" + quotedDescription + "\n在售\n挂牌价：¥300";
    const candidate = {
      url: "https://xyq.cbg.163.com/equip?s=1&eid=rune-diff",
      title: "疾风之铃",
      price: 300,
      priceType: "listing" as const,
      quote: text,
      verified: false,
      reason: "",
      fetchedAt: null,
      sourceHash: null,
    };
    const html = '<main data-cbg-model-id="2815">' + text + "</main>";
    inventory.items[0].modelId = "2815";
    const verified = verifyEquipmentCandidate(
      inventory.items[0],
      candidate,
      html,
      new Date().toISOString(),
    );
    expect(verified).toMatchObject({ verified: true, matchType: "similar" });
    expect(verified.differences?.some((difference) => difference.startsWith("符石组合："))).toBe(
      true,
    );
    expect(
      verifyEquipmentCandidate(
        inventory.items[0],
        { ...candidate, quote: text + "\n玩家1专用" },
        html + "\n玩家1专用",
        new Date().toISOString(),
      ).verified,
    ).toBe(false);
  });
});

it("前件耗尽预算时后件已有游标和两条样本原样保留，不重复核验未处理件", async () => {
  const record = recordWithEquipment();
  record.detail!.tabs.at(-1)!.items![0].modelId = "2912";
  record.detail!.tabs.at(-1)!.items!.push({ ...record.detail!.tabs.at(-1)!.items![0], index: 1 });
  const cursor = {
    version: 1 as const,
    planHash: "saved",
    modeIndex: 1,
    pageNumber: 4,
    rowIndex: 5,
    pageRowsHash: "rows",
    seen: ["1:previous"],
    failed: [],
  };
  const desc = description.replace("防御：50", "防御：49");
  const first = await searchEquipmentPrices(record, new AbortController().signal, {
    findCandidates: async () => ({
      queries: ["first"],
      items: [
        { key: "道具/法宝:0", candidates: [], searchState: "pending", searchCursor: cursor },
        {
          key: "道具/法宝:1",
          candidates: [100, 120].map((price, index) => ({
            ...candidate(price, "https://xyq.cbg.163.com/equip/1/old-" + index),
            quote: quote(price, desc),
          })),
          searchState: "pending",
          searchCursor: cursor,
        },
      ],
    }),
    readSource: async (url) =>
      '<main data-cbg-model-id="2912">' +
      sourcePage(url.endsWith("0") ? 100 : 120, desc) +
      "</main>",
  });
  expect(first.items[1].candidates.every((candidate) => candidate.verified)).toBe(true);
  const read = vi.fn();
  const second = await searchEquipmentPrices(
    record,
    new AbortController().signal,
    {
      findCandidates: async () => ({
        queries: ["next"],
        items: [
          {
            key: "道具/法宝:0",
            candidates: [],
            searchState: "pending",
            searchCursor: { ...cursor, rowIndex: 6 },
          },
          { key: "道具/法宝:1", candidates: [], searchState: "pending", skipped: true },
        ],
      }),
      readSource: read,
    },
    undefined,
    first,
  );
  expect(second.items[1].searchCursor).toEqual(first.items[1].searchCursor);
  expect(second.items[1].candidates).toEqual(first.items[1].candidates);
  expect(second.items[1].similarEstimate).toEqual(first.items[1].similarEstimate);
  expect(second.items[1].query).toBe(first.items[1].query);
  expect(second.items[1].candidates).toHaveLength(2);
  expect(read).not.toHaveBeenCalled();
  expect(second.searchComplete).toBe(false);
});

describe("核心初始值缺失的装备排除", () => {
  const unidentifiedRecord = () => {
    const record = recordWithEquipment();
    record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items = [
      {
        index: 5,
        name: "水晶棒",
        kind: "equipment",
        modelId: "1808",
        location: "store_equip_tips4",
        description: "等级 70\n未鉴定物品",
        attributes: { 装备条件: "等级70", 装备角色: "玄彩娥，骨精灵，影精灵" },
      },
    ];
    return record;
  };

  it("真实未鉴定装备缺category仍进入库存，跳过后完成参考报价而非只给小计", async () => {
    const record = unidentifiedRecord();
    const inventory = equipmentInventory(record);
    expect(inventory.captureComplete).toBe(true);
    expect(inventory.issues).toEqual([]);
    expect(inventory.items).toHaveLength(1);
    expect(inventory.items[0]).toMatchObject({
      key: "道具/法宝:5",
      name: "水晶棒",
      referencePrice: null,
      searchState: "skipped",
    });
    expect(inventory.items[0].skipReason).toMatch(/未鉴定.*初始.*未知/);
    expect(inventory.items[0].kindId).toBeUndefined();
    expect(inventory.items[0].category).toBe("人物装备");
    expect(inventory.items[0].baselineEstimate).toBeUndefined();
    const findCandidates = vi.fn(),
      readSource = vi.fn();
    const profile = createProfile(
      readFileSync(PROMPT_FILE, "utf8"),
      {
        ...DEFAULT_SETTINGS,
        servers: [
          {
            serverId: "1",
            age: "three",
            rank: 13,
            goldPrice: 218.29,
            goldUnit: 30000000,
            baselineUnitConfirmed: true,
          },
        ],
      },
      true,
    );
    const pricing = await searchEquipmentPrices(
      record,
      new AbortController().signal,
      { findCandidates, readSource },
      profile.settings,
    );
    expect(pricing.captureComplete).toBe(true);
    expect(pricing.searchComplete).toBe(true);
    expect(pricing.items[0].referencePrice).toBeNull();
    expect(findCandidates).not.toHaveBeenCalled();
    expect(readSource).not.toHaveBeenCalled();
    record.detail!.petCapture = {
      version: 1,
      collectedAt: record.detail!.collectedAt,
      complete: true,
      issues: [],
    };
    record.detail!.tabs.push({
      name: "召唤兽/孩子",
      text: "召唤兽(0/10)",
      fields: [],
      tables: [],
      elements: [],
      tooltips: [],
      petCount: 0,
      pets: [],
    });
    const pets = await searchPetPricing(record, new AbortController().signal, {
      findCandidates,
      readSource,
    });
    const bare = calculateValuation(record, profile);
    expect(bare.model_value).not.toBeNull();
    const result = applyValuationRange(
      combinePetPricing(
        combineEquipmentPricing(bare, record, pricing, profile.settings),
        record,
        pets,
      ),
      bare,
      record,
      profile,
    );
    expect(result.estimate_missing_count).toBe(0);
    expect(result.estimated_value).toBe(bare.model_value);
    expect(result.excluded_assets).toContainEqual({
      key: "道具/法宝:5",
      name: "水晶棒",
      reason: inventory.items[0].skipReason,
    });
    expect(result.items.find((item) => item.name.includes("道具/法宝:5"))?.amount).toBeNull();
    expect(result.missing_fields.join(" ")).not.toMatch(/水晶棒|分类未识别|装备.*未采齐/);
    expect(findCandidates).not.toHaveBeenCalled();
    expect(readSource).not.toHaveBeenCalled();
  });

  it.each(["等级70", "未鉴定物品", "等级70\n未鉴定物品说明"])(
    "未识别分类但缺少完整精确状态时仍不完整：%s",
    (description) => {
      const record = unidentifiedRecord();
      const target = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items![0];
      target.description = description;
      if (description === "未鉴定物品") delete target.attributes;
      expect(equipmentInventory(record).captureComplete).toBe(false);
    },
  );

  it.each([
    { category: "召唤兽装备" },
    { category: "道具 · 任务物品" },
    { category: "材料 · 精魄灵石" },
    { modelId: "4036" },
    { modelId: "611" },
    { attributes: { 装备对象: "召唤兽" } },
  ])("未鉴定状态不改变宠装和道具材料排除：%j", (override) => {
    const record = unidentifiedRecord();
    Object.assign(record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items![0], override);
    expect(equipmentInventory(record).items).toEqual([]);
  });

  it.each([
    ["武器", "伤害581\n命中750\n锻炼等级10\n宝石：太阳石 红玛瑙\n气血0", "伤害"],
    ["腰带", "气血348\n防御34\n锻炼等级8\n宝石：光芒石 黑宝石", "气血"],
    ["鞋子", "防御40", "敏捷"],
    ["项链", "灵力180\n宝石：舍利子", "灵力"],
    ["头盔", "防御100\n宝石：月亮石", "防御"],
    ["衣服", "防御100\n宝石：月亮石", "防御"],
  ])("%s 的核心%s无法还原时跳过", (category, description, field) => {
    expect(equipmentCoreSkipReason({ category, description, kindId: undefined })).toContain(
      "初始" + field,
    );
  });
  it.each(["双环", "魔棒", "伞", "棍"])("官网武器类型%s同样要求初伤", (category) => {
    expect(equipmentCoreSkipReason({ category, description: "防御0" })).toContain("初始伤害");
  });
  it("衣服只要求核心初防，非核心气血未知不阻止查询", () => {
    expect(
      equipmentCoreSkipReason({
        category: "衣服",
        description: "防御168\n气血348\n锻炼等级8\n宝石：光芒石 黑宝石",
      }),
    ).toBeNull();
    expect(equipmentCoreSkipReason({ category: "人物装备", description: "防御50" })).toBeNull();
    expect(equipmentCoreSkipReason({ category: "灵饰 戒指", description: "防御50" })).toBeNull();
  });
  it("已知腰带核心值缺失时不调用来源且不按默认价补价", async () => {
    const record = recordWithEquipment();
    const target = record.detail!.tabs.find((t) => t.name === "道具/法宝")!.items![0];
    target.category = "人物装备 · 腰带";
    target.description = "等级100\n气血348\n防御34\n锻炼等级8\n宝石：光芒石 黑宝石";
    const findCandidates = vi.fn();
    const pricing = await searchEquipmentPrices(
      record,
      new AbortController().signal,
      { findCandidates, readSource: vi.fn() },
      DEFAULT_SETTINGS,
    );
    expect(findCandidates).not.toHaveBeenCalled();
    expect(pricing.searchComplete).toBe(true);
    expect(pricing.items[0]).toMatchObject({
      searchState: "skipped",
      referencePrice: null,
      candidates: [],
      skipReason: expect.stringContaining("初始气血"),
    });
    expect(pricing.items[0].baselineEstimate).toBeUndefined();
    expect(pricing.knownTotal).toBe(0);
  });
  it.each([{ queries: [] }, { queries: ["另一件的真实查询"] }])(
    "官网确定部位后返回规则跳过，空查询也能完成 %j",
    async ({ queries }) => {
      const findCandidates = vi.fn().mockResolvedValue({
        queries,
        items: [
          {
            key: "道具/法宝:0",
            candidates: [candidate(999)],
            searchState: "skipped",
            skipReason: "核心初始伤害无法可靠还原，未计入参考合计；市场售价未知",
          },
        ],
      });
      const readSource = vi.fn();
      const pricing = await searchEquipmentPrices(
        recordWithEquipment(),
        new AbortController().signal,
        { findCandidates, readSource },
      );
      expect(pricing.searchComplete).toBe(true);
      expect(pricing.items[0]).toMatchObject({
        searchState: "skipped",
        referencePrice: null,
        candidates: [],
        skipReason: expect.stringContaining("初始伤害"),
      });
      expect(readSource).not.toHaveBeenCalled();
    },
  );
});
