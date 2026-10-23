export type AiProvider = "codex" | "deepseek";
export type AnalysisRequestOptions = { bareRoleReview?: boolean };

export type AiModelOptions = {
  provider: AiProvider;
  defaultModel: string | null;
  models: { id: string; name: string }[];
};

export type AiConnectionStatus = {
  state: "unconfigured" | "login_required" | "configured" | "verifying" | "connected" | "error";
  account?: { email: string | null; plan: string | null };
  model?: string;
  response?: string;
  verifiedAt?: string;
  error?: string;
};

export type AiStatus = Record<AiProvider, AiConnectionStatus> & {
  deepseekModels: { id: string; name: string }[];
};

export type CodexLogin = {
  loginId: string;
  authUrl: string;
  state: "pending" | "completed" | "cancelled" | "error";
  error?: string;
};
