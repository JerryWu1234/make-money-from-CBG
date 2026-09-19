import { describe, expect, it } from "vite-plus/test";
import { buildPageState, disconnectedState, type PageSnapshot } from "./page-state";
import { loginProgress, normalizeBrowserState } from "../src/browser-state";

const snapshot: PageSnapshot = {
  url: "https://xyq.cbg.163.com/",
  title: "藏宝阁",
  ready: true,
  hasLogout: false,
  hasLogin: false,
  hasQr: false,
  hasRoles: false,
  hasDialog: false,
  serverName: "",
};

describe("登录状态回归", () => {
  it("服务端明确未登录时，残留退出入口和账号不能覆盖当前状态", () => {
    const state = buildPageState({
      ...snapshot,
      serverAuthenticated: false,
      hasLogout: true,
      nickname: "旧角色",
    });
    expect(state).toMatchObject({ isLoggedIn: false, needLogin: true, loginStatus: "logged_out" });
    expect(state).not.toHaveProperty("nickname");
  });
  it("服务端确认登录后，通用登录入口不会导致误报失败", () => {
    expect(
      buildPageState({
        ...snapshot,
        serverAuthenticated: true,
        hasLogin: true,
        selectedRoleId: "current-role",
      }),
    ).toMatchObject({ isLoggedIn: true, selectedRoleId: "current-role" });
  });
  it("服务端登录标记存在但仍在角色选择页时，继续等待确认", () => {
    expect(
      buildPageState({ ...snapshot, serverAuthenticated: true, hasRoles: true }).isLoggedIn,
    ).toBe(false);
  });
  it.each([
    "https://xyq.cbg.163.com/cgi-bin/query.py?act=recommend_search",
    "https://xyq.cbg.163.com/cgi-bin/message.py",
    "https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py",
    "https://xyq.cbg.163.com/cgi-bin/equipquery.py?server_id=6",
  ])("公开网址不能证明已登录: %s", (url) => {
    const result = buildPageState({
      ...snapshot,
      url,
      accountUrs: "old@example.test",
      nickname: "历史昵称",
    });
    expect(result.isLoggedIn).toBe(false);
    expect(result.loginStatus).toBe("unknown");
    expect(result).not.toHaveProperty("accountUrs");
    expect(result).not.toHaveProperty("nickname");
  });
  it.each(["hasLogin", "hasQr", "hasRoles", "hasDialog"] as const)(
    "未完成登录时优先处理 %s",
    (field) => {
      const result = buildPageState({
        ...snapshot,
        hasLogout: true,
        [field]: true,
        accountUrs: "old@example.test",
      });
      expect(result).toMatchObject({
        isLoggedIn: false,
        needLogin: true,
        loginStatus: "logged_out",
      });
      expect(result).not.toHaveProperty("accountUrs");
    },
  );
  it("登录页上残留退出入口也不能显示登录成功", () => {
    expect(
      buildPageState({
        ...snapshot,
        hasLogout: true,
        url: "https://xyq.cbg.163.com/cgi-bin/show_login.py?server_id=6",
      }).isLoggedIn,
    ).toBe(false);
  });
  it("角色选择提交后仍需页面确认", () => {
    const result = buildPageState(
      { ...snapshot, hasRoles: true },
      { roleSelected: true, selectedRoleId: "123" },
    );
    expect(result).toMatchObject({ isLoggedIn: false, step: "entering_server" });
    expect(result).not.toHaveProperty("selectedRoleId");
  });
  it("可见的已登录界面才显示当前身份", () => {
    expect(
      buildPageState({ ...snapshot, hasLogout: true, accountUrs: "current@example.test" }),
    ).toMatchObject({
      isLoggedIn: true,
      needLogin: false,
      loginStatus: "logged_in",
      accountUrs: "current@example.test",
    });
  });
  it("页面加载中和非藏宝阁页面不能确认登录", () => {
    expect(buildPageState({ ...snapshot, ready: false, hasLogout: true }).isLoggedIn).toBe(false);
    expect(
      buildPageState({
        ...snapshot,
        url: "https://example.test/?next=cbg.163.com",
        hasLogout: true,
      }).isLoggedIn,
    ).toBe(false);
  });
  it("断开连接不等于已登录，也不显示已授权", () => {
    const state = disconnectedState("连接失败");
    expect(state).toMatchObject({
      connected: false,
      needLogin: false,
      isLoggedIn: false,
      loginStatus: "unknown",
    });
    expect(loginProgress(state)).toEqual({
      qrDone: false,
      dialogDone: false,
      roleDone: false,
      serverReady: false,
    });
    expect(loginProgress(null).qrDone).toBe(false);
  });
  it("前端移除未登录响应内的残留身份", () => {
    const state = normalizeBrowserState({
      ...disconnectedState("未连接"),
      accountUrs: "old@example.test",
      nickname: "old",
      selectedRoleId: "123",
      isLoggedIn: true,
      step: "logged_in",
    });
    expect(state).not.toHaveProperty("accountUrs");
    expect(state).not.toHaveProperty("nickname");
    expect(state).not.toHaveProperty("selectedRoleId");
    expect(state).toMatchObject({ isLoggedIn: false, step: "idle" });
  });
});
