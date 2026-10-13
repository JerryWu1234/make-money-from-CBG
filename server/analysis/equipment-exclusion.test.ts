import { describe, expect, it } from "vite-plus/test";
import { equipmentExclusion, validEquipmentExclusion } from "./equipment-exclusion";
import type { EquipmentPricingItem } from "./equipment-pricing";
const item = (): EquipmentPricingItem => ({
  key: "equipment:0",
  name: "普通腰带",
  level: 60,
  category: "人物装备 · 腰带",
  description: "等级60\n防御35 气血140\n耐久度300\n装备条件：等级60",
  status: "no_match",
  referencePrice: null,
  candidates: [],
  issues: [],
  query: "actual query",
  searchState: "completed",
});
const record = () => ({
  key: "equipment:0",
  searchUrl: "https://xyq.cbg.163.com/cgi-bin/equipquery.py",
  serverAge: "3年以上服",
  modes: ["exact", "similar"].map((mode) => ({
    mode,
    args: { server_type: "3" },
    exhausted: true,
  })),
  scopeEvidence: ["exact", "similar"].map((mode) => ({
    mode,
    request: { serverType: "3", restrictions: {} },
  })),
});
describe("穷尽普通资产的核算排除", () => {
  it("两组实际全服检索读完才排除，价格保持null", () => {
    const current = item(),
      evidence = [record()];
    current.exclusion = equipmentExclusion(current, evidence);
    expect(current.exclusion?.label).toBe("无匹配，未计入参考合计");
    expect(current.referencePrice).toBeNull();
    expect(validEquipmentExclusion(current, evidence)).toBe(true);
    current.exclusion!.stages[0].args.server_type = "2";
    expect(validEquipmentExclusion(current, [record()])).toBe(false);
  });
  it.each(["pending", "read_failed", "unsupported"] as const)("%s不能当作便宜", (searchState) => {
    expect(equipmentExclusion({ ...item(), searchState }, [record()])).toBeUndefined();
  });
  it("专用/宝石/玉魄、高值配置、残缺或缺少相近/全服证据不排除", () => {
    for (const change of [
      { status: "untradable" as const },
      { description: item().description + "\n宝石：黑宝石" },
      { category: "上古玉魄" },
      { level: 100 },
      { description: "等级60\n防御35" },
    ])
      expect(equipmentExclusion({ ...item(), ...change }, [record()])).toBeUndefined();
    const evidence = record();
    evidence.modes[1].exhausted = false;
    expect(equipmentExclusion(item(), [evidence])).toBeUndefined();
    const scope = record();
    scope.scopeEvidence[0].request.serverType = "2";
    expect(equipmentExclusion(item(), [scope])).toBeUndefined();
    expect(
      equipmentExclusion(item(), [record(), { key: item().key, reason: "result_order_changed" }]),
    ).toBeUndefined();
  });
});
