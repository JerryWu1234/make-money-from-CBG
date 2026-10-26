import { useEffect, useState } from "react";
import type { OpenCbgResult } from "../server/types";
import type { BrowserMode } from "./BrowserSettings";

const browserNames = { dedicated: "项目专用浏览器", daily: "日常 Chrome" };

export function BrowserLogin({
  result,
  activeMode,
  unavailable,
}: {
  result: OpenCbgResult;
  activeMode: BrowserMode;
  unavailable: boolean;
}) {
  const [selectedMode, setSelectedMode] = useState<BrowserMode>();
  // Per-browser states own their QR codes; the combined state repeats its primary browser.
  const states = result.browsers?.length
    ? result.browsers
    : [{ ...result, mode: result.activeBrowserMode || activeMode }];
  const waiting = states.filter(
    (state) =>
      state.connected && state.needLogin && !state.isLoggedIn && !state.error && state.qrCodeUrl,
  );
  const current =
    waiting.find((state) => state.mode === selectedMode) ||
    waiting.find((state) => state.mode === activeMode) ||
    waiting[0];
  const currentMode = current?.mode;
  useEffect(() => setSelectedMode(currentMode), [currentMode]);
  if (unavailable || !current) return null;

  return (
    <section className="qr-hero-section" aria-label="扫码登录">
      <strong>{browserNames[current.mode]}：扫码登录</strong>
      {waiting.length > 1 && (
        <div className="qr-browser-choices" role="group" aria-label="选择登录浏览器">
          {waiting.map((state) => (
            <button
              key={state.mode}
              type="button"
              className="btn-secondary"
              aria-pressed={state.mode === current.mode}
              onClick={() => setSelectedMode(state.mode)}
            >
              {browserNames[state.mode]}
            </button>
          ))}
        </div>
      )}
      <p className="qr-subtitle">使用网易大神或将军令扫码</p>
      <div className="qr-image-wrapper">
        <img
          className="qr-image-main"
          src={current.qrCodeUrl}
          alt={`${current.mode === "dedicated" ? "专用浏览器" : "日常 Chrome"}登录二维码`}
        />
      </div>
      <p className="status-note">
        手机确认后，请等待角色列表加载。
        {waiting.length > 1 && "当前浏览器登录完成后，会自动显示下一个待登录浏览器。"}
      </p>
    </section>
  );
}
