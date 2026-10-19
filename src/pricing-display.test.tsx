import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  EquipmentPricingItem,
  EquipmentPricingSnapshot,
} from "../server/analysis/equipment-pricing";
import type { ValuationResult } from "../server/analysis/valuation-types";
import { DEFAULT_EQUIPMENT_BASELINE_PRICES } from "../server/analysis/equipment-baseline";
import { EquipmentBaselinePriceFields } from "./AnalysisSettings";
import { EquipmentPricingView } from "./EquipmentPricingView";
import { ValuationResultView } from "./ValuationResultView";
import { AssetCounts } from "./AssetCounts";

const baseline = (
  override: Partial<NonNullable<EquipmentPricingItem["baselineEstimate"]>> = {},
): NonNullable<EquipmentPricingItem["baselineEstimate"]> => ({
  policyVersion: "simulated-baseline-policy",
  kind: "ring",
  gameCurrency: 110000,
  amount: 1.1,
  serverId: "1",
  goldPrice: 300,
  goldUnit: 30000000,
  source: {
    basis: "historical",
    label: "DVG 叶子猪转载历史参考",
    url: "https://www.dvg.cn/wygl/90894.html",
    publishedAt: "2025-11-22",
  },
  note: "模拟历史参考；未实时查询藏宝阁。",
  ...override,
});
const item = (estimate = baseline()): EquipmentPricingItem => ({
  key: "simulated-ring",
  name: "模拟70级武器",
  level: 70,
  category: "人物装备 · 武器",
  description: "等级：70\n耐久：300",
  query: "",
  status: "no_match",
  referencePrice: null,
  candidates: [],
  issues: [],
  baselineEstimate: estimate,
});
const snapshot = (items = [item()]): EquipmentPricingSnapshot => ({
  version: 1,
  inputHash: "simulated-input",
  searchedAt: new Date().toISOString(),
  provider: "browser",
  model: "browser",
  queries: [],
  rawResponse: null,
  captureComplete: true,
  total: null,
  knownTotal: 0,
  items,
  issues: [],
});
it("无样本的装备和宝宝显示跳过而不是待补齐或0元", () => {
  const html = renderToStaticMarkup(
    <EquipmentPricingView
      snapshot={snapshot([{ ...item(), baselineEstimate: undefined, searchState: "skipped" }])}
    />,
  );
  expect(html).toContain("无样本，未计入参考合计");
  expect(html).not.toContain("查价未完成，继续时重试");
  expect(html).not.toContain("¥0.00");
});
it.each(["pending", "read_failed"] as const)("页面将%s与未找到报价区分", (state) => {
  const html = renderToStaticMarkup(
    <EquipmentPricingView
      snapshot={snapshot([{ ...item(), baselineEstimate: undefined, searchState: state }])}
    />,
  );
  expect(html).toContain(state === "pending" ? "查价未完成，继续时重试" : "详情读取失败，需重试");
  expect(html).not.toContain("未找到可靠报价");
});
it("逐件展示关联搜索页面和实际条件，继续查询的历史记录仍可查看", () => {
  const pricing = snapshot([{ ...item(), baselineEstimate: undefined }]);
  pricing.searchItems = [
    {
      key: "simulated-ring",
      searchUrl: "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=show_overall_search_equip",
      uiQueries: [{ submittedArgs: { level_min: 70, server_type: "3" } }],
    },
    { key: "other-asset", searchUrl: "other-asset-search-must-not-appear" },
  ];
  const html = renderToStaticMarkup(<EquipmentPricingView snapshot={pricing} />);
  expect(html).toContain("查看这件装备的搜索页面与条件记录");
  expect(html).toContain("show_overall_search_equip");
  expect(html).toContain("submittedArgs");
  expect(html).not.toContain("other-asset-search-must-not-appear");
});
it("初始属性方案说明升序和五个有效样品，不沿用较低核心值取样说明", () => {
  const pricing = snapshot([
    {
      ...item(),
      baselineEstimate: undefined,
      comparisonPolicy: "core-initial-first-five-v3",
      priceMethod: "first-five-minimum-v4",
      status: "priced",
      referencePrice: 100,
      searchState: "completed",
    },
  ]);
  pricing.queries = ["初伤592升序"];
  const html = renderToStaticMarkup(<EquipmentPricingView snapshot={pricing} />);
  expect(html).toContain("仅核验前5条不同商品");
  expect(html).toContain("拒项占名额，不继续翻页补足");
  expect(html).toContain("核心初始值在目标至目标+2范围内的最低挂牌价");
  expect(html).not.toContain("基础值相等或较低样本");
  expect(html).not.toContain("拒项也占名额");
});
it("装备取得五件时显示报价与均价；搜索中断时主金额保留待查", () => {
  const gear: EquipmentPricingItem = {
    ...item(),
    baselineEstimate: undefined,
    priceMethod: "first-five-average-v3",
    searchState: "completed",
    similarEstimate: {
      policyVersion: "bounded-attributes-first-five-average-v8",
      status: "range",
      average: 121,
      median: 120,
      sampleCount: 5,
      range: { min: 100, max: 145 },
      issues: [],
    },
    candidates: [100, 110, 120, 130, 145].map((price, index) => ({
      url: `https://xyq.cbg.163.com/equip/1/display-${index}`,
      title: `模拟报价${index + 1}`,
      price,
      priceType: "listing",
      quote: `挂牌价：¥${price}`,
      verified: true,
      matchType: "similar",
      reason: "模拟已核实来源",
      fetchedAt: new Date().toISOString(),
      sourceHash: `synthetic-${index}`,
    })),
  };
  const pricing = { ...snapshot([gear]), queries: ["模拟查询"] };
  const html = renderToStaticMarkup(<EquipmentPricingView snapshot={pricing} />);
  expect(html).toContain("相近装备参考价（挂牌平均价）");
  expect(html).toContain("¥121.00");
  expect(html).toContain("相近配置样本：5条");
  for (let index = 1; index <= 5; index++) expect(html).toContain(`模拟报价${index}`);
  gear.searchState = "pending";
  const pending = renderToStaticMarkup(<EquipmentPricingView snapshot={pricing} />);
  expect(pending).toContain("查价未完成，继续时重试");
  expect(pending).not.toContain("¥121.00");
});
const valuation = (override: Partial<ValuationResult> = {}): ValuationResult => ({
  comparison_mode: "listing-only",
  decision: "NEED_INFO",
  asking_price: 800,
  extra_cost: null,
  total_cost: null,
  model_value: null,
  max_listing_price: null,
  ideal_listing_price: null,
  margin_of_safety: null,
  items: [],
  missing_fields: [],
  pending_rules: [],
  reason: "模拟参考金额",
  next_action: "核对参考依据",
  known_subtotal: 1000,
  bare_role_value: 1000,
  calculation_version: "simulated-rule",
  estimated_value_range: { min: 1001.1, max: 1001.1 },
  estimated_sources: ["baseline"],
  ...override,
});

it("裸号显示已采数量与装备简要配置，隐藏未检测和未计价状态", () => {
  const counts = {
    equipment: 1,
    jewelry: 2,
    pets: 3,
    equipmentItems: [
      {
        name: "测试头盔",
        level: 80,
        gemLevel: 6,
        specialSkills: ["破甲术"],
        specialEffects: [],
        sets: [],
      },
    ],
  };
  const result = valuation({
    asset_scope: "body",
    model_value: 1000,
    estimated_sources: undefined,
    estimated_value_range: undefined,
  });
  const html = renderToStaticMarkup(<ValuationResultView result={result} assetCounts={counts} />);
  const overview = html.split('<details class="analysis-valuation-details">')[0];
  expect(overview).toContain("<dt>装备</dt><dd>1件</dd>");
  expect(overview).toContain("<dt>灵饰</dt><dd>2件</dd>");
  expect(overview).toContain("<dt>宝宝</dt><dd>3只</dd>");
  expect(overview).toContain("测试头盔 · 80级 · 宝石6段 · 特技：破甲术");
  expect(overview).not.toMatch(/未检测|未计价|本轮不分析/);
  expect(renderToStaticMarkup(<AssetCounts counts={counts} />)).toContain(
    "装备 1件 · 灵饰 2件 · 宝宝 3只",
  );
  expect(renderToStaticMarkup(<AssetCounts counts={null} />)).toBe("");
  const unclassified = renderToStaticMarkup(
    <AssetCounts counts={{ equipment: null, jewelry: null, equipmentTotal: 1, pets: 0 }} />,
  );
  expect(unclassified).toContain("装备/灵饰 1件");
  expect(unclassified).not.toContain("装备 1件");
});

it("核算排除保留原因，分项不显示0元", () => {
  const excluded = {
    ...item(),
    baselineEstimate: undefined,
    exclusion: {
      policy: "exhausted-plain-equipment-up-to-80-v1" as const,
      label: "无匹配，未计入参考合计" as const,
      stages: [],
    },
  };
  const gear = renderToStaticMarkup(<EquipmentPricingView snapshot={snapshot([excluded])} />);
  expect(gear).toContain("无匹配，未计入参考合计");
  expect(gear).not.toContain("¥0.00");
  const html = renderToStaticMarkup(
    <ValuationResultView
      result={valuation({
        excluded_assets: [
          { key: excluded.key, name: excluded.name, reason: excluded.exclusion.label },
        ],
      })}
    />,
  );
  expect(html).toContain("市场售价未知");
});

describe("普通装备默认价显示（仅模拟快照，无市场查询）", () => {
  it("宝宝装备逐条显示参考价，不显示重复合计或零元估值", () => {
    const gear = snapshot([
      { ...item(), baselineEstimate: undefined, status: "priced", referencePrice: 120 },
    ]);
    const html = renderToStaticMarkup(
      <EquipmentPricingView
        snapshot={gear}
        asset="宝宝装备"
        accounting="宝宝挂牌已包含穿戴装备，不重复相加"
      />,
    );
    expect(html).toContain("宝宝装备查价");
    expect(html).toContain("¥120.00");
    expect(html).toContain("不重复相加");
    expect(html).not.toContain("宝宝装备参考价合计");
    expect(html).not.toContain("¥0.00");
  });
  it("相近装备显示一个参考中位数，报价范围留在依据中；缺项时主金额仍叫小计", () => {
    const gear = item();
    delete gear.baselineEstimate;
    gear.similarEstimate = {
      policyVersion: "same-core-equipment-v2",
      status: "range",
      median: 370,
      range: { min: 350, max: 568.1 },
      sampleCount: 3,
      issues: [],
    };
    const html = renderToStaticMarkup(<EquipmentPricingView snapshot={snapshot([gear])} />);
    expect(html).toContain("相近装备参考价（挂牌中位数）");
    expect(html).toContain("¥370.00");
    expect(html).toContain("样本挂牌范围：¥350.00—¥568.10");
    expect(html).not.toContain("¥0.00");
    const result = renderToStaticMarkup(
      <ValuationResultView
        result={valuation({
          estimated_value_range: undefined,
          estimated_subtotal_range: { min: 1350, max: 1568.1 },
          estimated_subtotal_value: 1370,
        })}
      />,
    );
    expect(result).toContain("已算参考小计");
    expect(result).toContain("¥1,370.00");
    expect(result).toContain("还有未定价项目");
  });
  it("失效默认价保留身份和出处，不显示旧金额/说明，也不计入默认小计或待补数", () => {
    const invalidPriced = {
      ...item(baseline({ amount: 9.99, gameCurrency: 999999, note: "旧正常默认说明A" })),
      key: "invalid-priced",
      name: "失效模拟装备A",
      baselineInvalidReason: "默认价与本批设置不一致。",
      issues: ["旧正常默认说明A"],
    };
    const invalidPending = {
      ...item(baseline({ amount: null, gameCurrency: 222222, note: "旧正常默认说明B" })),
      key: "invalid-pending",
      name: "失效模拟装备B",
      baselineInvalidReason: "资料或行情快照已过期。",
      issues: ["旧正常默认说明B"],
    };
    const html = renderToStaticMarkup(
      <EquipmentPricingView snapshot={snapshot([item(), invalidPriced, invalidPending])} />,
    );
    expect(html).toContain("失效模拟装备A");
    expect(html).toContain("失效模拟装备B");
    expect(html).toContain("默认参考价已失效");
    expect(html).toContain("默认价与本批设置不一致");
    expect(html).toContain("资料或行情快照已过期");
    expect(html).toContain("请按当前资料和设置重新分析");
    expect(html).toContain("原参考依据（已失效，未采用）");
    expect(html).toContain("默认参考价小计（非实时挂牌价）：¥1.10 · 1件");
    for (const hidden of [
      "¥9.99",
      "999,999",
      "222,222",
      "旧正常默认说明A",
      "旧正常默认说明B",
      "另有",
      "同配置挂牌样本",
    ])
      expect(html).not.toContain(hidden);
  });
  it("历史环装显示人民币/梦幻币、日期出处及独立小计，不伪称登录查询或零匹配", () => {
    const html = renderToStaticMarkup(<EquipmentPricingView snapshot={snapshot()} />);
    expect(html).toContain("装备查价");
    expect(html).toContain("110,000梦幻币");
    expect(html).toContain("¥1.10");
    expect(html).toContain("2025-11-22");
    expect(html).toContain('href="https://www.dvg.cn/wygl/90894.html"');
    expect(html).toContain("默认参考价小计（非实时挂牌价）");
    expect(html).toContain("未实时核实藏宝阁报价");
    expect(html).not.toContain("程序通过已登录藏宝阁查询");
    expect(html).not.toContain("同配置挂牌样本：0条");
    expect(html).not.toContain("未找到可靠报价");
    expect(html).not.toContain("¥0.00");
    expect(html).not.toContain("以上仅含已核实");
    const note = "唯一模拟历史参考说明";
    const repeated = { ...item(baseline({ note })), issues: [note] };
    expect(
      renderToStaticMarkup(<EquipmentPricingView snapshot={snapshot([repeated])} />).split(note)
        .length - 1,
    ).toBe(1);
  });
  it("缺默认价保留待补，缺金价保留梦幻币和具体说明，两者不显示零价", () => {
    const missingPrice = renderToStaticMarkup(
      <EquipmentPricingView
        snapshot={snapshot([
          item(
            baseline({
              kind: "white",
              gameCurrency: null,
              amount: null,
              note: "90级武器未设置默认参考价，保留待补。",
            }),
          ),
        ])}
      />,
    );
    expect(missingPrice).toContain("未设置默认价，保留待补");
    expect(missingPrice).toContain("90级武器未设置默认参考价");
    expect(missingPrice).not.toContain("¥0.00");
    const missingGold = renderToStaticMarkup(
      <EquipmentPricingView
        snapshot={snapshot([
          item(
            baseline({
              amount: null,
              goldPrice: null,
              note: "缺当前商品区服金价，人民币参考价暂不计算。",
            }),
          ),
        ])}
      />,
    );
    expect(missingGold).toContain("110,000梦幻币");
    expect(missingGold).toContain("缺当前商品区服金价");
    expect(missingGold).not.toContain("默认参考价小计");
    expect(missingGold).not.toContain("¥0.00");
  });
  it("低值忽略保留装备身份和未计入说明，不展示虚构样本或零价", () => {
    const low = {
      ...item(
        baseline({
          kind: "ignored",
          gameCurrency: null,
          amount: null,
          source: { basis: "excluded", label: "低值处理规则" },
          note: "低值普通装备未计入参考价。",
        }),
      ),
      name: "模拟30级装备",
      level: 30,
    };
    const html = renderToStaticMarkup(<EquipmentPricingView snapshot={snapshot([low])} />);
    expect(html).toContain("模拟30级装备");
    expect(html).toContain("低值未计入");
    expect(html).toContain("低值普通装备未计入参考价");
    expect(html).not.toContain("同配置挂牌样本");
    expect(html).not.toContain("¥0.00");
  });
  it("人工改价明确预设，不沿用历史日期或出处；不安全链接不生成锚点", () => {
    const manual = renderToStaticMarkup(
      <EquipmentPricingView
        snapshot={snapshot([
          item(
            baseline({
              source: {
                basis: "preset",
                label: "用户设置",
                publishedAt: "2025-11-22",
                url: "https://www.dvg.cn/wygl/90894.html",
              },
            }),
          ),
        ])}
      />,
    );
    expect(manual).toContain("人工预设");
    expect(manual).not.toContain("2025-11-22");
    expect(manual).not.toContain('href="https://www.dvg.cn');
    const unsafe = renderToStaticMarkup(
      <EquipmentPricingView
        snapshot={snapshot([
          item(
            baseline({
              source: { basis: "historical", label: "无有效链接", url: "javascript:alert(1)" },
            }),
          ),
        ])}
      />,
    );
    expect(unsafe).not.toContain('href="javascript:');
    expect(unsafe).toContain("无有效链接");
  });
  it("默认小计与真实查询小计分列，原有联网查价标题和精确样本显示兼容", () => {
    const exact = {
      ...item(),
      key: "exact",
      name: "模拟精确装备",
      baselineEstimate: undefined,
      status: "priced" as const,
      referencePrice: 300,
      query: "模拟全服条件",
      candidates: [
        {
          url: "https://xyq.cbg.163.com/equip?s=1&eid=simulated",
          title: "模拟已核实来源",
          verified: true,
          matchType: "exact" as const,
          price: 300,
          priceType: "listing" as const,
          quote: "模拟挂牌价：¥300",
          reason: "模拟匹配",
          fetchedAt: new Date().toISOString(),
          sourceHash: "simulated-hash",
        },
      ],
    };
    const value = { ...snapshot([item(), exact]), knownTotal: 300, queries: ["模拟全服条件"] };
    const html = renderToStaticMarkup(<EquipmentPricingView snapshot={value} />);
    expect(html).toContain("装备联网查价");
    expect(html).toContain("¥300.00");
    expect(html).toContain("默认参考价小计（非实时挂牌价）：¥1.10");
    expect(html).toContain("不含普通装备默认参考价");
    expect(html).toContain("同配置挂牌样本：1条");
    expect(html).not.toContain("¥301.10");
  });
});

describe("默认价设置和整体估值显示", () => {
  it("没有装备和宝宝时显示总估值及空资产，不把零资产显示为报价", () => {
    const empty = { ...snapshot([]), total: 0 };
    const html = renderToStaticMarkup(
      <ValuationResultView
        result={valuation({
          decision: "PASS",
          asking_price: 17555,
          model_value: 14903.41,
          bare_role_value: 14903.41,
          known_subtotal: 14903.41,
          equipment_value: 0,
          pet_value: 0,
          equipment_pricing: empty,
          pet_pricing: { ...empty, items: [] },
          price_difference: -2651.59,
          price_difference_ratio: -0.1510447,
          estimated_value_range: undefined,
          estimated_sources: undefined,
        })}
      />,
    );
    const overview = html.split('<details class="analysis-valuation-details">')[0];
    expect(overview).toContain("总估值");
    expect(overview).toContain("¥14,903.41");
    expect(overview).toContain("无装备");
    expect(overview).toContain("无宝宝");
    expect(overview).toContain("卖家要价比估值高 ¥2,651.59");
    expect(overview).not.toContain("¥0.00");
    expect(overview).not.toContain("¥-2,651.59");
    expect(html).toContain("查看估值依据与查价记录");
  });
  it("宝宝缺报价时显示已算小计和未定价，不把小计当作总估值", () => {
    const html = renderToStaticMarkup(
      <ValuationResultView
        result={valuation({
          asking_price: 26999,
          bare_role_value: 19495.33,
          known_subtotal: 19495.33,
          equipment_value: 0,
          equipment_pricing: { ...snapshot([]), total: 0 },
          pet_value: null,
          pet_pricing: {
            ...snapshot(),
            items: [
              {
                ...item(),
                baselineEstimate: undefined,
                fields: [],
                skills: [],
                innerSkills: [],
                equipment: [],
              },
            ],
          },
          estimated_value_range: undefined,
          estimated_sources: undefined,
        })}
      />,
    );
    const overview = html.split('<details class="analysis-valuation-details">')[0];
    expect(overview).toContain("已算小计");
    expect(overview).toContain("¥19,495.33");
    expect(overview).toContain("未定价");
    expect(overview).toContain("总估值暂无法计算");
    expect(overview).not.toContain("<small>总估值</small>");
    expect(overview).not.toContain("无宝宝");
    expect(overview).not.toContain("¥0.00");
  });
  it("资产尚未采齐时不把空数组解释为没有装备或宝宝", () => {
    const incomplete = { ...snapshot([]), captureComplete: false };
    const html = renderToStaticMarkup(
      <ValuationResultView
        result={valuation({
          equipment_pricing: incomplete,
          pet_pricing: { ...incomplete, items: [] },
          equipment_value: null,
          pet_value: null,
          estimated_value_range: undefined,
          estimated_sources: undefined,
        })}
      />,
    );
    expect(html).toContain("资料未采齐");
    expect(html).not.toContain("无装备");
    expect(html).not.toContain("无宝宝");
  });
  it("默认60/90/100留空，70/80历史值保留，梦幻币输入只接受正整数", () => {
    const html = renderToStaticMarkup(<EquipmentBaselinePriceFields onChange={() => {}} />);
    expect((html.match(/value=""/g) || []).length).toBe(6);
    for (const value of [110000, 80000, 480000, 400000]) expect(html).toContain(`value="${value}"`);
    expect((html.match(/min="1" step="1"/g) || []).length).toBe(10);
    expect(html).toContain("60级环装");
    expect(html).toContain("90级普通白板");
    expect(html).toContain("留空表示暂不计价");
    expect(html).toContain("不是实时藏宝阁报价");
    expect(html).toContain("仅适用于三年外区服");
    const edited = renderToStaticMarkup(
      <EquipmentBaselinePriceFields
        prices={{ ...DEFAULT_EQUIPMENT_BASELINE_PRICES, "90": { weapon: 100000, armor: null } }}
        onChange={() => {}}
      />,
    );
    expect(edited).toContain('value="100000"');
    expect(DEFAULT_EQUIPMENT_BASELINE_PRICES["90"].weapon).toBeNull();
  });
  it("完整/部分参考区间实际含默认价时明确未实时核实，纯相似文案保持", () => {
    const full = renderToStaticMarkup(<ValuationResultView result={valuation()} />);
    expect(full).toContain("总估值区间（含默认参考价）");
    expect(full).toContain("未实时核实藏宝阁报价");
    expect(full).not.toContain("基于相近配置挂牌样本的完整参考区间");
    const partial = renderToStaticMarkup(
      <ValuationResultView
        result={valuation({
          estimated_value_range: undefined,
          estimated_subtotal_range: { min: 1001.1, max: 1001.1 },
        })}
      />,
    );
    expect(partial).toContain("已算小计区间（含默认参考价）");
    expect(partial).toContain("未实时核实藏宝阁报价");
    const similar = renderToStaticMarkup(
      <ValuationResultView result={valuation({ estimated_sources: ["similar"] })} />,
    );
    expect(similar).toContain("基于相近配置挂牌样本的完整参考区间");
    expect(similar).not.toContain("含默认参考价");
    const mixed = renderToStaticMarkup(
      <ValuationResultView result={valuation({ estimated_sources: ["similar", "baseline"] })} />,
    );
    expect(mixed).toContain("相近配置挂牌样本和普通装备默认参考价");
  });
  it("估值明细默认额与精确小计分开，低值排除不冒充零价，缺默认价显示待补", () => {
    const base = { input: "模拟装备", formula: "模拟默认价规则", confirmed: false, evidence: [] };
    const html = renderToStaticMarkup(
      <ValuationResultView
        result={valuation({
          items: [
            { ...base, name: "模拟默认装备", amount: 1.1, referenceBasis: "baseline" },
            { ...base, name: "模拟待补装备", amount: null, referenceBasis: "baseline" },
            { ...base, name: "模拟低值装备", amount: 0, referenceBasis: "excluded" },
          ],
        })}
      />,
    );
    expect(html).toContain("默认参考 ¥1.10");
    expect(html).toContain("默认价或金价待补");
    expect(html).toContain("低值未计入");
    expect(html).not.toContain("¥0.00");
    expect(html).toContain("已核算小计不含另列默认参考价或相近区间");
    expect(html).toContain("已核算分项小计：¥1,000.00");
    const exact = renderToStaticMarkup(
      <ValuationResultView
        result={valuation({
          items: [{ ...base, name: "精确项", amount: 1000, confirmed: true }],
          estimated_sources: ["similar"],
        })}
      />,
    );
    expect(exact).toContain("小计包含已识别项目");
    expect(exact).not.toContain("已核算小计不含另列默认参考价");
  });
});

it("价格组成直接展示装备和宝宝参考区间，不只显示裸号金额", () => {
  const html = renderToStaticMarkup(
    <ValuationResultView
      result={valuation({
        estimated_equipment_range: { min: 400, max: 420 },
        estimated_pet_range: { min: 900, max: 1200 },
      })}
    />,
  );
  expect(html).toContain("已算小计区间 ¥400.00—¥420.00");
  expect(html).toContain("已算小计区间 ¥900.00—¥1,200.00");
});
it.each([
  { captureComplete: true, missingPrice: false, label: "低值未计入" },
  { captureComplete: false, missingPrice: false, label: "资料未采齐" },
  { captureComplete: true, missingPrice: true, label: "未定价" },
])("排除低值装备的零小计不冒充挂牌参考价：$label", ({ captureComplete, missingPrice, label }) => {
  const ignored = item(
    baseline({
      kind: "ignored",
      amount: 0,
      gameCurrency: 0,
      source: { basis: "excluded", label: "低值排除" },
    }),
  );
  const items = missingPrice
    ? [
        ignored,
        {
          ...item(),
          key: "unpriced",
          baselineEstimate: undefined,
          searchState: "pending" as const,
        },
      ]
    : [ignored];
  const html = renderToStaticMarkup(
    <ValuationResultView
      result={valuation({
        equipment_pricing: { ...snapshot(items), captureComplete },
        equipment_value: null,
        estimated_equipment_range: { min: 0, max: 0 },
      })}
    />,
  );
  const overview = html.split('<details class="analysis-valuation-details">')[0];
  expect(overview).toContain("<dt>装备</dt><dd>" + label + "</dd>");
  expect(overview).not.toContain("¥0.00");
});
it("少样本显示已核实挂牌范围，并明确未计入估值", () => {
  const gear = item();
  delete gear.baselineEstimate;
  gear.similarEstimate = {
    policyVersion: "simulated",
    status: "insufficient",
    range: null,
    observedRange: { min: 388.88, max: 400.8 },
    sampleCount: 2,
    issues: ["不足3条"],
  };
  const html = renderToStaticMarkup(<EquipmentPricingView snapshot={snapshot([gear])} />);
  expect(html).toContain("已核实样本挂牌范围：¥388.88—¥400.80");
  expect(html).toContain("未纳入估值");
  expect(html).not.toContain("¥0.00");
});
