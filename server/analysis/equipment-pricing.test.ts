import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vite-plus/test";
import { valuationRecord } from "../../tests/fixtures/analysis";
import type { SavedRoleRecord } from "../crawler/types";
import {
  combineEquipmentPricing,
  equipmentInventory,
  safeEquipmentUrl,
  searchEquipmentPrices,
  verifyEquipmentCandidate,
  type EquipmentCandidate,
} from "./equipment-pricing";
import { createProfile, DEFAULT_SETTINGS, PROMPT_FILE } from "./profile";
import { calculateValuation } from "./valuation-calculator";

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
  record.detail!.equipmentCapture = {
    version: 1,
    collectedAt: record.detail!.collectedAt,
    complete: true,
    issues: [],
  };
  record.detail!.tabs.push({
    name: "道具/法宝",
    text: "",
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
    expect(pricing.total).toBe(200);
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
      expect(pricing).toMatchObject({ captureComplete: false, total: null });
      expect(search).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    }
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

  it("3条独立可信挂牌取中位数，保留程序查询、结构化候选及逐条网页证据", async () => {
    const record = recordWithEquipment();
    record.detail!.raw = { privateContent: "must-not-send-raw" };
    record.listing.attrs = { login: "must-not-send-login" };
    const { pricing, search, read } = await matchedPricing(record);
    expect(pricing).toMatchObject({ captureComplete: true, total: 200, knownTotal: 200 });
    expect(pricing.items[0]).toMatchObject({ status: "priced", referencePrice: 200 });
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
    "%s装备保留未定价，不查询可交易装备来套价",
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
      expect(pricing.items[0]).toMatchObject({ status: "untradable", referencePrice: null });
      expect(pricing.total).toBeNull();
      expect(findCandidates).not.toHaveBeenCalled();
      expect(readSource).not.toHaveBeenCalled();
    },
  );

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
          "=132",
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
      reason: "关键属性",
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

  it("正常可修装备耐久不同可展示差异，不推测折扣；0耐久或无法修复不套报价", async () => {
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
      const search = vi.fn(),
        read = vi.fn();
      const pricing = await searchEquipmentPrices(record, new AbortController().signal, {
        findCandidates: search,
        readSource: read,
      });
      expect(pricing.total).toBeNull();
      expect(pricing.items[0]).toMatchObject({ status: "incomplete", referencePrice: null });
      expect(search).not.toHaveBeenCalled();
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

  it.each(["特技：罗汉金钟", "力量：20", "法术暴击等级：10", "封印命中等级：10"])(
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
      expect(result.reason).toContain("多出");
    },
  );

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
      expect(result.reason).toContain("多出");
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
    expect(combined.model_value).toBe(bare.model_value! + 200);
    expect(combined.bare_role_value).toBe(bare.model_value);
    expect(combined.equipment_value).toBe(200);
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
