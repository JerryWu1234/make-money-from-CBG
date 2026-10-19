import { EventEmitter } from "node:events";
import type { Page, Request } from "playwright-core";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  assertMarketRequest,
  createMarketScopeAudit,
  marketRequestEvidence,
  selectMarketServer,
} from "./market-scope";

// Fail closed on missing/other/mixed servers, wrong pages, missing requests, or UI selection failure.
const query = (extra = "") =>
  "https://xyq.cbg.163.com/cgi-bin/recommend.py?act=recommd_by_role&search_type=overall_search_pet&page=1" +
  extra;
afterEach(() => vi.unstubAllGlobals());
it("保存目标单服的最终请求，不保存凭证或完整URL", () => {
  const evidence = marketRequestEvidence(query("&serverid=33&token=private&nickname=private"))!;
  expect(evidence.restrictions).toEqual({ serverid: "33" });
  expect(evidence.serverType).toBe("");
  expect(() => assertMarketRequest(evidence, "overall_search_pet", 1, "33")).not.toThrow();
  expect(JSON.stringify(evidence)).not.toContain("private");
});
it.each([
  "",
  "&serverid=0",
  "&serverid=34",
  "&serverid=33,34",
  "&serverid=33&serverid=34",
  "&cross_buy_serverid=33",
  "&serverid=33&server_id=34",
  "&serverid=33&area_id=6",
  "&serverid=33&server_type=3",
])("最终请求拒绝无目标服或额外范围 %s", (extra) => {
  expect(() =>
    assertMarketRequest(marketRequestEvidence(query(extra))!, "overall_search_pet", 1, "33"),
  ).toThrow();
});
it.each(["", "0", "33,34", "x", undefined])("缺失或无效目标服%s不得回退全服", (target) => {
  expect(() =>
    assertMarketRequest(
      marketRequestEvidence(query("&serverid=33"))!,
      "overall_search_pet",
      1,
      target as string,
    ),
  ).toThrow("目标服务器");
});
it("检查POST类别、页码与来源", () => {
  const evidence = marketRequestEvidence(
    "https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py",
    "act=overall_search_pet_equip&serverid=33&page=2",
  )!;
  expect(() => assertMarketRequest(evidence, "overall_search_pet_equip", 2, "33")).not.toThrow();
  expect(() => assertMarketRequest(evidence, "overall_search_pet_equip", 1, "33")).toThrow();
  expect(marketRequestEvidence(query().replace("xyq.cbg.163.com", "example.com"))).toBeUndefined();
  expect(
    marketRequestEvidence("https://xyq.cbg.163.com/cgi-bin/show_login.py?act=show_login"),
  ).toBeUndefined();
});
it("每页必须观察到目标单服实际请求，不能复用上一页", () => {
  const page = new EventEmitter();
  const audit = createMarketScopeAudit(page as unknown as Page, "33");
  const emit = (url: string) =>
    page.emit("request", { url: () => url, postData: () => null } as Request);
  audit.begin("overall_search_pet", 1);
  expect(() => audit.confirm()).toThrow("实际网络请求");
  emit(query("&serverid=33"));
  expect(audit.confirm().restrictions.serverid).toBe("33");
  emit(query("&serverid=34"));
  expect(() => audit.confirm()).toThrow("单服");
  audit.begin("overall_search_pet", 2);
  emit(query("&serverid=33"));
  expect(() => audit.confirm()).toThrow("实际网络请求");
  emit(query("&serverid=33").replace("page=1", "page=2"));
  expect(audit.confirm().page).toBe(2);
  audit.close();
  expect(page.listenerCount("request")).toBe(0);
});
function scopePage(
  options: { missing?: boolean; wrongSelection?: boolean; missingServerOption?: boolean } = {},
) {
  const area = { value: "", options: [{ value: "" }, { value: "1" }, { value: "2" }] };
  const server = { value: "", options: [{ value: "" }] as { value: string }[] };
  vi.stubGlobal("window", {
    server_data: { "1": [["一区", ""], [[11, "甲", 0]]], "2": [["二区", ""], [[33, "乙", 0]]] },
  });
  vi.stubGlobal("document", {
    getElementById: (id: string) =>
      id === "overall_sel_area" ? area : id === "ovarall_sel_server" ? server : null,
  });
  const selections: string[] = [];
  const page = {
    evaluate: async (fn: Function, arg: unknown) => fn(arg),
    waitForFunction: async (fn: Function, arg: unknown) => {
      if (!fn(arg)) throw new Error("服务器选项未加载");
    },
    locator: (id: string) => ({
      selectOption: async (value: string) => {
        selections.push(id + ":" + value);
        if (id === "#overall_sel_area") {
          area.value = value;
          server.value = "";
          server.options = options.missingServerOption
            ? [{ value: "" }]
            : [{ value: "" }, { value: "33" }];
        } else server.value = options.wrongSelection ? "11" : value;
      },
    }),
  } as unknown as Page;
  if (options.missing) vi.stubGlobal("window", { server_data: {} });
  return { page, selections };
}
it("按官网公开目录选大区再选目标服务器并回读，不依赖登录服", async () => {
  const { page, selections } = scopePage();
  await expect(selectMarketServer(page, "33", new AbortController().signal)).resolves.toMatchObject(
    { areaId: "2", serverid: "33" },
  );
  expect(selections).toEqual(["#overall_sel_area:2", "#ovarall_sel_server:33"]);
});
it.each([{ missing: true }, { missingServerOption: true }, { wrongSelection: true }])(
  "目录或实际选服失败不得继续查询 %j",
  async (options) => {
    const { page } = scopePage(options);
    await expect(selectMarketServer(page, "33", new AbortController().signal)).rejects.toThrow();
  },
);
it("取消选服时不操作页面", async () => {
  const { page, selections } = scopePage();
  const control = new AbortController();
  control.abort(new Error("已暂停"));
  await expect(selectMarketServer(page, "33", control.signal)).rejects.toThrow("已暂停");
  expect(selections).toEqual([]);
});
