export const CODEX_HTTP_PROVIDER = "openai_http";

// Built-in provider IDs cannot be overridden by Codex 0.159.3.
export const CODEX_HTTP_OVERRIDES = [
  `model_provider="${CODEX_HTTP_PROVIDER}"`,
  `model_providers.${CODEX_HTTP_PROVIDER}={name="OpenAI HTTP",wire_api="responses",requires_openai_auth=true,supports_websockets=false}`,
];
