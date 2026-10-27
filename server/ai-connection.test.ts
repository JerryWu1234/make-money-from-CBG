import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { valuationRecord } from "../tests/fixtures/analysis";
import { equipmentPricingFixture, petPricingFixture } from "../tests/fixtures/analysis";

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
  petInventory: vi.fn(),
  searchPetPricing: vi.fn(),
  createEquipmentSource: vi.fn(),
  createPetSource: vi.fn(),
  findCandidates: vi.fn(),
  readSource: vi.fn(),
  closeSource: vi.fn(),
  findPetCandidates: vi.fn(),
  readPetSource: vi.fn(),
  closePetSource: vi.fn(),
  searchPetGearPricing: vi.fn(),
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
vi.mock("./analysis/equipment-pricing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./analysis/equipment-pricing")>()),
  searchEquipmentPrices: mocks.searchEquipmentPrices,
}));
vi.mock("./analysis/browser-equipment-source", () => ({
  createEquipmentSource: mocks.createEquipmentSource,
}));
vi.mock("./analysis/browser-pet-source", () => ({
  createPetSource: mocks.createPetSource,
}));
vi.mock("./analysis/pet-pricing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./analysis/pet-pricing")>()),
  petInventory: mocks.petInventory,
  searchPetPricing: mocks.searchPetPricing,
}));
vi.mock("./analysis/pet-gear-search", () => ({ searchPetGearPricing: mocks.searchPetGearPricing }));
const account = { type: "chatgpt", email: "fixture@example.invalid", planType: "pro" };
const fakeKey = "test-only-deepseek-key";

it("账号标识缺失时拒绝复用会话，避免不同账号共用分析线程", async () => {
  mocks.codexAccount.mockResolvedValue({ ...account, email: null });
  const { prepareAnalysisClient } = await import("./ai-connection");
  await expect(prepareAnalysisClient("codex")).rejects.toThrow("无法确认 Codex 登录账号");
});

it("同邮箱的工作区变化时不再发送角色资料", async () => {
  mocks.codexAccount.mockResolvedValue({ ...account, workspaceId: "workspace-a" });
  const { prepareAnalysisClient } = await import("./ai-connection");
  const client = await prepareAnalysisClient("codex");
  mocks.codexAccount.mockResolvedValue({ ...account, workspaceId: "workspace-b" });
  await expect(client.analyze("fixture", {}, new AbortController().signal)).rejects.toThrow(
    "账号已变化",
  );
  expect(mocks.requestCodex).not.toHaveBeenCalled();
});

it("验证期间工作区变化时不显示连接成功", async () => {
  mocks.codexAccount
    .mockResolvedValueOnce({ ...account, workspaceId: "workspace-a" })
    .mockResolvedValueOnce({ ...account, workspaceId: "workspace-b" });
  const { verifyAi } = await import("./ai-connection");
  const result = await verifyAi("codex", {}, new AbortController().signal);
  expect(result.state).toBe("error");
  expect(result.error).toContain("账号已变化");
});

it("已连接后切换工作区，状态回到未验证", async () => {
  mocks.codexAccount.mockResolvedValue({ ...account, workspaceId: "workspace-a" });
  const { aiStatus, verifyAi } = await import("./ai-connection");
  expect((await verifyAi("codex", {}, new AbortController().signal)).state).toBe("connected");
  mocks.codexAccount.mockResolvedValue({ ...account, workspaceId: "workspace-b" });
  expect((await aiStatus()).codex.state).toBe("configured");
});

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
  mocks.createEquipmentSource.mockResolvedValue({
    findCandidates: mocks.findCandidates,
    readSource: mocks.readSource,
    close: mocks.closeSource,
  });
  mocks.closeSource.mockResolvedValue(undefined);
  mocks.searchEquipmentPrices.mockResolvedValue({
    ...equipmentPricingFixture(),
    provider: "browser",
  });
  mocks.petInventory.mockReturnValue({
    captureComplete: true,
    items: [{ status: "no_match" }],
  });
  mocks.createPetSource.mockResolvedValue({
    findCandidates: mocks.findPetCandidates,
    readSource: mocks.readPetSource,
    close: mocks.closePetSource,
  });
  mocks.closePetSource.mockResolvedValue(undefined);
  mocks.searchPetPricing.mockResolvedValue({ ...petPricingFixture(), provider: "browser" });
  mocks.searchPetGearPricing.mockResolvedValue({ items: [], total: null, knownTotal: 0 });
});

it.each(["codex", "deepseek"] as const)(
  "%s 客户端自动接入宝宝装备查价并复用上次进度",
  async (provider) => {
    if (provider === "deepseek") vi.stubEnv("DEEPSEEK_API_KEY", fakeKey);
    const { prepareAnalysisClient } = await import("./ai-connection");
    const client = await prepareAnalysisClient(provider);
    const record = valuationRecord();
    const signal = new AbortController().signal;
    const snapshot = { items: [], total: null, knownTotal: 0 };
    const pets = petPricingFixture();
    await expect(client.searchPetGear(record, signal, undefined, pets)).resolves.toEqual(snapshot);
    expect(mocks.searchPetGearPricing).toHaveBeenCalledExactlyOnceWith(
      record,
      signal,
      undefined,
      pets,
    );
  },
  15_000,
);

function equipmentRecord(empty = false) {
  const record = valuationRecord();
  record.detail!.equipmentCapture = {
    version: 1,
    collectedAt: record.detail!.collectedAt,
    complete: true,
    issues: [],
  };
  record.detail!.tabs = record.detail!.tabs.filter(
    (tab) => !/^道具\/法宝(?:\s*\/|$)/.test(tab.name),
  );
  record.detail!.tabs.push({
    name: "道具/法宝",
    text: "",
    fields: [],
    tables: [],
    elements: [],
    tooltips: [],
    items: empty
      ? []
      : [
          {
            index: 0,
            name: "模拟测试铠甲",
            category: "人物装备",
            kind: "equipment",
            description: "等级：120\n防御：200",
          },
        ],
  });
  return record;
}

describe("AI 连接验证", () => {
  it.each(["codex", "deepseek"] as const)(
    "%s部分宝宝采集仍为完整宝宝创建真实查询源",
    async (provider) => {
      if (provider === "deepseek") vi.stubEnv("DEEPSEEK_API_KEY", fakeKey);
      const { prepareAnalysisClient } = await import("./ai-connection");
      const client = await prepareAnalysisClient(provider);
      const record = valuationRecord();
      record.detail!.petCapture = {
        version: 1,
        collectedAt: record.detail!.collectedAt,
        complete: false,
        issues: ["第 2 只召唤兽成长未完整读取"],
      };
      record.detail!.tabs.push({
        name: "召唤兽/孩子",
        text: "",
        fields: [],
        tables: [],
        elements: [],
        tooltips: [],
        petCount: 2,
        pets: [1, 2].map((index) => ({
          index,
          name: "画魂",
          fields: [],
          skills: [],
          innerSkills: [],
          equipment: [],
        })),
      });
      mocks.petInventory.mockReturnValue({
        captureComplete: false,
        items: [
          { key: "召唤兽/孩子:1", status: "no_match" },
          { key: "召唤兽/孩子:2", status: "incomplete" },
        ],
      });
      const signal = new AbortController().signal;
      await client.searchPets(record, signal);
      expect(mocks.createPetSource).toHaveBeenCalledExactlyOnceWith(
        signal,
        record.listing.serverId,
      );
      expect(mocks.searchPetPricing).toHaveBeenCalledWith(
        record,
        signal,
        expect.objectContaining({ findCandidates: mocks.findPetCandidates }),
        undefined,
      );
      expect(mocks.closePetSource).toHaveBeenCalledOnce();
    },
  );
  it("DeepSeek宝宝查询使用浏览器source，不准备Codex搜索模型或账号，结束关闭source", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ deepseek: { apiKey: fakeKey } }));
    mocks.codexAccount.mockResolvedValue(null);
    mocks.codexModel.mockRejectedValue(new Error("ChatGPT未登录"));
    const { prepareAnalysisClient } = await import("./ai-connection");
    const client = await prepareAnalysisClient("deepseek");
    const record = valuationRecord(),
      signal = new AbortController().signal;
    const snapshot = await client.searchPets(record, signal);
    expect(snapshot.provider).toBe("browser");
    expect(mocks.petInventory).toHaveBeenCalledWith(record);
    expect(mocks.createPetSource).toHaveBeenCalledWith(signal, record.listing.serverId);
    expect(mocks.searchPetPricing).toHaveBeenCalledWith(
      record,
      signal,
      {
        findCandidates: mocks.findPetCandidates,
        readSource: mocks.readPetSource,
        close: mocks.closePetSource,
      },
      undefined,
    );
    expect(mocks.closePetSource).toHaveBeenCalledOnce();
    expect(mocks.createEquipmentSource).not.toHaveBeenCalled();
    expect(mocks.codexAccount).not.toHaveBeenCalled();
    expect(mocks.codexModel).not.toHaveBeenCalled();
    expect(mocks.codexModels).not.toHaveBeenCalled();
    expect(mocks.requestCodexSearch).not.toHaveBeenCalled();
    expect(mocks.requestCodex).not.toHaveBeenCalled();
    expect(mocks.requestDeepSeek).not.toHaveBeenCalled();
  });

  it("Codex宝宝查询也不重新访问账号、模型或AI搜索", async () => {
    const { prepareAnalysisClient } = await import("./ai-connection");
    const client = await prepareAnalysisClient("codex", "other-model");
    const accountCalls = mocks.codexAccount.mock.calls.length,
      modelCalls = mocks.codexModel.mock.calls.length,
      modelsCalls = mocks.codexModels.mock.calls.length;
    mocks.codexAccount.mockResolvedValue(null);
    mocks.codexModel.mockRejectedValue(new Error("默认模型不可用"));
    await client.searchPets(valuationRecord(), new AbortController().signal);
    expect(mocks.codexAccount).toHaveBeenCalledTimes(accountCalls);
    expect(mocks.codexModel).toHaveBeenCalledTimes(modelCalls);
    expect(mocks.codexModels).toHaveBeenCalledTimes(modelsCalls);
    expect(mocks.createPetSource).toHaveBeenCalledOnce();
    expect(mocks.closePetSource).toHaveBeenCalledOnce();
    expect(mocks.requestCodexSearch).not.toHaveBeenCalled();
    expect(mocks.requestCodex).not.toHaveBeenCalled();
    expect(mocks.requestDeepSeek).not.toHaveBeenCalled();
  });

  it("宝宝采集未完成、明确空列表或没有待查宝宝时不创建工作页", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ deepseek: { apiKey: fakeKey } }));
    const { prepareAnalysisClient } = await import("./ai-connection");
    const client = await prepareAnalysisClient("deepseek");
    for (const inventory of [
      { captureComplete: false, items: [{ status: "no_match" }] },
      { captureComplete: true, items: [] },
      { captureComplete: true, items: [{ status: "untradable" }, { status: "incomplete" }] },
      { captureComplete: true, items: [{ status: "priced" }] },
    ]) {
      mocks.petInventory.mockReturnValueOnce(inventory);
      await client.searchPets(valuationRecord(), new AbortController().signal);
    }
    expect(mocks.searchPetPricing).toHaveBeenCalledTimes(4);
    expect(mocks.createPetSource).not.toHaveBeenCalled();
    expect(mocks.closePetSource).not.toHaveBeenCalled();
    expect(mocks.findPetCandidates).not.toHaveBeenCalled();
    expect(mocks.readPetSource).not.toHaveBeenCalled();
    expect(mocks.codexAccount).not.toHaveBeenCalled();
    expect(mocks.codexModel).not.toHaveBeenCalled();
    expect(mocks.requestCodexSearch).not.toHaveBeenCalled();
  });

  it("完整宝宝清单混有不可交易或资料不足项时仍查询待查宝宝", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ deepseek: { apiKey: fakeKey } }));
    mocks.petInventory.mockReturnValueOnce({
      captureComplete: true,
      items: [{ status: "untradable" }, { status: "incomplete" }, { status: "no_match" }],
    });
    const { prepareAnalysisClient } = await import("./ai-connection");
    const client = await prepareAnalysisClient("deepseek");
    await client.searchPets(valuationRecord(), new AbortController().signal);
    expect(mocks.createPetSource).toHaveBeenCalledOnce();
    expect(mocks.searchPetPricing).toHaveBeenCalledOnce();
    expect(mocks.closePetSource).toHaveBeenCalledOnce();
  });

  it("宝宝查价失败或source创建后取消仍关闭工作页，并隐藏失败凭据", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ deepseek: { apiKey: fakeKey } }));
    const { prepareAnalysisClient } = await import("./ai-connection");
    const client = await prepareAnalysisClient("deepseek");
    mocks.searchPetPricing.mockRejectedValueOnce(
      new Error("query error sk-mock-secret Bearer mock-secret"),
    );
    await expect(
      client.searchPets(valuationRecord(), new AbortController().signal),
    ).rejects.toThrow("query error [凭证已隐藏] Bearer [凭证已隐藏]");
    expect(mocks.closePetSource).toHaveBeenCalledOnce();
    const controller = new AbortController();
    mocks.createPetSource.mockImplementationOnce(async () => {
      controller.abort(new Error("已暂停"));
      return {
        findCandidates: mocks.findPetCandidates,
        readSource: mocks.readPetSource,
        close: mocks.closePetSource,
      };
    });
    await expect(client.searchPets(valuationRecord(), controller.signal)).rejects.toThrow("已暂停");
    expect(mocks.closePetSource).toHaveBeenCalledTimes(2);
    expect(mocks.searchPetPricing).toHaveBeenCalledOnce();
    expect(mocks.requestCodexSearch).not.toHaveBeenCalled();
  });

  it("已取消宝宝查价不创建工作页，浏览器连接失败不回退AI", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ deepseek: { apiKey: fakeKey } }));
    const { prepareAnalysisClient } = await import("./ai-connection");
    const client = await prepareAnalysisClient("deepseek");
    const controller = new AbortController();
    controller.abort(new Error("已暂停"));
    await expect(client.searchPets(valuationRecord(), controller.signal)).rejects.toThrow("已暂停");
    expect(mocks.createPetSource).not.toHaveBeenCalled();
    mocks.createPetSource.mockRejectedValueOnce(new Error("藏宝阁需要扫码登录"));
    await expect(
      client.searchPets(valuationRecord(), new AbortController().signal),
    ).rejects.toThrow("扫码登录");
    expect(mocks.searchPetPricing).not.toHaveBeenCalled();
    expect(mocks.closePetSource).not.toHaveBeenCalled();
    expect(mocks.codexAccount).not.toHaveBeenCalled();
    expect(mocks.codexModel).not.toHaveBeenCalled();
    expect(mocks.requestCodexSearch).not.toHaveBeenCalled();
    expect(mocks.requestCodex).not.toHaveBeenCalled();
    expect(mocks.requestDeepSeek).not.toHaveBeenCalled();
  });

  it("DeepSeek装备查询使用已登录藏宝阁source，不访问Codex账号/模型或AI搜索，结束关闭source", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ deepseek: { apiKey: fakeKey } }));
    mocks.codexAccount.mockResolvedValue(null);
    mocks.codexModel.mockRejectedValue(new Error("ChatGPT未登录"));
    const { prepareAnalysisClient } = await import("./ai-connection");
    const client = await prepareAnalysisClient("deepseek");
    const record = equipmentRecord(),
      signal = new AbortController().signal;
    const onProgress = vi.fn();
    const onCheckpoint = vi.fn();
    const snapshot = await client.searchEquipment(
      record,
      signal,
      undefined,
      undefined,
      onProgress,
      onCheckpoint,
    );
    expect(snapshot.provider).toBe("browser");
    expect(mocks.createEquipmentSource).toHaveBeenCalledWith(
      signal,
      record.listing.serverId,
      onProgress,
      record.listing.key,
    );
    expect(mocks.searchEquipmentPrices).toHaveBeenCalledWith(
      record,
      signal,
      {
        findCandidates: mocks.findCandidates,
        readSource: mocks.readSource,
        close: mocks.closeSource,
      },
      undefined,
      undefined,
      onCheckpoint,
    );
    expect(mocks.closeSource).toHaveBeenCalledOnce();
    expect(mocks.codexAccount).not.toHaveBeenCalled();
    expect(mocks.codexModel).not.toHaveBeenCalled();
    expect(mocks.requestCodexSearch).not.toHaveBeenCalled();
    expect(mocks.requestCodex).not.toHaveBeenCalled();
    expect(mocks.requestDeepSeek).not.toHaveBeenCalled();
  });

  it("Codex装备查询也不重新访问Codex账号、模型或AI搜索", async () => {
    const { prepareAnalysisClient } = await import("./ai-connection");
    const client = await prepareAnalysisClient("codex", "other-model");
    const accountCalls = mocks.codexAccount.mock.calls.length,
      modelCalls = mocks.codexModel.mock.calls.length;
    mocks.codexAccount.mockResolvedValue(null);
    await client.searchEquipment(equipmentRecord(), new AbortController().signal);
    expect(mocks.codexAccount).toHaveBeenCalledTimes(accountCalls);
    expect(mocks.codexModel).toHaveBeenCalledTimes(modelCalls);
    expect(mocks.requestCodexSearch).not.toHaveBeenCalled();
    expect(mocks.closeSource).toHaveBeenCalledOnce();
  });

  it("普通环装与缺默认价的装备都使用浏览器市场搜索", async () => {
    const { DEFAULT_SETTINGS } = await import("./analysis/profile");
    const { prepareAnalysisClient } = await import("./ai-connection");
    const client = await prepareAnalysisClient("codex");
    const record = equipmentRecord();
    const item = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items![0];
    item.category = "人物装备 · 武器";
    item.description = "等级：70\n命中：255\n伤害：220\n耐久：200\n修理失败：0";
    const settings = {
      ...DEFAULT_SETTINGS,
      servers: [
        {
          serverId: String(record.listing.serverId),
          age: "older" as const,
          rank: 70,
          goldPrice: 210,
          goldUnit: 30000000,
          baselineUnitConfirmed: true,
        },
      ],
    };
    const signal = new AbortController().signal;
    await client.searchEquipment(record, signal, settings);
    item.description = item.description
      .replace("70", "60")
      .replace("255", "220")
      .replace("伤害：220", "伤害：190");
    await client.searchEquipment(record, signal, settings);
    expect(mocks.createEquipmentSource).toHaveBeenCalledTimes(2);
    expect(mocks.closeSource).toHaveBeenCalledTimes(2);
    expect(mocks.searchEquipmentPrices).toHaveBeenCalledTimes(2);
    expect(mocks.searchEquipmentPrices.mock.calls[0][3]).toBe(settings);
    expect(mocks.requestCodexSearch).not.toHaveBeenCalled();
  });

  it("缺资料、明确空装备或均不可交易时不创建浏览器查询", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ deepseek: { apiKey: fakeKey } }));
    const { prepareAnalysisClient } = await import("./ai-connection");
    const client = await prepareAnalysisClient("deepseek");
    const incomplete = equipmentRecord();
    delete incomplete.detail!.equipmentCapture;
    const bound = equipmentRecord();
    bound.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items![0].description +=
      "\n玩家123专用";
    for (const record of [incomplete, equipmentRecord(true), bound])
      await client.searchEquipment(record, new AbortController().signal);
    expect(mocks.searchEquipmentPrices).toHaveBeenCalledTimes(3);
    expect(mocks.createEquipmentSource).not.toHaveBeenCalled();
    expect(mocks.closeSource).not.toHaveBeenCalled();
    expect(mocks.findCandidates).not.toHaveBeenCalled();
    expect(mocks.readSource).not.toHaveBeenCalled();
    expect(mocks.codexAccount).not.toHaveBeenCalled();
    expect(mocks.codexModel).not.toHaveBeenCalled();
  });

  it("库存有部分缺资料时，已完整采集的装备仍进入浏览器搜索", async () => {
    const { prepareAnalysisClient } = await import("./ai-connection");
    const client = await prepareAnalysisClient("codex");
    const record = equipmentRecord();
    record.detail!.equipmentCapture!.complete = false;
    record.detail!.equipmentCapture!.issues = ["道具/法宝：另一件装备 属性未采齐"];
    await client.searchEquipment(record, new AbortController().signal);
    expect(mocks.createEquipmentSource).toHaveBeenCalledOnce();
    expect(mocks.searchEquipmentPrices).toHaveBeenCalledOnce();
    expect(mocks.closeSource).toHaveBeenCalledOnce();
  });

  it("本任务已完成且有效的查价不再创建浏览器工作页，过期时才重查", async () => {
    const { prepareAnalysisClient } = await import("./ai-connection");
    const { equipmentPricingPlan } = await import("./analysis/equipment-pricing");
    const client = await prepareAnalysisClient("codex");
    const record = equipmentRecord();
    const previous = equipmentPricingPlan(record);
    previous.queries = ["模拟已读完的零结果查询"];
    for (const item of previous.items) item.searchState = "completed";
    previous.searchComplete = true;
    await client.searchEquipment(record, new AbortController().signal, undefined, previous);
    expect(mocks.createEquipmentSource).not.toHaveBeenCalled();
    previous.searchedAt = new Date(Date.now() - 25 * 3600_000).toISOString();
    await client.searchEquipment(record, new AbortController().signal, undefined, previous);
    expect(mocks.createEquipmentSource).toHaveBeenCalledOnce();
    expect(mocks.closeSource).toHaveBeenCalledOnce();
  });

  it("查询失败或source创建后取消也关闭浏览器工作页，失败信息隐藏密钥", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ deepseek: { apiKey: fakeKey } }));
    const { prepareAnalysisClient } = await import("./ai-connection");
    const client = await prepareAnalysisClient("deepseek");
    mocks.searchEquipmentPrices.mockRejectedValueOnce(
      new Error("query error sk-mock-secret Bearer mock-secret"),
    );
    await expect(
      client.searchEquipment(equipmentRecord(), new AbortController().signal),
    ).rejects.toThrow("query error [凭证已隐藏] Bearer [凭证已隐藏]");
    expect(mocks.closeSource).toHaveBeenCalledOnce();
    const controller = new AbortController();
    mocks.createEquipmentSource.mockImplementationOnce(async () => {
      controller.abort(new Error("已暂停"));
      return {
        findCandidates: mocks.findCandidates,
        readSource: mocks.readSource,
        close: mocks.closeSource,
      };
    });
    await expect(client.searchEquipment(equipmentRecord(), controller.signal)).rejects.toThrow(
      "已暂停",
    );
    expect(mocks.closeSource).toHaveBeenCalledTimes(2);
    expect(mocks.searchEquipmentPrices).toHaveBeenCalledOnce();
    expect(mocks.requestCodexSearch).not.toHaveBeenCalled();
  });

  it("已取消查询不创建工作页；浏览器连接失败不调用AI补报价", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ deepseek: { apiKey: fakeKey } }));
    const { prepareAnalysisClient } = await import("./ai-connection");
    const client = await prepareAnalysisClient("deepseek");
    const controller = new AbortController();
    controller.abort(new Error("已暂停"));
    await expect(client.searchEquipment(equipmentRecord(), controller.signal)).rejects.toThrow(
      "已暂停",
    );
    expect(mocks.createEquipmentSource).not.toHaveBeenCalled();
    mocks.createEquipmentSource.mockRejectedValueOnce(new Error("藏宝阁需要扫码登录"));
    await expect(
      client.searchEquipment(equipmentRecord(), new AbortController().signal),
    ).rejects.toThrow("扫码登录");
    expect(mocks.searchEquipmentPrices).not.toHaveBeenCalled();
    expect(mocks.closeSource).not.toHaveBeenCalled();
    expect(mocks.requestCodexSearch).not.toHaveBeenCalled();
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
    await codex.analyze("裸号核对", schema, signal, { bareRoleReview: true });
    expect(mocks.requestCodex).toHaveBeenLastCalledWith("裸号核对", signal, {
      model: "other-model",
      outputSchema: schema,
      bareRoleReview: true,
    });

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

  it("同一已登录账号验证失败后，重试会重新调用 SDK 并可恢复连接", async () => {
    mocks.probeCodex.mockRejectedValueOnce(new Error("连接验证超时，请重试"));
    const { verifyAi, aiStatus } = await import("./ai-connection");
    const failed = await verifyAi("codex", {}, new AbortController().signal);
    expect(failed.state).toBe("error");
    expect((await aiStatus()).codex.state).toBe("error");
    const retried = await verifyAi("codex", {}, new AbortController().signal);
    expect(retried).toMatchObject({ state: "connected", response: "READY" });
    expect(mocks.probeCodex).toHaveBeenCalledTimes(2);
    expect((await aiStatus()).codex.state).toBe("connected");
  });

  it("重试时读取账号失败，仍停止验证而不采用旧账号", async () => {
    const { verifyAi } = await import("./ai-connection");
    expect((await verifyAi("codex", {}, new AbortController().signal)).state).toBe("connected");
    mocks.codexAccount.mockRejectedValueOnce(new Error("Codex 登录服务不可用"));
    const failed = await verifyAi("codex", {}, new AbortController().signal);
    expect(failed.state).toBe("error");
    expect(failed.error).toContain("登录服务不可用");
    expect(mocks.probeCodex).toHaveBeenCalledTimes(1);
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
