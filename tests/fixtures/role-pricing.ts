import type { SavedRoleRecord, TabSnapshot } from "../../server/crawler/types";
import { roleSourceHash, type RoleMarketCandidate } from "../../server/analysis/role-market";
import {
  buildRolePricingSnapshot,
  type RoleSearchResult,
} from "../../server/analysis/role-pricing";

const tab = (name: string): TabSnapshot => ({
  name,
  text: "",
  fields: [],
  tables: [],
  elements: [],
  tooltips: [],
  items: [],
});

/** Synthetic full-role evidence. These URLs are never requested by the fixture. */
export function rolePricingRecord(eid = "role-target", price = 5000): SavedRoleRecord {
  const key = "33:" + eid,
    url = "https://xyq.cbg.163.com/equip?s=33&eid=" + eid;
  const collectedAt = new Date().toISOString();
  const person = tab("人物/修炼");
  person.fields = Object.entries({
    级别: "89",
    门派: "神木林",
    "飞升/渡劫/化圣": "未飞升",
    攻击修炼: "13",
    法术修炼: "13",
    防御修炼: "13",
    抗法修炼: "13",
    攻击控制力: "13",
    法术控制力: "13",
    防御控制力: "13",
    抗法控制力: "13",
    靓号特效: "否",
    神器套数: "0",
    坐骑总数: "0",
    月饼粽子机缘: "0",
    储备金: "0",
  }).map(([name, value]) => ({ name, value }));
  const skills = tab("技能");
  skills.items = ["强壮", "神速", "强身术"].map((name, index) => ({
    index,
    name,
    kind: "skill",
    level: name === "强身术" ? "120" : "26",
  }));
  const equipment = { ...tab("道具/法宝"), equipmentEmptyProof: "official-containers" as const };
  const pets = { ...tab("召唤兽/孩子"), pets: [], petCount: 0 };
  return {
    status: "complete",
    error: null,
    listing: {
      key,
      serverId: "33",
      serverAge: "older",
      eid,
      ordersn: eid,
      url,
      name: "模拟整号",
      price: String(price),
      attrs: {},
      summary: { iCash: 0, iSaving: 0, xianyu: 0 },
      sellingTime: null,
      createdTime: null,
      orderTime: null,
    },
    detail: {
      url,
      collectedAt,
      raw: {},
      tabs: [person, skills, equipment, pets, tab("坐骑"), tab("锦衣/外观"), tab("玩家之家")],
      equipmentCapture: {
        version: 1,
        complete: true,
        collectedAt,
        issues: [],
        emptyProof: "official-containers",
      },
      petCapture: { version: 1, complete: true, collectedAt, issues: [] },
      valuation: {
        version: 1,
        fields: [],
        issues: [],
        source: { serverId: "33", eid, askingPrice: price },
      },
    },
  };
}

export function roleSearchResultFixture(
  target = rolePricingRecord(),
  prices = [4800, 5000, 5200],
): RoleSearchResult {
  const candidates: RoleMarketCandidate[] = prices.map((price, index) => {
    const record = rolePricingRecord("role-sample-" + index, price);
    return {
      key: record.listing.key,
      url: record.listing.url,
      title: record.listing.name,
      price,
      active: true,
      serverAge: "older",
      fetchedAt: new Date().toISOString(),
      sourceHash: roleSourceHash(record),
      verified: true,
      reasons: [],
      differences: [],
      record,
    };
  });
  const request = {
    endpoint: "https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py",
    act: "show_role_search_result",
    args: { server_type: "3" },
  };
  const market = {
    endpoint: "https://xyq.cbg.163.com/cgi-bin/recommend.py",
    act: "recommd_by_role",
    args: { search_type: "overall_search_role", server_type: "3", page: "1" },
  };
  return {
    target: structuredClone(target),
    form: {
      url: request.endpoint,
      action: request.endpoint,
      method: "post",
      act: request.act,
      controls: [],
      menus: [],
    },
    selections: { controls: [], menus: [] },
    queryGeneration: null,
    queryArgs: { server_type: "3", level_min: 89, level_max: 89 },
    actualRequests: [request, market],
    pageAudits: [{ page: 1, requests: [request], marketRequests: [market] }],
    pages: 1,
    rows: prices.length,
    details: prices.length,
    exhausted: true,
    candidates,
    skipped: [],
    // The production wrapper recomputes this from frozen target/candidate evidence.
    marketReference: {
      policyVersion: "whole-role-core-config-v1",
      status: "insufficient",
      range: null,
      sampleCount: 0,
      scope: "synthetic",
      issues: [],
    },
  };
}

export function rolePricingFixture(target = rolePricingRecord(), prices?: number[]) {
  return buildRolePricingSnapshot(target, roleSearchResultFixture(target, prices));
}
