import { describe, expect, it } from "vite-plus/test";
import {
  rolePricingFixture,
  rolePricingRecord,
  roleSearchResultFixture,
} from "../../tests/fixtures/role-pricing";
import {
  buildRolePricingSnapshot,
  rolePricingInputHash,
  validateRolePricing,
  rolePricingPromptEvidence,
} from "./role-pricing";
import { roleSourceHash } from "./role-market";
import { calculateValuation } from "./valuation-calculator";
import { attachRolePricing } from "./role-pricing";
import { createProfile } from "./profile";

describe("整号参考快照的独立计价与证据校验", () => {
  it("专用装备分项未知，整号配置通过后独立展示整体参考和挂牌差额", () => {
    const record = rolePricingRecord();
    const add = (current: typeof record) => {
      const tab = current.detail!.tabs.find((tab) => tab.name === "道具/法宝")!;
      delete tab.equipmentEmptyProof;
      delete current.detail!.equipmentCapture!.emptyProof;
      tab.items = [
        {
          index: 0,
          kind: "equipment",
          name: "专用腰带",
          category: "人物装备 · 腰带",
          description: "等级80\n防御45 气血180\n耐久度100\n玩家123专用",
        },
      ];
    };
    add(record);
    const search = roleSearchResultFixture(record);
    for (const candidate of search.candidates) {
      add(candidate.record);
      candidate.sourceHash = roleSourceHash(candidate.record);
    }
    const snapshot = buildRolePricingSnapshot(record, search);
    const base = calculateValuation(record, createProfile("fixture", undefined, false));
    const attached = attachRolePricing(base, record, snapshot);
    expect(attached.special_asset_reference).toMatchObject({
      value: 5000,
      listingDifference: 0,
      assets: [{ name: "专用腰带", individualPrice: null }],
    });
    expect(attached.model_value).toBe(base.model_value);
    expect(attached.known_subtotal).toBe(base.known_subtotal);
    expect(attachRolePricing(base, record).special_asset_reference?.value).toBeNull();
  });
  it("目标挂牌价不当样本，3条独立全服样本生成独立区间", () => {
    const record = rolePricingRecord(),
      result = roleSearchResultFixture(record);
    result.candidates.push({
      ...result.candidates[0],
      key: record.listing.key,
      url: record.listing.url,
      record,
      price: 5000,
      sourceHash: roleSourceHash(record),
    });
    const snapshot = buildRolePricingSnapshot(record, result);
    expect(snapshot.marketReference).toMatchObject({
      status: "range",
      range: { min: 4800, max: 5200 },
      median: 5000,
      sampleCount: 3,
    });
    expect(snapshot.candidates.at(-1)?.verified).toBe(false);
    expect(validateRolePricing(snapshot, record)).toBe(true);
  });
  it.each([
    [4800, 5000],
    [1000, 2000, 3000],
  ])("不足3条或价格分散均保留未知：%s", (...prices) => {
    const snapshot = rolePricingFixture(undefined, prices);
    expect(snapshot.marketReference).toMatchObject({
      status: "insufficient",
      range: null,
      median: null,
    });
    expect(snapshot.searchComplete).toBe(true);
  });
  it("身份、源码hash、正文价格或过期候选不可变成有效样本", () => {
    for (const kind of ["identity", "hash", "price", "fetched", "capture", "school"]) {
      const record = rolePricingRecord(),
        result = roleSearchResultFixture(record);
      const candidate = result.candidates[0];
      if (kind === "identity") candidate.key = "33:other";
      if (kind === "hash") candidate.sourceHash = "unverified";
      if (kind === "price") candidate.record.detail!.valuation!.source.askingPrice = 9999;
      if (kind === "fetched") candidate.fetchedAt = "2000-01-01T00:00:00Z";
      if (kind === "capture") candidate.record.detail!.collectedAt = "2000-01-01T00:00:00Z";
      if (kind === "school")
        candidate.record.detail!.tabs[0].fields.find((field) => field.name === "门派")!.value =
          "大唐官府";
      if (["price", "capture", "school"].includes(kind))
        candidate.sourceHash = roleSourceHash(candidate.record);
      const snapshot = buildRolePricingSnapshot(record, result);
      expect(snapshot.candidates[0].verified, kind).toBe(false);
      expect(snapshot.marketReference, kind).toMatchObject({
        status: "insufficient",
        range: null,
        median: null,
        sampleCount: 2,
      });
    }
  });
  it("每次保存及复用重新核对角色和报价，改变hash或金额拒绝", () => {
    const record = rolePricingRecord(),
      snapshot = rolePricingFixture(record);
    expect(validateRolePricing(snapshot, rolePricingRecord("different-role"))).toBe(false);
    snapshot.candidates[0].price = 6000;
    expect(validateRolePricing(snapshot, record)).toBe(false);
    const old = rolePricingFixture(record);
    old.searchedAt = "2000-01-01T00:00:00Z";
    expect(validateRolePricing(old, record)).toBe(false);
    const changed = structuredClone(record);
    changed.detail!.tabs[0].fields[0].value = "90";
    expect(rolePricingInputHash(changed)).not.toBe(rolePricingInputHash(record));
  });
  it.each(["identity", "price", "bodyPrice", "capture"])(
    "新采目标的%s错误不能嫁接到冻结任务",
    (kind) => {
      const record = rolePricingRecord(),
        result = roleSearchResultFixture(record);
      if (kind === "identity") result.target.listing = rolePricingRecord("other").listing;
      if (kind === "price") result.target.listing.price = "5888";
      if (kind === "bodyPrice") result.target.detail!.valuation!.source.askingPrice = 5888;
      if (kind === "capture") result.target.detail!.collectedAt = "2000-01-01T00:00:00Z";
      expect(() => buildRolePricingSnapshot(record, result)).toThrow("整号查价目标");
    },
  );
  it("同ID同售价的目标法修13变12也拒绝，候选相近配置仍可采用", () => {
    const record = rolePricingRecord(),
      result = roleSearchResultFixture(record);
    const training = (value: typeof record) =>
      value.detail!.tabs[0].fields.find((field) => field.name === "法术修炼")!;
    training(result.target).value = "12";
    expect(() => buildRolePricingSnapshot(record, result)).toThrow("整号查价目标");
    result.target = structuredClone(record);
    training(result.candidates[0].record).value = "12";
    result.candidates[0].sourceHash = roleSourceHash(result.candidates[0].record);
    const snapshot = buildRolePricingSnapshot(record, result);
    expect(snapshot.candidates[0].verified).toBe(true);
    expect(snapshot.marketReference.status).toBe("range");
    training(snapshot.observedTarget!).value = "12";
    expect(validateRolePricing(snapshot, record)).toBe(false);
  });
  it("目标仅刷新采集时间或展示资料时，仍核验相同的价格配置", () => {
    const record = rolePricingRecord(),
      result = roleSearchResultFixture(record);
    const refreshed = new Date(Date.now() - 1000).toISOString();
    result.target.detail!.collectedAt = refreshed;
    result.target.detail!.equipmentCapture!.collectedAt = refreshed;
    result.target.detail!.petCapture!.collectedAt = refreshed;
    result.target.detail!.tabs[0].collectedAt = refreshed;
    result.target.listing.name = "更新后的展示名称";
    result.target.listing.highlights = ["新的展示摘要"];
    expect(validateRolePricing(buildRolePricingSnapshot(record, result), record)).toBe(true);
  });
  it("目标估值字段改变不能继续绑定冻结任务", () => {
    const record = rolePricingRecord();
    record.detail!.valuation!.fields.push({ name: "进阶坐骑数", value: "1", tab: "坐骑" });
    const result = roleSearchResultFixture(record);
    result.target.detail!.valuation!.fields[0].value = "2";
    expect(() => buildRolePricingSnapshot(record, result)).toThrow("整号查价目标");
  });
  it.each(["server", "age", "missing", "page"])("实际网络范围%s不符时拒绝保存", (kind) => {
    const record = rolePricingRecord(),
      result = roleSearchResultFixture(record);
    const market = result.pageAudits[0].marketRequests[0];
    if (kind === "server") market.args.serverid = "33";
    if (kind === "age") market.args.server_type = "2,3";
    if (kind === "missing") result.pageAudits[0].marketRequests = [];
    if (kind === "page") market.args.page = "2";
    result.actualRequests = result.pageAudits.flatMap((value) => [
      ...value.requests,
      ...value.marketRequests,
    ]);
    expect(() => buildRolePricingSnapshot(record, result)).toThrow("全服来源证据");
  });
  it("独立整号参考不改变模型金额或资产小计，AI证据不含完整记录", () => {
    const record = rolePricingRecord(),
      snapshot = rolePricingFixture(record);
    const base = calculateValuation(record, createProfile("fixture", undefined, false));
    const attached = attachRolePricing(base, record, snapshot);
    const { role_pricing: _reference, ...amounts } = attached;
    expect(amounts).toEqual(base);
    const evidence = rolePricingPromptEvidence(snapshot);
    expect(evidence).not.toHaveProperty("observedTarget");
    expect(evidence?.candidates[0]).not.toHaveProperty("record");
  });
});
