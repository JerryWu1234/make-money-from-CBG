import type { OpenCbgResult } from "../server/types";

export function normalizeBrowserState(result: OpenCbgResult): OpenCbgResult {
  if (result.connected && result.isLoggedIn && result.loginStatus === "logged_in") return result;
  const { accountUrs: _account, nickname: _nickname, selectedRoleId: _role, ...state } = result;
  return { ...state, isLoggedIn: false, step: state.step === "logged_in" ? "idle" : state.step };
}

export function loginProgress(result: OpenCbgResult | null) {
  const connected = result?.connected === true;
  const loggedIn = connected && result?.isLoggedIn === true && result.loginStatus === "logged_in";
  const step = connected ? result?.step : "idle";
  return {
    qrDone:
      loggedIn ||
      step === "dismissing_dialog" ||
      step === "selecting_role" ||
      step === "entering_server",
    dialogDone: loggedIn || (connected && result?.dialogDismissed === true),
    roleDone: loggedIn || (connected && result?.roleSelected === true),
    serverReady: loggedIn,
  };
}
