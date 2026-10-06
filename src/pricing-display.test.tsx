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

describe("普通装备默认价显示（仅模拟快照，无市场查询）", () => {
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
    expect(full).toContain("完整参考估值区间（含默认参考价）");
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
    expect(partial).toContain("部分参考价区间（含默认参考价，仍有缺项）");
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
