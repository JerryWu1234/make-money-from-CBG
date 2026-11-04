export const CODEX_HTTP_PROVIDER = "openai_http";

// Keep the canonical name: Codex uses it to enable OpenAI backend routing.
// A separate ID is still required to disable WebSockets without overriding a built-in provider.
export const CODEX_HTTP_OVERRIDES = [
  `model_provider="${CODEX_HTTP_PROVIDER}"`,
  `model_providers.${CODEX_HTTP_PROVIDER}={name="OpenAI",wire_api="responses",requires_openai_auth=true,supports_websockets=false}`,
];
