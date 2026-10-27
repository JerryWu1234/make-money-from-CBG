import type { OpenCbgResult } from "../server/types";

export function BrowserLogin({
  result,
  unavailable,
}: {
  result: OpenCbgResult;
  unavailable: boolean;
}) {
  if (
    unavailable ||
    !result.connected ||
    !result.needLogin ||
    result.isLoggedIn ||
    result.error ||
    !result.qrCodeUrl
  )
    return null;

  return (
    <section className="qr-hero-section" aria-label="扫码登录">
      <strong>扫码登录</strong>
      <p className="qr-subtitle">使用网易大神或将军令扫码</p>
      <div className="qr-image-wrapper">
        <img className="qr-image-main" src={result.qrCodeUrl} alt="登录二维码" />
      </div>
      <p className="status-note">手机确认后，请等待角色列表加载。有效登录会保存在所选浏览器中。</p>
    </section>
  );
}
