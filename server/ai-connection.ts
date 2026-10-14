import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  codexAccount,
  codexModel,
  codexModels,
  probeCodex,
  requestCodex,
  shutdownCodex,
} from "./ai/codex";
import {
  DEFAULT_DEEPSEEK_MODEL,
  deepseekModels,
  probeDeepSeek,
  requestDeepSeek,
} from "./ai/deepseek";
import type { AiConnectionStatus, AiModelOptions, AiProvider, AiStatus } from "./ai/types";
import type { SavedRoleRecord } from "./crawler/types";
import {
  equipmentPricingPlan,
  equipmentCaptureSearchable,
  searchEquipmentPrices,
  type EquipmentPricingSnapshot,
} from "./analysis/equipment-pricing";
import type { ValuationSettings } from "./analysis/valuation-types";
import { createEquipmentSource } from "./analysis/browser-equipment-source";
import { resumePricingItems } from "./analysis/pricing-progress";
import {
  petCaptureSearchable,
  petInventory,
  searchPetPricing,
  type PetPricingSnapshot,
} from "./analysis/pet-pricing";
import { createPetSource } from "./analysis/browser-pet-source";
import { searchPetGearPricing } from "./analysis/pet-gear-search";
import type { PetGearPricingSnapshot } from "./analysis/pet-gear-inventory";

export { startCodexLogin, codexLoginStatus, cancelCodexLogin } from "./ai/codex";

const CONFIG_FILE = resolve("data/ai-connections.json");
const PROBE_PROMPT = "Reply with exactly READY. Do not use tools.";
const connections: Partial<Record<AiProvider, AiConnectionStatus>> = {};
const active = new Map<AiProvider, AbortController>();
type DeepSeekConfig = { apiKey?: string; model?: string };

export function aiProvider(value: unknown): AiProvider {
  if (value !== "codex" && value !== "deepseek") throw new Error("请选择 Codex 或 DeepSeek");
  return value;
}

function publicError(error: unknown, secret?: string) {
  let message = error instanceof Error ? error.message : "连接验证失败";
  if (secret) message = message.split(secret).join("[凭证已隐藏]");
  return message
    .replace(/sk-[A-Za-z0-9_-]+/g, "[凭证已隐藏]")
    .replace(/Bearer\s+\S+/gi, "Bearer [凭证已隐藏]")
    .slice(0, 600);
}

async function readConfig(): Promise<DeepSeekConfig> {
  try {
    const config = JSON.parse(await readFile(CONFIG_FILE, "utf8")) as { deepseek?: DeepSeekConfig };
    if (
      !config ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      (config.deepseek !== undefined &&
        (!config.deepseek ||
          typeof config.deepseek !== "object" ||
          Array.isArray(config.deepseek))) ||
      (config.deepseek?.apiKey !== undefined && typeof config.deepseek.apiKey !== "string") ||
      (config.deepseek?.model !== undefined && typeof config.deepseek.model !== "string")
    )
      throw new Error("配置格式错误");
    return config.deepseek || {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("无法读取本机 AI 配置，请检查 data/ai-connections.json");
  }
}

async function saveConfig(config: DeepSeekConfig) {
  await mkdir(dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
  const temporary = `${CONFIG_FILE}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ deepseek: config }), { mode: 0o600, flag: "wx" });
    await rename(temporary, CONFIG_FILE);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function codexStatus(): Promise<AiConnectionStatus> {
  let codex: AiConnectionStatus;
  try {
    const account = await codexAccount();
    const identity = account ? { email: account.email, plan: account.planType } : undefined;
    const previous = connections.codex;
    const sameAccount =
      identity &&
      previous?.account?.email === identity.email &&
      previous.account.plan === identity.plan;
    codex = account
      ? { ...(sameAccount ? previous : { state: "configured" as const }), account: identity }
      : { state: "login_required" };
  } catch (error) {
    codex = { state: "error", error: publicError(error) };
  }
  connections.codex = codex;
  return codex;
}

async function deepseekStatus(): Promise<AiConnectionStatus> {
  try {
    const config = await readConfig();
    return (
      connections.deepseek || {
        state: config.apiKey || process.env.DEEPSEEK_API_KEY ? "configured" : "unconfigured",
        model: config.model || DEFAULT_DEEPSEEK_MODEL,
      }
    );
  } catch (error) {
    return { state: "error", error: publicError(error) };
  }
}

export async function aiStatus(): Promise<AiStatus> {
  const [codex, deepseek] = await Promise.all([codexStatus(), deepseekStatus()]);
  return { codex, deepseek, deepseekModels };
}

export async function aiModels(provider: AiProvider): Promise<AiModelOptions> {
  if (provider === "codex") {
    if (!(await codexAccount())) return { provider, defaultModel: null, models: [] };
    const [defaultModel, models] = await Promise.all([codexModel(), codexModels()]);
    return { provider, defaultModel, models };
  }
  const config = await readConfig();
  return { provider, defaultModel: config.model || DEFAULT_DEEPSEEK_MODEL, models: deepseekModels };
}

export async function verifyAi(
  provider: AiProvider,
  input: { apiKey?: unknown; model?: unknown },
  requestSignal: AbortSignal,
): Promise<AiConnectionStatus> {
  if (active.has(provider)) throw new Error("当前服务正在验证，请稍候");
  const controller = new AbortController();
  const signal = AbortSignal.any([requestSignal, controller.signal, AbortSignal.timeout(60_000)]);
  active.set(provider, controller);
  let apiKey: string | undefined;
  try {
    const before = await (provider === "codex" ? codexStatus() : deepseekStatus());
    connections[provider] = {
      ...before,
      state: "verifying",
      response: undefined,
      verifiedAt: undefined,
      error: undefined,
    };
    let response: string;
    let status: AiConnectionStatus;
    if (provider === "codex") {
      if (before.state === "error" && !before.account)
        throw new Error(before.error || "Codex 登录服务不可用");
      if (!before.account) return (connections.codex = { state: "login_required" });
      response = await probeCodex(PROBE_PROMPT, signal);
      const account = await codexAccount();
      if (
        !account ||
        account.email !== before.account.email ||
        account.planType !== before.account.plan
      )
        throw new Error("ChatGPT 登录账号已变化，请重新验证");
      status = { state: "connected", account: before.account };
    } else {
      const config = await readConfig();
      if (input.apiKey !== undefined && typeof input.apiKey !== "string")
        throw new Error("API Key 格式错误");
      const newKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
      apiKey = newKey || config.apiKey || process.env.DEEPSEEK_API_KEY;
      if (!apiKey)
        return (connections.deepseek = { state: "unconfigured", error: "请填写 DeepSeek API Key" });
      if (apiKey.length > 1024 || /\s/.test(apiKey))
        throw new Error("API Key 格式错误，请粘贴完整的密钥");
      const model = input.model ?? config.model ?? DEFAULT_DEEPSEEK_MODEL;
      if (typeof model !== "string" || !deepseekModels.some((item) => item.id === model))
        throw new Error("请选择支持的 DeepSeek 模型");
      response = await probeDeepSeek(apiKey, model, PROBE_PROMPT, signal);
      signal.throwIfAborted();
      if (response !== "READY") throw new Error("DeepSeek 未返回预期的测试回复，请重试");
      await saveConfig({ apiKey: newKey || config.apiKey, model });
      status = { state: "connected", model };
    }
    signal.throwIfAborted();
    if (response !== "READY") throw new Error("AI 未返回预期的测试回复，请重试");
    return (connections[provider] = { ...status, response, verifiedAt: new Date().toISOString() });
  } catch (error) {
    const message = signal.aborted
      ? signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
        ? "连接验证超时，请重试"
        : "已取消连接验证"
      : publicError(error, apiKey);
    return (connections[provider] = { ...connections[provider], state: "error", error: message });
  } finally {
    active.delete(provider);
  }
}

export async function shutdownAiConnections() {
  for (const controller of active.values()) controller.abort();
  await shutdownCodex();
}

const unusedEquipmentSource = {
  async findCandidates() {
    throw new Error("装备资料不足或无需查价，不应发起浏览器查询");
  },
  async readSource() {
    throw new Error("装备资料不足或无需查价，不应读取报价网页");
  },
};
async function searchEquipment(
  record: SavedRoleRecord,
  signal: AbortSignal,
  settings?: ValuationSettings,
  previous?: EquipmentPricingSnapshot,
  onProgress?: (progress: import("./analysis/equipment-pricing").PricingSearchProgress) => void,
) {
  try {
    signal.throwIfAborted();
    const plan = resumePricingItems(equipmentPricingPlan(record, settings), previous, true);
    if (
      !equipmentCaptureSearchable(record, plan) ||
      !plan.items.some((item) => item.searchState === "pending")
    )
      return await searchEquipmentPrices(record, signal, unusedEquipmentSource, settings, previous);
    const source = await createEquipmentSource(signal, onProgress);
    try {
      signal.throwIfAborted();
      return await searchEquipmentPrices(record, signal, source, settings, previous);
    } finally {
      await source.close();
    }
  } catch (error) {
    throw new Error(publicError(error));
  }
}
const unusedPetSource = {
  async findCandidates() {
    throw new Error("宝宝资料不足或无需查价，不应发起浏览器查询");
  },
  async readSource() {
    throw new Error("宝宝资料不足或无需查价，不应读取报价网页");
  },
};
async function searchPets(
  record: SavedRoleRecord,
  signal: AbortSignal,
  previous?: PetPricingSnapshot,
) {
  try {
    signal.throwIfAborted();
    const inventory = petInventory(record);
    if (
      !petCaptureSearchable(record, inventory) ||
      !inventory.items.some((item) => item.status === "no_match")
    )
      return await searchPetPricing(record, signal, unusedPetSource, previous);
    const source = await createPetSource(signal);
    try {
      signal.throwIfAborted();
      return await searchPetPricing(record, signal, source, previous);
    } finally {
      await source.close();
    }
  } catch (error) {
    throw new Error(publicError(error));
  }
}

/** Credentials remain inside the Node process; an analysis run fixes its provider and model. */
async function searchPetGear(
  record: SavedRoleRecord,
  signal: AbortSignal,
  previous?: PetGearPricingSnapshot,
  pets?: PetPricingSnapshot,
) {
  try {
    return await searchPetGearPricing(record, signal, previous, pets);
  } catch (error) {
    throw new Error(publicError(error));
  }
}

export async function prepareAnalysisClient(provider: AiProvider, selectedModel?: string) {
  if (provider === "codex") {
    const account = await codexAccount();
    if (!account) throw new Error("请先登录 ChatGPT，再开始分析");
    if (selectedModel && !(await codexModels()).some((item) => item.id === selectedModel))
      throw new Error("Codex 模型不在当前模型列表中，请重新选择或使用默认模型");
    const model = selectedModel || (await codexModel());
    return {
      model,
      searchEquipment,
      searchPets,
      searchPetGear,
      async analyze(prompt: string, schema: unknown, signal: AbortSignal) {
        const current = await codexAccount();
        if (!current || current.email !== account.email)
          throw new Error("ChatGPT 登录账号已变化，请重新连接");
        try {
          return await requestCodex(prompt, signal, { model, outputSchema: schema });
        } catch (error) {
          throw new Error(publicError(error));
        }
      },
    };
  }
  const config = await readConfig();
  const key = config.apiKey || process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("请先连接 DeepSeek 并填写 API Key");
  const model = selectedModel || config.model || DEFAULT_DEEPSEEK_MODEL;
  if (!deepseekModels.some((item) => item.id === model))
    throw new Error("DeepSeek 模型不可用，请重新选择");
  return {
    model,
    searchEquipment,
    searchPets,
    searchPetGear,
    async analyze(prompt: string, _schema: unknown, signal: AbortSignal) {
      try {
        return await requestDeepSeek(key, model, prompt, signal, 8192);
      } catch (error) {
        throw new Error(publicError(error, key));
      }
    },
  };
}
