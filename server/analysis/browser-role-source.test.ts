import type { Page, Request } from "playwright-core";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  assertRoleGlobalScope,
  clickRoleSearchPage,
  createRoleScopeAudit,
  roleRequestObservation,
  validateRoleSelections,
  type RoleSearchForm,
} from "./browser-role-source";
const form: RoleSearchForm = {
  url: "https://xyq.cbg.163.com/",
  action: "https://xyq.cbg.163.com/cgi-bin/equipquery.py",
  method: "post",
  act: "observed-fixture-act",
  controls: [{ id: "observed-grade", name: "", type: "text", label: "等级", value: "" }],
  menus: [
    {
      id: "observed-school",
      label: "门派",
      choices: [{ value: "observed-id", label: "神木林", selected: false }],
    },
  ],
};
describe("角色查询字段与范围证据", () => {
  it("官网分页链接不存在时不调用函数替代UI", async () => {
    const evaluate = vi.fn();
    const click = vi.fn();
    const link = { count: vi.fn().mockResolvedValue(0), click };
    const page = { locator: vi.fn(() => ({ first: () => link })), evaluate } as unknown as Page;
    await expect(clickRoleSearchPage(page, 2)).rejects.toThrow("没有可观察的分页链接");
    expect(click).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });
  it("分页只点击对应官网链接，读取响应另行逐页核验", async () => {
    const click = vi.fn().mockResolvedValue(undefined);
    const locator = vi.fn(() => ({ first: () => ({ count: async () => 1, click }) }));
    const page = {
      locator,
    } as unknown as Page;
    await clickRoleSearchPage(page, 3);
    expect(locator).toHaveBeenCalledWith('#pager_bar a[href="javascript:goto(3)"]');
    expect(click).toHaveBeenCalledWith({ timeout: 5000 });
  });
  it("只采用发现过的控件和选项，不猜门派ID", () => {
    expect(() =>
      validateRoleSelections(form, {
        controls: [{ id: "observed-grade", value: "89" }],
        menus: [{ id: "observed-school", value: "observed-id" }],
      }),
    ).not.toThrow();
    expect(() =>
      validateRoleSelections(form, { controls: [{ id: "level_min", value: "89" }], menus: [] }),
    ).toThrow("未确认");
    expect(() =>
      validateRoleSelections(form, {
        controls: [],
        menus: [{ id: "observed-school", value: "13" }],
      }),
    ).toThrow("未确认");
  });
  it("实际表单POST的args JSON必须被解析并保留", () => {
    const result = roleRequestObservation(
      "https://xyq.cbg.163.com/cgi-bin/equipquery.py",
      new URLSearchParams({
        act: "observed-fixture-act",
        args: JSON.stringify({ server_type: "3", grade: 89 }),
      }).toString(),
    );
    expect(result).toMatchObject({
      act: "observed-fixture-act",
      args: { server_type: "3", grade: 89 },
    });
    expect(() => assertRoleGlobalScope(result!.args)).not.toThrow();
  });
  it.each([
    { server_type: "2" },
    { server_type: "1,3" },
    { server_type: "3", serverid: 33 },
    { server_type: "3", area_id: 1 },
    { server_type: "3", cross_buy: 1 },
  ])("实际请求限定范围 %j 时拒绝", (args) => {
    expect(() => assertRoleGlobalScope(args)).toThrow();
  });
  it.each([
    "server_type=2&server_type=3",
    "server_type=3&serverid=33&serverid=",
    "server_type=3&cross_buy_serverid=33",
    "server_type=3&area_list=1",
    "server_type=3&server_sn=123",
    "server_type=3&args=%7B%22server_type%22%3A%222%22%7D",
  ])("重复或附带限制不得折叠为全服 %s", (body) => {
    const result = roleRequestObservation("https://xyq.cbg.163.com/cgi-bin/equipquery.py", body);
    expect(() => assertRoleGlobalScope(result!.args)).toThrow();
  });
  it("每页绑定真实表单act和新请求，缺年龄/页码/错误act均拒绝", () => {
    let handler: ((request: Request) => void) | undefined;
    const page = {
      on: vi.fn((_event, callback) => {
        handler = callback;
      }),
      off: vi.fn(),
    } as unknown as Pick<Page, "on" | "off">;
    const audit = createRoleScopeAudit(page, form);
    const send = (body: string) =>
      handler!({
        url: () => form.action,
        postData: () => body,
        isNavigationRequest: () => body.includes("act=observed-fixture-act"),
        resourceType: () => (body.includes("act=observed-fixture-act") ? "document" : "xhr"),
      } as unknown as Request);
    audit.begin(1);
    send("act=observed-fixture-act&server_type=3");
    send("act=overall_search_role&server_type=3&page=1");
    expect(audit.confirm()).toMatchObject({ page: 1 });
    audit.begin(2);
    expect(() => audit.confirm()).toThrow("实际角色市场查询请求");
    audit.begin(2);
    send("act=overall_search_role&page=2");
    expect(() => audit.confirm()).toThrow("三年以上");
    audit.begin(2);
    send("act=overall_search_role&server_type=3");
    expect(() => audit.confirm()).toThrow("页码");
    audit.begin(2);
    send("act=wrong&search_type=overall_search_role&server_type=3&page=2");
    expect(() => audit.confirm()).toThrow("类别");
    audit.begin(2);
    send("act=overall_search_role&server_type=3&page=2");
    expect(audit.confirm()).toMatchObject({ page: 2 });
    audit.close();
    expect(page.off).toHaveBeenCalledOnce();
  });
  it("推荐角色真实JSON请求同样检查每页scope，表单导航不能单独证明报价", () => {
    let handler: ((request: Request) => void) | undefined;
    const page = {
      on: vi.fn((_event, callback) => {
        handler = callback;
      }),
      off: vi.fn(),
    } as unknown as Pick<Page, "on" | "off">;
    const audit = createRoleScopeAudit(page, form);
    const send = (body: string, navigation = false) =>
      handler!({
        url: () => (navigation ? form.action : "https://xyq.cbg.163.com/cgi-bin/recommend.py"),
        postData: () => body,
        isNavigationRequest: () => navigation,
        resourceType: () => (navigation ? "document" : "fetch"),
      } as unknown as Request);
    audit.begin(1);
    send("act=observed-fixture-act&server_type=3", true);
    expect(() => audit.confirm()).toThrow("实际角色市场查询请求");
    send(
      JSON.stringify({
        act: "recommd_by_role",
        search_type: "overall_search_role",
        server_type: "3",
        page: 1,
        private_token: "do-not-export",
      }),
    );
    const evidence = audit.confirm();
    expect(evidence.marketRequests).toHaveLength(1);
    expect(JSON.stringify(evidence)).not.toContain("do-not-export");
    audit.begin(2);
    send("act=overall_search_role&server_type=3&page=2&args=%7B");
    send("act=overall_search_role&server_type=3&page=2");
    expect(() => audit.confirm()).toThrow("无法解析");
    audit.close();
  });
  it("坏JSON、非官网请求与缺server_type不变成有效范围", () => {
    expect(roleRequestObservation("https://example.org/", "args={}")).toBeNull();
    expect(roleRequestObservation("https://xyq.cbg.163.com/", "args=%7B")).toBeNull();
    expect(() => assertRoleGlobalScope({})).toThrow();
  });
});
