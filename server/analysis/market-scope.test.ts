import { EventEmitter } from "node:events";
import type { Page } from "playwright-core";
import { expect, it } from "vite-plus/test";
import {
  assertGlobalMarketRequest,
  createMarketScopeAudit,
  marketRequestEvidence,
} from "./market-scope";

const query = (extra = "") =>
  "https://xyq.cbg.163.com/cgi-bin/recommend.py?act=recommd_by_role&search_type=overall_search_pet&server_type=3&page=1" +
  extra;

it("只保留最终全服查询范围，不保存凭证、账号或完整 URL", () => {
  const evidence = marketRequestEvidence(
    query("&serverid=0&token=private&nickname=private&callback=cb"),
  )!;
  expect(evidence).toEqual({
    endpoint: "https://xyq.cbg.163.com/cgi-bin/recommend.py",
    act: "recommd_by_role",
    searchType: "overall_search_pet",
    serverType: "3",
    page: 1,
    restrictions: { serverid: "0" },
  });
  expect(() => assertGlobalMarketRequest(evidence, "overall_search_pet", 1)).not.toThrow();
  expect(JSON.stringify(evidence)).not.toContain("private");
});

it.each(["&serverid=33", "&area_id=6", "&serverid=0&serverid=33", "&server_type=1"])(
  "拒绝有范围限制或混合服龄的最终请求 %s",
  (extra) => {
    expect(() =>
      assertGlobalMarketRequest(marketRequestEvidence(query(extra))!, "overall_search_pet", 1),
    ).toThrow();
  },
);

it("检查 POST 请求范围与重复参数，忽略不相关来源", () => {
  const evidence = marketRequestEvidence(
    "https://xyq.cbg.163.com/cgi-bin/recommend.py",
    "act=recommd_by_role&search_type=overall_search_equip&server_type=3&page=2",
  )!;
  expect(() => assertGlobalMarketRequest(evidence, "overall_search_equip", 2)).not.toThrow();
  expect(() => assertGlobalMarketRequest(evidence, "overall_search_equip", 1)).toThrow();
  expect(marketRequestEvidence(query().replace("xyq.cbg.163.com", "example.com"))).toBeUndefined();
  expect(
    marketRequestEvidence("https://xyq.cbg.163.com/cgi-bin/show_login.py?act=show_login"),
  ).toBeUndefined();
});

it("宝宝装备同样核验最终搜索请求的全服范围", () => {
  const evidence = marketRequestEvidence(
    "https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py",
    "act=overall_search_pet_equip&server_type=3&page=1&serverid=0&cross_buy_serverid=0",
  )!;
  expect(() => assertGlobalMarketRequest(evidence, "overall_search_pet_equip", 1)).not.toThrow();
  expect(() =>
    assertGlobalMarketRequest(
      { ...evidence, restrictions: { serverid: "33" } },
      "overall_search_pet_equip",
      1,
    ),
  ).toThrow("单服");
});

it("每次查询必须有对应实际请求，上一页和混入的单服请求不可复用", () => {
  const page = new EventEmitter();
  const audit = createMarketScopeAudit(page as unknown as Page);
  const emit = (url: string) => page.emit("request", { url: () => url, postData: () => null });
  audit.begin("overall_search_pet", 1);
  expect(() => audit.confirm()).toThrow("实际网络请求");
  emit(query());
  expect(audit.confirm().serverType).toBe("3");
  emit(query("&serverid=33"));
  expect(() => audit.confirm()).toThrow("单服或地区限制");
  audit.begin("overall_search_pet", 2);
  emit(query());
  expect(() => audit.confirm()).toThrow("实际网络请求");
  emit(query().replace("page=1", "page=2"));
  expect(audit.confirm().page).toBe(2);
  audit.close();
  expect(page.listenerCount("request")).toBe(0);
});
