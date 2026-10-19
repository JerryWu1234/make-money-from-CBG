import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AiConnectionStatus,
  AiModelOptions,
  AiProvider,
  AiStatus,
  CodexLogin,
} from "../server/ai/types";

const names = { codex: "Codex", deepseek: "DeepSeek" };
const initialStatus: AiStatus = {
  codex: { state: "login_required" },
  deepseek: { state: "unconfigured", model: "deepseek-flash" },
  deepseekModels: [],
};

async function aiRequest<T>(
  path: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    ...(body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
    signal,
  });
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(result.error || "请求失败");
  return result;
}

export function AiConnectionControl({
  provider,
  onProviderChange,
  selectedModel,
  onModelChange,
  onDefaultModelChange,
  onStart,
  startLabel = "开始分析已有商品",
  disabled = false,
  locked = false,
}: {
  provider: AiProvider;
  onProviderChange: (provider: AiProvider) => void;
  selectedModel: string;
  onModelChange: (model: string) => void;
  onDefaultModelChange: (provider: AiProvider, model: string | null) => void;
  onStart: (provider: AiProvider) => Promise<void>;
  startLabel?: string;
  disabled?: boolean;
  locked?: boolean;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [loading, setLoading] = useState(true);
  const [modelOptions, setModelOptions] = useState<AiModelOptions | null>(null);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [step, setStep] = useState<
    "confirm" | "starting_login" | "login" | "verifying" | "error" | null
  >(null);
  const [login, setLogin] = useState<CodexLogin | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("deepseek-flash");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const operation = useRef(0);
  const verification = useRef<AbortController | null>(null);
  const loginId = useRef<string | null>(null);
  const popup = useRef<Window | null>(null);
  const startAfterConnect = useRef(false);
  const startCallback = useRef(onStart);
  startCallback.current = onStart;
  const current = status[provider];
  const busy = step === "starting_login" || step === "login" || step === "verifying";
  const availableModels = modelOptions?.provider === provider ? modelOptions : null;
  const defaultModel = availableModels?.models.find(
    (item) => item.id === availableModels.defaultModel,
  );

  useEffect(() => {
    const controller = new AbortController();
    void aiRequest<AiStatus>("/api/ai/status", undefined, controller.signal)
      .then((result) => {
        setStatus(result);
        setModel(result.deepseek.model || "deepseek-flash");
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setNotice(failure instanceof Error ? failure.message : "读取连接状态失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (loading) return;
    const controller = new AbortController();
    setModelOptions(null);
    setModelsLoading(true);
    setModelsError(null);
    void aiRequest<AiModelOptions>(
      `/api/ai/models?provider=${provider}`,
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) {
          setModelOptions(result);
          onDefaultModelChange(result.provider, result.defaultModel);
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setModelsError(failure instanceof Error ? failure.message : "读取模型列表失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setModelsLoading(false);
      });
    return () => controller.abort();
  }, [
    provider,
    loading,
    current.state,
    current.account?.email,
    current.model,
    onDefaultModelChange,
  ]);

  const cancel = useCallback(() => {
    startAfterConnect.current = false;
    operation.current++;
    verification.current?.abort();
    if (loginId.current) {
      void aiRequest("/api/ai/login/cancel", { loginId: loginId.current }).catch(() => {});
      loginId.current = null;
    }
    popup.current?.close();
    popup.current = null;
    setLogin(null);
    setApiKey("");
    setStep(null);
    setNotice("已取消连接验证。");
  }, []);

  useEffect(
    () => () => {
      operation.current++;
      verification.current?.abort();
      popup.current?.close();
      if (loginId.current)
        void aiRequest("/api/ai/login/cancel", { loginId: loginId.current }).catch(() => {});
    },
    [],
  );

  useEffect(() => {
    if (!step) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [step, cancel]);

  const startLogin = useCallback(async () => {
    const id = ++operation.current;
    // Open during the click so browser popup protection does not block the OAuth page.
    popup.current = window.open("about:blank", "cbg-codex-login");
    if (popup.current) popup.current.opener = null;
    setStep("starting_login");
    setError(null);
    try {
      const result = await aiRequest<CodexLogin>("/api/ai/login/start", { provider: "codex" });
      if (operation.current !== id) {
        void aiRequest("/api/ai/login/cancel", { loginId: result.loginId }).catch(() => {});
        return;
      }
      loginId.current = result.loginId;
      setLogin(result);
      setStep("login");
      if (popup.current && !popup.current.closed) popup.current.location.href = result.authUrl;
    } catch (failure) {
      if (operation.current !== id) return;
      popup.current?.close();
      setError(failure instanceof Error ? failure.message : "打开 ChatGPT 登录失败");
      setStep("error");
    }
  }, []);

  const verify = useCallback(
    async (selectedProvider: AiProvider, key?: string, selectedModel?: string) => {
      const id = ++operation.current;
      const controller = new AbortController();
      verification.current = controller;
      setStep("verifying");
      setError(null);
      setNotice(null);
      try {
        const result = await aiRequest<AiConnectionStatus>(
          "/api/ai/verify",
          {
            provider: selectedProvider,
            ...(selectedProvider === "deepseek" ? { apiKey: key, model: selectedModel } : {}),
          },
          controller.signal,
        );
        if (operation.current !== id) return;
        setStatus((previous) => ({ ...previous, [selectedProvider]: result }));
        if (result.state === "connected") {
          setApiKey("");
          setStep(null);
          setNotice(`${names[selectedProvider]} 连接成功，测试回复：${result.response}。`);
          if (startAfterConnect.current) {
            startAfterConnect.current = false;
            void startCallback.current(selectedProvider);
          }
        } else if (result.state === "login_required") {
          setStep("confirm");
          setError("请先登录 ChatGPT，再验证连接。");
        } else {
          setError(result.error || "连接验证失败，请重试");
          setStep("error");
        }
      } catch (failure) {
        if (operation.current !== id) return;
        setStatus((previous) => ({
          ...previous,
          [selectedProvider]: {
            ...previous[selectedProvider],
            state: "error",
            response: undefined,
            verifiedAt: undefined,
          },
        }));
        setError(failure instanceof Error ? failure.message : "连接验证失败");
        setStep("error");
      } finally {
        if (verification.current === controller) verification.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    if (step !== "login" || !login) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await aiRequest<CodexLogin>(
          `/api/ai/login/status?loginId=${encodeURIComponent(login.loginId)}`,
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (result.state === "completed") {
          loginId.current = null;
          popup.current?.close();
          popup.current = null;
          setLogin(null);
          void verify("codex");
        } else if (result.state !== "pending") {
          loginId.current = null;
          popup.current?.close();
          setError(result.error || "登录已取消，请重新登录");
          setStep("error");
        } else timer = setTimeout(() => void poll(), 1000);
      } catch (failure) {
        if (controller.signal.aborted) return;
        setError(failure instanceof Error ? failure.message : "读取登录进度失败");
        setStep("error");
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [step, login, verify]);

  const openSettings = () => {
    setError(null);
    setNotice(null);
    setModel(status.deepseek.model || "deepseek-flash");
    setStep("confirm");
  };
  const stateText = loading
    ? "正在检查本机连接…"
    : current.state === "connected"
      ? `已连接 · 真实回复 ${current.response}`
      : current.state === "configured"
        ? provider === "codex"
          ? "已登录 ChatGPT"
          : "已配置 API Key"
        : current.state === "error"
          ? current.error || "连接失败 · 可重试"
          : current.state === "verifying"
            ? "正在验证连接…"
            : provider === "codex"
              ? "未连接 · 使用 ChatGPT 登录"
              : "未连接 · 首次填写 API Key";

  return (
    <>
      <div className="analysis-agent-control">
        <div className="analysis-agent-heading">
          <label htmlFor="analysis-agent-select">分析 Agent</label>
          <span>选择本次使用的 AI</span>
        </div>
        <select
          id="analysis-agent-select"
          value={provider}
          disabled={busy || locked}
          onChange={(event) => {
            onProviderChange(event.target.value as AiProvider);
            setNotice(null);
            setError(null);
            setStep(null);
            setApiKey("");
          }}
        >
          <option value="codex">Codex · ChatGPT 订阅</option>
          <option value="deepseek">DeepSeek · API</option>
        </select>
        <small>
          {provider === "codex"
            ? "使用你的 ChatGPT 账号和 Codex 订阅额度。"
            : "使用你的 DeepSeek API Key，按 DeepSeek API 用量计费。"}
        </small>
        <div className="analysis-agent-heading">
          <label htmlFor="analysis-model-select">分析模型</label>
          <span>默认或手动选择</span>
        </div>
        <select
          id="analysis-model-select"
          value={selectedModel}
          disabled={loading || modelsLoading || busy || locked}
          onChange={(event) => onModelChange(event.target.value)}
        >
          <option value="">
            默认模型
            {modelsLoading
              ? " · 正在读取…"
              : availableModels?.defaultModel
                ? ` · ${defaultModel?.name || availableModels.defaultModel}`
                : provider === "codex" && current.state === "login_required"
                  ? " · 登录后读取"
                  : " · 跟随当前配置"}
          </option>
          {selectedModel && !availableModels?.models.some((item) => item.id === selectedModel) && (
            <option value={selectedModel}>{selectedModel}</option>
          )}
          {availableModels?.models.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <small>
          {provider === "codex"
            ? "新分析默认使用 Luna · Max · Fast；手动选择的模型用于下次分析。"
            : "默认沿用当前配置；手动选择的模型用于下次分析。"}
        </small>
        {modelsError && (
          <small className="analysis-auth-notice" role="status">
            {modelsError}。可以使用默认模型，或在连接设置中重新连接。
          </small>
        )}
        <div className="analysis-agent-account" role="status">
          <span className={`analysis-auto-dot ${current.state === "connected" ? "" : "is-idle"}`} />
          {stateText}
        </div>
        {current.account && (
          <small>
            {current.account.email || "ChatGPT 账号"}
            {current.account.plan ? ` · ${current.account.plan}` : ""}
          </small>
        )}
        {notice && (
          <small className="analysis-auth-notice" role="status">
            {notice}
          </small>
        )}
        <div className="analysis-hero-actions">
          <button
            type="button"
            className="analysis-button analysis-button-primary"
            disabled={loading || busy || disabled}
            onClick={() => {
              if (current.state === "connected" || current.state === "configured")
                void onStart(provider);
              else {
                startAfterConnect.current = true;
                openSettings();
              }
            }}
          >
            {busy ? "正在连接…" : startLabel} <span aria-hidden="true">→</span>
          </button>
          <button
            type="button"
            className="analysis-button analysis-button-quiet"
            disabled={loading || busy || locked}
            onClick={() => {
              startAfterConnect.current = false;
              openSettings();
            }}
          >
            连接设置
          </button>
        </div>
        <small>每件商品的完整资料一次提交；结果保存后处理下一件。</small>
      </div>
      {step && (
        <div className="analysis-overlay">
          <section
            className="analysis-auth-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="analysis-auth-title"
          >
            <span className="analysis-kicker">
              {provider === "codex" ? "CHATGPT / 订阅连接" : "DEEPSEEK / API 连接"}
            </span>
            <h2 id="analysis-auth-title">
              {step === "verifying"
                ? `正在验证 ${names[provider]}`
                : step === "starting_login"
                  ? "正在打开 ChatGPT 登录"
                  : step === "login"
                    ? "请在官方页面完成登录"
                    : step === "error"
                      ? `${names[provider]} 连接未完成`
                      : provider === "codex"
                        ? "连接你的 ChatGPT 订阅"
                        : "连接 DeepSeek"}
            </h2>
            {step === "confirm" && provider === "codex" && (
              <>
                <p>
                  {current.account
                    ? "检测到本机已有 ChatGPT 登录，可以直接验证 Codex SDK 是否可用。"
                    : "点击登录后会打开 OpenAI 官方页面。完成登录后，这里会自动验证 Codex SDK。"}
                </p>
                {current.account && (
                  <div className="analysis-auth-info">
                    <span>当前账号</span>
                    <strong>
                      {current.account.email || "ChatGPT 账号"} ·{" "}
                      {current.account.plan || "计划待确认"}
                    </strong>
                  </div>
                )}
              </>
            )}
            {step === "confirm" && provider === "deepseek" && (
              <form
                id="deepseek-connect"
                onSubmit={(event) => {
                  event.preventDefault();
                  void verify("deepseek", apiKey, model);
                }}
              >
                <p>首次填写 API Key；验证成功后保存在本机，下次可以直接使用。</p>
                <label className="analysis-auth-field">
                  API Key
                  <input
                    type="password"
                    value={apiKey}
                    autoComplete="off"
                    maxLength={1024}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={
                      current.state === "unconfigured"
                        ? "粘贴 DeepSeek API Key"
                        : "留空使用已配置的 Key"
                    }
                    required={current.state === "unconfigured"}
                  />
                </label>
                <label className="analysis-auth-field">
                  连接默认模型
                  <select value={model} onChange={(event) => setModel(event.target.value)}>
                    {status.deepseekModels.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <a
                  className="analysis-auth-link"
                  href="https://platform.deepseek.com/api_keys"
                  target="_blank"
                  rel="noreferrer"
                >
                  打开 DeepSeek 获取 API Key ↗
                </a>
              </form>
            )}
            {step === "starting_login" && <p>正在准备官方登录页面，请稍候。</p>}
            {step === "login" && login && (
              <>
                <p>在 OpenAI 官方页面登录你的 ChatGPT 账号。完成后本页会自动验证连接。</p>
                <a
                  className="analysis-auth-link"
                  href={login.authUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  打开登录页面 ↗
                </a>
                <p className="analysis-auth-note">若浏览器没有自动打开，可以点击上方链接。</p>
              </>
            )}
            {step === "verifying" && (
              <p>
                通过 {provider === "codex" ? "官方 Codex SDK" : "Pi Agent SDK"}{" "}
                发送固定测试语句，等待真实回复。
              </p>
            )}
            {error && (
              <p className="analysis-auth-preview-note" role="alert">
                {error}
              </p>
            )}
            <p className="analysis-auth-preview-note">
              连接验证使用固定测试语句，回复应为 READY。连接完成后可开始商品分析。
            </p>
            <div className="analysis-auth-actions">
              <button
                type="button"
                className="analysis-button analysis-button-quiet"
                onClick={cancel}
              >
                {busy ? "取消连接" : "关闭"}
              </button>
              {step === "confirm" &&
                (provider === "deepseek" ? (
                  <button
                    type="submit"
                    form="deepseek-connect"
                    className="analysis-button analysis-button-primary"
                  >
                    保存并验证
                  </button>
                ) : (
                  <button
                    type="button"
                    className="analysis-button analysis-button-primary"
                    onClick={() => (current.account ? void verify("codex") : void startLogin())}
                  >
                    {current.account ? "验证连接" : "登录 ChatGPT"}
                  </button>
                ))}
              {step === "error" && (
                <>
                  {provider === "codex" && (
                    <button
                      type="button"
                      className="analysis-button analysis-button-quiet"
                      onClick={() => void startLogin()}
                    >
                      登录 ChatGPT
                    </button>
                  )}
                  <button
                    type="button"
                    className="analysis-button analysis-button-primary"
                    onClick={() =>
                      provider === "deepseek" ? setStep("confirm") : void verify("codex")
                    }
                  >
                    {provider === "deepseek" ? "修改配置并重试" : "重新验证"}
                  </button>
                </>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
