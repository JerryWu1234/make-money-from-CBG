import type { SavedRoleRecord } from "../../server/crawler/types";
import type { Dimension, ProductAnalysis } from "../../server/analysis/types";
import { buildProductDocument } from "../../server/analysis/product-document";
import { roleRecord } from "./saved-role";
import type { EquipmentPricingSnapshot } from "../../server/analysis/equipment-pricing";
import type { PetPricingSnapshot } from "../../server/analysis/pet-pricing";
import { CAPTURE_VERSION } from "../../server/crawler/compact";

/** Synthetic evidence for UI tests. No browser or search request is sent to this URL. */
export function equipmentPricingFixture(incomplete = false): EquipmentPricingSnapshot {
  const quote = "【模拟测试样本】测试铠甲，120级，防御200，耐久300/500可正常修理，挂牌价300元。";
  return {
    version: 1,
    inputHash: "fixture-input-hash",
    searchedAt: "2026-10-03T07:00:00.000Z",
    provider: "codex",
    model: "fixture-model",
    queries: ["梦幻西游 测试铠甲 120级 防御200 挂牌价格"],
    rawResponse: "模拟联网查价结果，仅验证页面，不代表真实市场行情。",
    captureComplete: !incomplete,
    total: incomplete ? null : 300,
    knownTotal: 300,
    items: [
      {
        key: "armor-fixture",
        name: "测试铠甲",
        level: 120,
        category: "装备",
        description: "防御200",
        query: "梦幻西游 测试铠甲 120级 防御200 挂牌价格",
        status: "priced",
        referencePrice: 300,
        candidates: [
          {
            url: "https://xyq.cbg.163.com/equip?s=367&eid=mock-price-ui",
            title: "模拟测试装备挂牌样本",
            price: 300,
            priceType: "listing",
            quote,
            verified: true,
            reason: "模拟样本的装备类型、等级和属性匹配，用于页面验证。",
            differences: ["耐久300/500，可正常修理。"],
            fetchedAt: "2026-10-03T07:01:00.000Z",
            sourceHash: "fixture-page-hash",
          },
          {
            url: "https://xyq.cbg.163.com/equip?s=367&eid=mock-rejected-ui",
            title: "未匹配的模拟样本",
            price: 999,
            priceType: "listing",
            quote: "【模拟测试样本】等级不同，不能采用。",
            verified: false,
            reason: "装备等级不同，不计入参考价。",
            fetchedAt: "2026-10-03T07:02:00.000Z",
            sourceHash: "fixture-unmatched-page-hash",
          },
        ],
        issues: [],
      },
      ...(incomplete
        ? [
            {
              key: "missing-fixture",
              name: "待补采武器",
              level: null,
              category: "装备",
              description: "属性未读取完整",
              query: "",
              status: "incomplete" as const,
              referencePrice: null,
              candidates: [],
              issues: ["未采到武器伤害属性，不能匹配报价。"],
            },
            {
              key: "no-match-fixture",
              name: "测试头盔",
              level: 120,
              category: "装备",
              description: "防御80",
              query: "梦幻西游 测试头盔 120级 防御80 挂牌价格",
              status: "no_match" as const,
              referencePrice: null,
              candidates: [],
              issues: ["已搜索，但没有找到属性匹配且有明确挂牌价的网页。"],
            },
          ]
        : []),
    ],
    issues: incomplete ? ["装备属性尚未完整，300元只是已核实小计。"] : [],
  };
}

export function analysisRecord(key = "a"): SavedRoleRecord {
  const record = roleRecord(key, true);
  return {
    ...record,
    status: "complete",
    listing: {
      ...record.listing,
      ordersn: `test-${key}`,
      createdTime: null,
      orderTime: null,
      attrs: {},
    },
    detail: {
      ...record.detail!,
      url: record.listing.url,
      formatVersion: 3,
      captureVersion: CAPTURE_VERSION,
      equipmentCapture: {
        version: 1,
        collectedAt: record.detail!.collectedAt,
        complete: true,
        issues: [],
      },
      petCapture: {
        version: 1,
        collectedAt: record.detail!.collectedAt,
        complete: true,
        issues: [],
      },
    },
  } as SavedRoleRecord;
}
/** Synthetic pet quote, kept separate from real search evidence. */
export function petPricingFixture(): PetPricingSnapshot {
  const base = equipmentPricingFixture();
  const quote =
    "【模拟测试宝宝样本】画魂，119级，成长1.25，技能高级魔之心、须弥真言，无内丹，无装备，挂牌价800元。";
  return {
    ...base,
    inputHash: "fixture-pet-hash",
    total: 800,
    knownTotal: 800,
    queries: ["梦幻西游电脑版 藏宝阁 全服 画魂 须弥真言 成长1.25"],
    items: [
      {
        ...base.items[0],
        key: "pet-fixture",
        name: "测试画魂",
        level: 119,
        category: "召唤兽（含已核对随身装备）",
        description: "成长1.25，技能高级魔之心、须弥真言，无内丹，无装备",
        query: "梦幻西游电脑版 藏宝阁 全服 画魂 须弥真言 成长1.25",
        referencePrice: 800,
        fields: [{ name: "类型", value: "画魂" }],
        skills: ["高级魔之心", "须弥真言"],
        innerSkills: [],
        equipment: [],
        candidates: [
          {
            ...base.items[0].candidates[0],
            url: "https://xyq.cbg.163.com/equip?s=367&eid=mock-pet-ui",
            title: "模拟测试宝宝挂牌样本",
            price: 800,
            quote,
            differences: [],
          },
        ],
      },
    ],
  };
}
export function valuationRecord(key = "a"): SavedRoleRecord {
  const record = analysisRecord(key);
  record.listing.price = "500.00";
  record.listing.summary = { iCash: 0, iSaving: 0, xianyu: 0 };
  const fields = {
    "飞升/渡劫/化圣": "未飞升",
    级别: "109",
    攻击修炼: "20/25",
    法术修炼: "0/25",
    防御修炼: "17/25",
    抗法修炼: "10/25",
    攻击控制力: "20",
    法术控制力: "20",
    防御控制力: "20",
    抗法控制力: "20",
    靓号特效: "否",
    月饼粽子机缘: "40/69",
    神器套数: "0",
    坐骑总数: "0",
    储备金: "0",
  };
  record.detail!.tabs = [
    {
      name: "人物/修炼",
      text: "",
      fields: Object.entries(fields).map(([name, value]) => ({ name, value })),
      tables: [],
      elements: [],
      tooltips: [],
    },
    {
      name: "技能",
      text: "",
      fields: [],
      tables: [],
      elements: [],
      tooltips: [],
      items: [
        ...Array.from({ length: 7 }, (_, i) => ({
          index: i,
          kind: "skill" as const,
          category: "师门技能",
          name: "师门" + i,
          level: "119",
        })),
        { index: 7, kind: "skill", category: "技能", name: "强壮", level: "0" },
        { index: 8, kind: "skill", category: "技能", name: "神速", level: "0" },
      ],
    },
  ];
  return record;
}
export function analysisResponse(
  record: SavedRoleRecord,
  score = 80,
): Omit<ProductAnalysis, "score"> {
  const document = buildProductDocument(record);
  const dimension = (path: string, value: string): Dimension => ({
    score,
    reason: "根据已采集配置作参考判断，仍需核对具体属性。",
    evidence: [{ path, value, reason: "原文包含该配置字段。" }],
  });
  return {
    productKey: document.productKey,
    inputHash: document.contentHash,
    summary: "已采集资料可用于配置核对，不代表成交价格或收益。",
    highlights: ["已保存八只召唤兽"],
    risks: ["缺少市场对比资料"],
    missingData: [],
    dimensions: {
      foundation: dimension("/listing/summary/iGrade", "175"),
      equipment: dimension("/detail/tabs/2/items/0/description", "伤害：500\n特技：罗汉金钟"),
      pets: dimension("/detail/tabs/3/pets/0/name", "宝宝1"),
    },
  };
}
