import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Search } from "./analysis/equipment-pricing";
import { valuationRecord } from "../tests/fixtures/analysis";

const mocks = vi.hoisted(() => ({
  codexAccount: vi.fn(),
  codexModel: vi.fn(),
  codexModels: vi.fn(),
  requestCodex: vi.fn(),
  requestCodexSearch: vi.fn(),
  probeCodex: vi.fn(),
  shutdownCodex: vi.fn(),
  probeDeepSeek: vi.fn(),
  requestDeepSeek: vi.fn(),
  readFile: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  searchEquipmentPrices: vi.fn(),
  searchPetPricing: vi.fn(),
}));
vi.mock("./ai/codex", () => mocks);
vi.mock("./ai/deepseek", () => ({
  probeDeepSeek: mocks.probeDeepSeek,
  requestDeepSeek: mocks.requestDeepSeek,
  DEFAULT_DEEPSEEK_MODEL: "deepseek-flash",
  deepseekModels: [
    { id: "deepseek-flash", name: "DeepSeek Flash" },
    { id: "deepseek-v4-pro", name: "DeepSeek Pro" },
  ],
}));
vi.mock("node:fs/promises", () => mocks);
vi.mock("./analysis/equipment-pricing", () => ({
  searchEquipmentPrices: mocks.searchEquipmentPrices,
}));
vi.mock("./analysis/pet-pricing", () => ({ searchPetPricing: mocks.searchPetPricing }));
const account = { type: "chatgpt", email: "fixture@example.invalid", planType: "pro" };
const fakeKey = "test-only-deepseek-key";

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv("DEEPSEEK_API_KEY", "");
  mocks.codexAccount.mockResolvedValue(account);
  mocks.codexModel.mockResolvedValue("configured-model");
  mocks.codexModels.mockResolvedValue([
    { id: "configured-model", name: "默认模型" },
    { id: "other-model", name: "另一个模型" },
  ]);
  mocks.probeCodex.mockResolvedValue("READY");
  mocks.probeDeepSeek.mockResolvedValue("READY");
  mocks.readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
  mocks.mkdir.mockResolvedValue(undefined);
  mocks.writeFile.mockResolvedValue(undefined);
  mocks.rename.mockResolvedValue(undefined);
  mocks.rm.mockResolvedValue(undefined);
});

describe("AI 连接验证", () => {
  it("DeepSeek分析的装备与宝宝查价固定同一Codex模型，账号变化会停止第二阶段", async () => {
    mocks.readFile.mockResolvedValue(
      JSON.stringify({ deepseek: { apiKey: fakeKey, model: "deepseek-flash" } }),
    );
    const callback = (_record: unknown, _model: string, signal: AbortSignal, search: Search) =>
      search("公开商品条件", { type: "object" }, signal);
    mocks.searchEquipmentPrices.mockImplementation(callback);
    mocks.searchPetPricing.mockImplementation(callback);
    mocks.requestCodexSearch.mockResolvedValue({ text: "{}", queries: ["实际查询"] });
    const { prepareAnalysisClient } = await import("./ai-connection");
    const client = await prepareAnalysisClient("deepseek");
    const record = valuationRecord();
    const signal = new AbortController().signal;
    await client.searchEquipment(record, signal);
    mocks.codexModel.mockResolvedValue("changed-default-model");
    await client.searchPets(record, signal);
    expect(mocks.codexModel).toHaveBeenCalledOnce();
    for (const call of mocks.requestCodexSearch.mock.calls)
      expect(call[2].model).toBe("configured-model");
    mocks.codexAccount.mockResolvedValue({ ...account, email: "changed@example.invalid" });
    await expect(client.searchPets(record, signal)).rejects.toThrow("账号已变化");
    expect(mocks.requestCodexSearch).toHaveBeenCalledTimes(2);
  });
  it("默认跟随配置，手选模型传到真实调用，未知模型不会发起调用", async () => {
    const { aiModels, prepareAnalysisClient } = await import("./ai-connection");
    expect(await aiModels("codex")).toMatchObject({ defaultModel: "configured-model" });
    expect((await prepareAnalysisClient("codex")).model).toBe("configured-model");
    const codex = await prepareAnalysisClient("codex", "other-model");
    const signal = new AbortController().signal;
    const schema = { type: "object" };
    await codex.analyze("商品原文", schema, signal);
    expect(mocks.requestCodex).toHaveBeenCalledWith("商品原文", signal, {
      model: "other-model",
      outputSchema: schema,
    });
    await expect(prepareAnalysisClient("codex", "unknown-model")).rejects.toThrow("重新选择");
    expect(mocks.requestCodex).toHaveBeenCalledTimes(1);

    mocks.readFile.mockResolvedValue(
      JSON.stringify({ deepseek: { apiKey: fakeKey, model: "deepseek-v4-pro" } }),
    );
    expect(await aiModels("deepseek")).toMatchObject({ defaultModel: "deepseek-v4-pro" });
    expect((await prepareAnalysisClient("deepseek")).model).toBe("deepseek-v4-pro");
    const deepseek = await prepareAnalysisClient("deepseek", "deepseek-flash");
    await deepseek.analyze("商品原文", schema, signal);
    expect(mocks.requestDeepSeek).toHaveBeenCalledWith(
      fakeKey,
      "deepseek-flash",
      "商品原文",
      signal,
      8192,
    );
    await expect(prepareAnalysisClient("deepseek", "unknown-model")).rejects.toThrow("重新选择");
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("未登录的 Codex 不提供模型目录，也不进行推理", async () => {
    mocks.codexAccount.mockResolvedValue(null);
    const { aiModels } = await import("./ai-connection");
    expect(await aiModels("codex")).toEqual({ provider: "codex", defaultModel: null, models: [] });
    expect(mocks.codexModels).not.toHaveBeenCalled();
    expect(mocks.requestCodex).not.toHaveBeenCalled();
  });

  it("账号登录和 Key 配置均不算调用成功，状态不会返回密钥", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ deepseek: { apiKey: fakeKey } }));
    const { aiStatus } = await import("./ai-connection");
    const status = await aiStatus();
    expect(status.codex.state).toBe("configured");
    expect(status.deepseek.state).toBe("configured");
    expect(JSON.stringify(status)).not.toContain(fakeKey);
    expect(mocks.probeCodex).not.toHaveBeenCalled();
    expect(mocks.probeDeepSeek).not.toHaveBeenCalled();
  });

  it("Codex 未登录时不会调用 SDK 或回退到 DeepSeek", async () => {
    mocks.codexAccount.mockResolvedValue(null);
    const { verifyAi } = await import("./ai-connection");
    const result = await verifyAi("codex", {}, new AbortController().signal);
    expect(result.state).toBe("login_required");
    expect(mocks.probeCodex).not.toHaveBeenCalled();
    expect(mocks.probeDeepSeek).not.toHaveBeenCalled();
  });

  it("只有真实探测回复 READY 才把 Codex 标为 connected", async () => {
    const { verifyAi, aiStatus } = await import("./ai-connection");
    expect((await verifyAi("codex", {}, new AbortController().signal)).response).toBe("READY");
    expect((await aiStatus()).codex.state).toBe("connected");
    expect((await aiStatus()).deepseek.state).toBe("unconfigured");
    mocks.probeCodex.mockResolvedValueOnce("Unexpected response");
    const failed = await verifyAi("codex", {}, new AbortController().signal);
    expect(failed.state).toBe("error");
    expect(failed.response).toBeUndefined();
  });

  it("验证期间账号变化，不把另一个账号的回复算连接成功", async () => {
    mocks.codexAccount
      .mockResolvedValueOnce(account)
      .mockResolvedValueOnce({ ...account, email: "other@example.invalid" });
    const { verifyAi } = await import("./ai-connection");
    const result = await verifyAi("codex", {}, new AbortController().signal);
    expect(result.state).toBe("error");
    expect(result.error).toContain("账号已变化");
  });

  it("DeepSeek 通过 Pi SDK 验证后才保存，状态和回复均不包含 Key", async () => {
    const { verifyAi } = await import("./ai-connection");
    const result = await verifyAi(
      "deepseek",
      { apiKey: fakeKey, model: "deepseek-flash" },
      new AbortController().signal,
    );
    expect(result.state).toBe("connected");
    expect(result.response).toBe("READY");
    expect(JSON.stringify(result)).not.toContain(fakeKey);
    expect(mocks.probeDeepSeek).toHaveBeenCalledWith(
      fakeKey,
      "deepseek-flash",
      expect.stringContaining("READY"),
      expect.any(AbortSignal),
    );
    expect(mocks.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("ai-connections.json"),
      expect.stringContaining(fakeKey),
      { mode: 0o600, flag: "wx" },
    );
    expect(mocks.rename).toHaveBeenCalledTimes(1);
    expect(mocks.codexAccount).not.toHaveBeenCalled();
  });

  it("失败的 Key 不覆盖已保存的 Key，错误文本会隐藏凭据", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ deepseek: { apiKey: "previous-test-key" } }));
    mocks.probeDeepSeek.mockRejectedValue(new Error(`Invalid key ${fakeKey}`));
    const { verifyAi } = await import("./ai-connection");
    const result = await verifyAi("deepseek", { apiKey: fakeKey }, new AbortController().signal);
    expect(result.state).toBe("error");
    expect(result.error).not.toContain(fakeKey);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("取消请求会取消 SDK 探测，也不会保存 Key", async () => {
    const controller = new AbortController();
    mocks.probeDeepSeek.mockImplementation(
      (_key, _model, _prompt, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
          controller.abort();
        }),
    );
    const { verifyAi } = await import("./ai-connection");
    const result = await verifyAi("deepseek", { apiKey: fakeKey }, controller.signal);
    expect(result.state).toBe("error");
    expect(result.error).toContain("取消");
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("DeepSeek 配置损坏不会阻止 Codex 验证", async () => {
    mocks.readFile.mockResolvedValue("invalid json");
    const { verifyAi, aiStatus } = await import("./ai-connection");
    expect((await verifyAi("codex", {}, new AbortController().signal)).state).toBe("connected");
    expect((await aiStatus()).deepseek.state).toBe("error");
  });
});
