import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

const models = createModels();
models.setProvider(deepseekProvider());
export const deepseekModels = models.getModels("deepseek").map(({ id, name }) => ({ id, name }));
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-flash";

export async function requestDeepSeek(
  apiKey: string,
  modelId: string,
  prompt: string,
  signal: AbortSignal,
  maxTokens = 4096,
) {
  const model = models.getModel("deepseek", modelId);
  if (!model) throw new Error("请选择支持的 DeepSeek 模型");
  const agent = new Agent({
    initialState: { systemPrompt: "Follow the user's instruction exactly.", model, tools: [] },
    getApiKey: () => apiKey,
    streamFn: (selectedModel, context, options) =>
      models.streamSimple(selectedModel, context, { ...options, maxTokens }),
  });
  const abort = () => agent.abort();
  signal.throwIfAborted();
  signal.addEventListener("abort", abort, { once: true });
  try {
    await agent.prompt(prompt);
    signal.throwIfAborted();
    const response = [...agent.state.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (!response || response.role !== "assistant") throw new Error("DeepSeek 未返回回复");
    if (response.stopReason === "error" || response.stopReason === "aborted")
      throw new Error(response.errorMessage || "DeepSeek 请求失败");
    const text = response.content
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("")
      .trim();
    return { text, usage: response.usage, truncated: response.stopReason === "length" };
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function probeDeepSeek(
  apiKey: string,
  modelId: string,
  prompt: string,
  signal: AbortSignal,
) {
  return (await requestDeepSeek(apiKey, modelId, prompt, signal, 32)).text;
}
