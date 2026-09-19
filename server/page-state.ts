import type { OpenCbgResult } from "./types";

export interface PageSnapshot {
  url: string;
  title: string;
  ready: boolean;
  hasLogout: boolean;
  serverAuthenticated?: boolean;
  selectedRoleId?: string;
  hasLogin: boolean;
  hasQr: boolean;
  hasRoles: boolean;
  hasDialog: boolean;
  serverName: string;
  accountUrs?: string;
  nickname?: string;
  qrCodeUrl?: string;
}

// 在页面中一次读取 URL 与可见 DOM，避免导航期间混用两页的状态。
export function readPageSnapshot(): PageSnapshot {
  const visible = (element: Element) =>
    element.checkVisibility({
      checkOpacity: true,
      checkVisibilityCSS: true,
    });
  const elements = (selector: string) =>
    Array.from(document.querySelectorAll(selector)).filter(visible);
  const text = (selector: string) => elements(selector)[0]?.textContent?.trim() || "";
  const hasLogout = elements('a[href*="act=logout"]').length > 0;
  const hasQr = elements("#qrcode").length > 0;
  const hasRoles = elements('li[id^="role_el_"], .js_role_el_img').length > 0;
  const hasDialog = elements(".popupDialog, .dialogWrap").some(
    (el) => el.textContent?.includes("其他服务器") && el.textContent.includes("我知道了"),
  );
  const hasLogin =
    elements('a[href*="show_login.py"], input[type="password"]').length > 0 ||
    (elements("#loginContainer").length > 0 && !hasRoles && !hasDialog);
  const qrImg = elements("#qrcode img")[0] as HTMLImageElement | undefined;
  const qrCanvas = elements("#qrcode canvas")[0] as HTMLCanvasElement | undefined;
  let qrCodeUrl = qrImg?.src.startsWith("data:image/") ? qrImg.src : undefined;
  if (!qrCodeUrl && qrCanvas?.width && qrCanvas.height) {
    try {
      qrCodeUrl = qrCanvas.toDataURL("image/png");
    } catch {
      /* 等待页面重新生成 */
    }
  }

  // 官方页面由服务端注入 IsLogin / LoginInfo；不使用历史 Cookie 判断身份。
  const globals = window as Window & {
    IsLogin?: number | boolean;
    LoginInfo?: {
      login?: number | boolean;
      nickname?: string;
      urs?: string;
      roleid?: string | number;
      server_name?: string;
    };
  };
  const info = globals.LoginInfo;
  const serverAuthenticated =
    globals.IsLogin === 0 || globals.IsLogin === false || info?.login === 0 || info?.login === false
      ? false
      : globals.IsLogin === 1 ||
          globals.IsLogin === true ||
          info?.login === 1 ||
          info?.login === true
        ? true
        : undefined;
  return {
    url: location.href,
    title: document.title,
    ready: document.readyState !== "loading",
    hasLogout,
    serverAuthenticated,
    hasLogin,
    hasQr,
    hasRoles,
    hasDialog,
    serverName: text("#server_name_info") || (serverAuthenticated ? info?.server_name || "" : ""),
    accountUrs: serverAuthenticated && typeof info?.urs === "string" ? info.urs : undefined,
    nickname: serverAuthenticated && typeof info?.nickname === "string" ? info.nickname : undefined,
    selectedRoleId: serverAuthenticated && info?.roleid != null ? String(info.roleid) : undefined,
    qrCodeUrl,
  };
}

export interface WorkflowMeta {
  dialogDetected?: boolean;
  dialogDismissed?: boolean;
  roleDetected?: boolean;
  roleSelected?: boolean;
  selectedRoleId?: string;
}

export function buildPageState(snapshot: PageSnapshot, meta: WorkflowMeta = {}): OpenCbgResult {
  const url = new URL(snapshot.url);
  const isCbg = url.origin === "https://xyq.cbg.163.com";
  const loginPage = /\/(?:show_login|login)\.py$/.test(url.pathname);
  const rolePage = url.searchParams.get("act") === "show_role_select_page";
  const incompleteLogin =
    (snapshot.hasLogin && snapshot.serverAuthenticated !== true) ||
    snapshot.hasQr ||
    snapshot.hasRoles ||
    snapshot.hasDialog ||
    loginPage ||
    rolePage;
  const isLoggedIn =
    isCbg &&
    snapshot.ready &&
    (snapshot.serverAuthenticated === true ||
      (snapshot.serverAuthenticated === undefined && snapshot.hasLogout)) &&
    !incompleteLogin;
  const needLogin =
    isCbg && snapshot.ready && (incompleteLogin || snapshot.serverAuthenticated === false);
  const serverName =
    snapshot.serverName || (loginPage ? url.searchParams.get("server_name") : "") || "未指定服务器";
  const step = isLoggedIn
    ? "logged_in"
    : !snapshot.ready
      ? "idle"
      : meta.roleSelected
        ? "entering_server"
        : snapshot.hasRoles || rolePage
          ? "selecting_role"
          : snapshot.hasDialog
            ? "dismissing_dialog"
            : snapshot.hasQr || loginPage
              ? "waiting_qr"
              : "idle";
  const message = isLoggedIn
    ? "当前藏宝阁页面已确认登录。"
    : step === "entering_server"
      ? "已提交角色选择，等待页面确认登录。"
      : step === "selecting_role"
        ? "检测到角色列表，等待选择角色并进入服务器。"
        : step === "dismissing_dialog"
          ? "检测到跨服角色提示，等待确认。"
          : needLogin
            ? "尚未完成登录，正在等待扫码或网站确认。"
            : "页面已打开，尚未确认登录状态。";
  return {
    connected: true,
    loginStatus: isLoggedIn ? "logged_in" : needLogin ? "logged_out" : "unknown",
    title: snapshot.title,
    url: snapshot.url,
    serverName,
    isLoggedIn,
    needLogin,
    message,
    step,
    dialogDetected: snapshot.hasDialog,
    dialogDismissed: meta.dialogDismissed,
    roleDetected: snapshot.hasRoles,
    roleSelected: meta.roleSelected,
    ...(needLogin && snapshot.hasQr && snapshot.qrCodeUrl ? { qrCodeUrl: snapshot.qrCodeUrl } : {}),
    ...(isLoggedIn && snapshot.accountUrs ? { accountUrs: snapshot.accountUrs } : {}),
    ...(isLoggedIn && snapshot.nickname ? { nickname: snapshot.nickname } : {}),
    // 不回填 last_login_roleid 等历史角色资料。
    ...(isLoggedIn && snapshot.selectedRoleId ? { selectedRoleId: snapshot.selectedRoleId } : {}),
  };
}

export function disconnectedState(message: string): OpenCbgResult {
  return {
    connected: false,
    loginStatus: "unknown",
    title: "",
    url: "",
    serverName: "未连接",
    isLoggedIn: false,
    needLogin: false,
    message,
    step: "idle",
  };
}
