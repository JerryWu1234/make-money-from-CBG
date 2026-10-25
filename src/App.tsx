import { useState, useEffect, useCallback, useRef } from "react";
import type { OpenCbgResult, WorkflowStep } from "../server/types";
import { normalizeBrowserState } from "./browser-state";
import "./style.css";
import { CrawlPanel } from "./CrawlPanel";
import { BrowserSettings, type BrowserMode } from "./BrowserSettings";

const FLOW: [WorkflowStep, string][] = [
  ["logging_in", "扫码登录"],
  ["cross_server", "跨服购买"],
  ["server_age", "3年以上服"],
  ["role_list", "角色列表"],
];
const ORDER: WorkflowStep[] = [
  "idle",
  "connecting",
  "logging_in",
  "cross_server",
  "server_age",
  "role_search",
  "role_list",
  "completed",
];

export function App() {
  const [result, setResult] = useState<OpenCbgResult | null>(null);
  const [transportError, setTransportError] = useState<string | null>(null);
  const [crawling, setCrawling] = useState(false);
  const [starting, setStarting] = useState(false);
  const [browserMode, setBrowserMode] = useState<BrowserMode>("dedicated");
  const [browserSettingsBusy, setBrowserSettingsBusy] = useState(true);
  const browserSettingsBusyRef = useRef(true);
  const active = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const startingRef = useRef(false);
  const setSettingsBusy = useCallback((busy: boolean) => {
    browserSettingsBusyRef.current = busy;
    setBrowserSettingsBusy(busy);
  }, []);

  const request = useCallback(async (start = false) => {
    if (start && browserSettingsBusyRef.current) return;
    if (startingRef.current || (!start && active.current)) return;
    const id = ++sequence.current;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    if (start) {
      startingRef.current = true;
      setStarting(true);
    }
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(start ? "/api/browser/open" : "/api/browser/status", {
        method: start ? "POST" : "GET",
        cache: "no-store",
        signal: controller.signal,
        ...(start ? { headers: { "Content-Type": "application/json" }, body: "{}" } : {}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "服务请求失败");
      if (id !== sequence.current) return;
      setResult(normalizeBrowserState(data as OpenCbgResult));
      setTransportError(null);
    } catch (error) {
      if (id !== sequence.current) return;
      setTransportError(
        controller.signal.aborted
          ? "状态读取超时，正在重新连接本地服务…"
          : error instanceof Error
            ? error.message
            : "本地服务暂时不可用",
      );
      // 保留流程说明，去除无法再确认的身份；下一次轮询成功后自动恢复。
      setResult((previous) =>
        previous
          ? normalizeBrowserState({
              ...previous,
              isLoggedIn: false,
              loginStatus: "unknown",
              roleList: undefined,
            })
          : null,
      );
    } finally {
      clearTimeout(timer);
      if (id === sequence.current) {
        active.current = null;
        startingRef.current = false;
        setStarting(false);
      }
    }
  }, []);

  const browserModeSaved = useCallback(
    async (mode: BrowserMode) => {
      setBrowserMode(mode);
      // A response from the previous browser must never restore its ready state.
      ++sequence.current;
      active.current?.abort();
      active.current = null;
      startingRef.current = false;
      setStarting(false);
      setResult(null);
      setTransportError(null);
      await request();
    },
    [request],
  );

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await request();
      if (!disposed) timer = setTimeout(() => void poll(), 1200);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      ++sequence.current;
      active.current?.abort();
      active.current = null;
      startingRef.current = false;
    };
  }, [request]);

  const step = result?.workflowStep || "idle";
  const running = result?.running === true;
  const completed = step === "completed" && !transportError;
  const stepIndex = ORDER.indexOf(step);

  return (
    <main className="container container-results">
      <div className="card">
        <header className="card-header">
          <div className="badge">
            {browserMode === "dedicated"
              ? "项目专用浏览器 · 保存登录状态"
              : "在本页完成 · 复用日常浏览器登录状态"}
          </div>
          <h1 className="title">藏宝阁角色查询</h1>
          <p className="subtitle">扫码登录后，自动进入跨服购买，选择3年以上服并加载角色列表。</p>
          <a className="analysis-preview-entry" href="/analysis-preview">
            进入商品分析 <span aria-hidden="true">↗</span>
          </a>
        </header>
        <BrowserSettings
          active={starting || running || crawling}
          onBusy={setSettingsBusy}
          onMode={setBrowserMode}
          onSaved={browserModeSaved}
        />
        <section className="workflow-stepper" aria-label="角色查询流程">
          {FLOW.map(([key, label]) => {
            const done = completed || stepIndex > ORDER.indexOf(key);
            const selected =
              key === step ||
              (key === "logging_in" && step === "connecting") ||
              (key === "role_list" && step === "role_search");
            return (
              <div
                key={key}
                className={`step-item ${done ? "step-completed" : selected ? "step-active" : "step-pending"}`}
              >
                <div className="step-badge">
                  {done ? "✓" : FLOW.findIndex(([value]) => value === key) + 1}
                </div>
                <div className="step-info">
                  <span className="step-title">{label}</span>
                  <span className="step-desc">
                    {done ? "已完成" : selected ? "进行中" : "等待"}
                  </span>
                </div>
              </div>
            );
          })}
        </section>
        <button
          id="open-cbg-btn"
          className="btn-primary"
          disabled={browserSettingsBusy || starting || running || crawling}
          onClick={() => void request(true)}
        >
          {starting
            ? "正在开始…"
            : running
              ? "流程进行中"
              : step === "error"
                ? "重新尝试"
                : completed
                  ? "重新查询角色列表"
                  : "开始查询角色"}
        </button>
        <p className="status-note">
          {browserMode === "dedicated"
            ? "查询在项目专用浏览器中运行，本页显示二维码、进度与查询结果。"
            : result?.workPagesVisible
              ? "已开启原始工作页显示，可在 Chrome 窗口查看列表和详情；停止后保留页面供检查。"
              : "藏宝阁在隐藏工作页中运行，本页显示二维码、进度与查询结果。"}
          {browserMode === "dedicated"
            ? "使用项目专用浏览器保存登录；首次使用或登录过期时仍需扫码。"
            : "连接日常 Chrome 时，如有调试授权提示请允许；连接断开后重新连接可能再次提示。"}{" "}
          <a href="/api/logs/export" download="cbg-run-log.json">
            下载运行日志
          </a>
        </p>

        {transportError && (
          <div className="workflow-alert alert-info" role="status">
            {transportError}
          </div>
        )}
        {result && (
          <section
            className={`status-box ${result.error ? "status-error" : completed ? "status-success" : "status-loading"}`}
            aria-live="polite"
          >
            <div className="status-header-row">
              <strong>
                {result.error
                  ? "流程已暂停"
                  : completed
                    ? "角色列表已就绪"
                    : running
                      ? "正在处理"
                      : "准备就绪"}
              </strong>
              {result.isLoggedIn && !transportError && (
                <span className="login-pill pill-logged">已登录</span>
              )}
            </div>
            <p>
              {step === "connecting"
                ? browserMode === "dedicated"
                  ? "正在启动或连接项目专用浏览器…"
                  : "正在连接日常 Chrome，请留意浏览器的调试授权提示…"
                : result.message}
            </p>
            {result.error && <p className="error-message">错误编号：{result.error.code}</p>}
            {result.qrCodeUrl && !transportError && (
              <div className="qr-hero-section">
                <strong>使用网易大神或将军令扫码</strong>
                <div className="qr-image-wrapper">
                  <img src={result.qrCodeUrl} alt="藏宝阁登录二维码" className="qr-image-main" />
                </div>
                <p className="status-note">手机确认后，请在本页等待角色列表加载。</p>
              </div>
            )}
            {result.isLoggedIn && !transportError && (
              <div className="account-summary">
                {result.serverName !== "未指定服务器" && <span>服务器：{result.serverName}</span>}
                {result.nickname && <span>角色：{result.nickname}</span>}
              </div>
            )}
          </section>
        )}

        <CrawlPanel
          ready={!browserSettingsBusy && completed && result?.isLoggedIn === true && !running}
          onRunning={setCrawling}
          onPrepare={browserSettingsBusy ? undefined : () => request(true)}
          preparationError={starting || running ? null : transportError || result?.error?.message}
        />
      </div>
    </main>
  );
}
export default App;
