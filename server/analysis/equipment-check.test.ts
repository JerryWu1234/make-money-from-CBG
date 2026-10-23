import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { valuationRecord } from "../../tests/fixtures/analysis";
import { checkEquipment } from "./equipment-check";

const mocks = vi.hoisted(() => ({
  savedDetail: vi.fn(),
  createEquipmentSource: vi.fn(),
  findCandidates: vi.fn(),
  discover: vi.fn(),
  close: vi.fn(),
  prepareAnalysisClient: vi.fn(),
}));
vi.mock("../crawler/controller", () => ({ savedDetail: mocks.savedDetail }));
vi.mock("./browser-equipment-source", () => ({
  createEquipmentSource: mocks.createEquipmentSource,
}));
vi.mock("../ai-connection", () => ({ prepareAnalysisClient: mocks.prepareAnalysisClient }));

const input = { productKey: "941:saved-role", equipmentKey: "道具/法宝:1" };
function savedRecord() {
  const record = valuationRecord();
  record.listing.key = input.productKey;
  record.detail!.equipmentCapture = {
    version: 1,
    collectedAt: record.detail!.collectedAt,
    complete: true,
    issues: [],
  };
  record.detail!.tabs.push({
    name: "道具/法宝",
    text: "",
    fields: [],
    tables: [],
    elements: [],
    tooltips: [],
    items: [
      {
        index: 0,
        name: "测试头盔",
        kind: "equipment",
        category: "人物装备",
        description: "等级 100\n防御 +30",
      },
      {
        index: 1,
        name: "测试腰带",
        kind: "equipment",
        category: "人物装备",
        description: "等级 100\n防御 +50\n特效：愤怒\n耐久 300",
      },
    ],
  });
  return record;
}
const result = {
  queries: ["全服 / 测试腰带"],
  items: [
    {
      key: input.equipmentKey,
      candidates: [{ price: 999, verified: false, reason: "装备属性与当前目标不同" }],
      note: "有限样本查询，未遍历全部在售商品。",
    },
  ],
  searchItems: [{ key: input.equipmentKey, pages: 1, rows: 1, details: 1, exhausted: true }],
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.savedDetail.mockReturnValue(savedRecord());
  mocks.findCandidates.mockResolvedValue(result);
  mocks.discover.mockResolvedValue({
    publicPath: "/cgi-bin/equipquery.py",
    IsLogin: false,
    controls: [{ id: "public-level", value: "100" }],
    menus: [],
    buttons: [],
    scripts: [],
  });
  mocks.close.mockResolvedValue(undefined);
  mocks.createEquipmentSource.mockResolvedValue({
    findCandidates: mocks.findCandidates,
    discover: mocks.discover,
    close: mocks.close,
  });
});
afterEach(() => vi.restoreAllMocks());

describe("同会话单件装备查价", () => {
  it("discover只读取指定装备公开表单，不查询候选、不创建AI，结束关闭自有页", async () => {
    const response = await checkEquipment(
      { ...input, mode: "discover" },
      new AbortController().signal,
    );
    expect(mocks.discover).toHaveBeenCalledOnce();
    expect(mocks.discover.mock.calls[0][0]).toMatchObject({
      key: input.equipmentKey,
      name: "测试腰带",
      level: 100,
    });
    expect(response).toMatchObject({
      target: { ...input, name: "测试腰带", level: 100 },
      mode: "discover",
      form: { IsLogin: false, controls: [{ id: "public-level" }] },
    });
    expect(response).not.toHaveProperty("items");
    expect(mocks.findCandidates).not.toHaveBeenCalled();
    expect(mocks.prepareAnalysisClient).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it("discover失败仍关闭工作页", async () => {
    mocks.discover.mockRejectedValueOnce(new Error("安全验证"));
    await expect(
      checkEquipment({ ...input, mode: "discover" }, new AbortController().signal),
    ).rejects.toThrow("安全验证");
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.findCandidates).not.toHaveBeenCalled();
  });
  it("拒绝未知mode，不打开页面", async () => {
    await expect(
      checkEquipment({ ...input, mode: "unknown" }, new AbortController().signal),
    ).rejects.toThrow("mode");
    expect(mocks.createEquipmentSource).not.toHaveBeenCalled();
  });
  it("只选择指定保存装备，保留拒绝报价与原因，完成后关闭来源且不准备AI", async () => {
    const response = await checkEquipment(input, new AbortController().signal);
    expect(mocks.savedDetail).toHaveBeenCalledWith(input.productKey);
    expect(mocks.findCandidates).toHaveBeenCalledOnce();
    expect(mocks.findCandidates.mock.calls[0][0]).toHaveLength(1);
    expect(mocks.findCandidates.mock.calls[0][0][0]).toMatchObject({
      key: input.equipmentKey,
      name: "测试腰带",
      level: 100,
    });
    expect(response).toEqual({
      target: { ...input, name: "测试腰带", level: 100 },
      ...result,
    });
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.prepareAnalysisClient).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 941, [], "", "   ", "a".repeat(101)])(
    "拒绝无效商品ID %j，不读取记录或开启来源",
    async (productKey) => {
      await expect(
        checkEquipment({ ...input, productKey }, new AbortController().signal),
      ).rejects.toThrow(/productKey/);
      expect(mocks.savedDetail).not.toHaveBeenCalled();
      expect(mocks.createEquipmentSource).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, 1, [], "", "\t", "a".repeat(101)])(
    "拒绝无效装备ID %j，不读取记录或开启来源",
    async (equipmentKey) => {
      await expect(
        checkEquipment({ ...input, equipmentKey }, new AbortController().signal),
      ).rejects.toThrow(/equipmentKey/);
      expect(mocks.savedDetail).not.toHaveBeenCalled();
      expect(mocks.createEquipmentSource).not.toHaveBeenCalled();
    },
  );

  it("拒绝不存在的保存商品", async () => {
    mocks.savedDetail.mockReturnValue(null);
    await expect(checkEquipment(input, new AbortController().signal)).rejects.toThrow(/商品不存在/);
    expect(mocks.createEquipmentSource).not.toHaveBeenCalled();
  });

  it("拒绝与查询商品ID不一致的保存记录", async () => {
    const record = savedRecord();
    record.listing.key = "132:other-role";
    mocks.savedDetail.mockReturnValue(record);
    await expect(checkEquipment(input, new AbortController().signal)).rejects.toThrow(/ID.*不一致/);
    expect(mocks.createEquipmentSource).not.toHaveBeenCalled();
  });

  it("拒绝未完成的商品详情", async () => {
    mocks.savedDetail.mockReturnValue({ ...savedRecord(), status: "pending", detail: null });
    await expect(checkEquipment(input, new AbortController().signal)).rejects.toThrow(
      /详情尚未采集完整/,
    );
    expect(mocks.createEquipmentSource).not.toHaveBeenCalled();
  });

  it("装备整体采集不完整时不启动查询", async () => {
    const record = savedRecord();
    record.detail!.equipmentCapture!.complete = false;
    record.detail!.equipmentCapture!.issues = ["仓库装备漏采"];
    mocks.savedDetail.mockReturnValue(record);
    await expect(checkEquipment(input, new AbortController().signal)).rejects.toThrow(
      /仓库装备漏采/,
    );
    expect(mocks.createEquipmentSource).not.toHaveBeenCalled();
  });

  it("拒绝不属于该商品的装备key", async () => {
    await expect(
      checkEquipment({ ...input, equipmentKey: "道具/法宝:99" }, new AbortController().signal),
    ).rejects.toThrow(/指定装备不在/);
    expect(mocks.createEquipmentSource).not.toHaveBeenCalled();
  });

  it.each([
    ["防御 +50", "装备等级缺失"],
    ["等级 100\n防御 +50\n玩家123专用", "专用或绑定"],
  ])("拒绝不可查询的装备：%s", async (description, problem) => {
    const record = savedRecord();
    record.detail!.tabs.at(-1)!.items![1].description = description;
    mocks.savedDetail.mockReturnValue(record);
    await expect(checkEquipment(input, new AbortController().signal)).rejects.toThrow(problem);
    expect(mocks.createEquipmentSource).not.toHaveBeenCalled();
  });

  it("0耐久且修理失败未达3次的装备实际查价，不套用正常耐久价格", async () => {
    const record = savedRecord();
    record.detail!.tabs.at(-1)!.items![1].description = "等级 100\n防御 +50\n耐久 0\n修理失败 2次";
    mocks.savedDetail.mockReturnValue(record);
    await checkEquipment(input, new AbortController().signal);
    expect(mocks.findCandidates).toHaveBeenCalledOnce();
    expect(mocks.findCandidates.mock.calls[0][0][0]).toMatchObject({
      status: "no_match",
      description: expect.stringContaining("耐久 0"),
    });
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("查询失败仍关闭来源并保留原始原因", async () => {
    const failure = new Error("官网要求登录");
    mocks.findCandidates.mockRejectedValueOnce(failure);
    await expect(checkEquipment(input, new AbortController().signal)).rejects.toBe(failure);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it.each(["请求取消", "300秒超时"])("%s后等待来源清理完成才返回", async (kind) => {
    const request = new AbortController(),
      timeout = new AbortController();
    const timeoutFactory = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    let started!: () => void, closing!: () => void, finishClose!: () => void;
    const queryStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const closeStarted = new Promise<void>((resolve) => {
      closing = resolve;
    });
    mocks.findCandidates.mockImplementation(
      (_items, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          started();
        }),
    );
    mocks.close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
          closing();
        }),
    );
    let settled = false;
    const operation = checkEquipment(input, request.signal).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await queryStarted;
    const reason =
      kind === "请求取消"
        ? new Error("客户端已断开")
        : new DOMException("装备查价超过300秒", "TimeoutError");
    (kind === "请求取消" ? request : timeout).abort(reason);
    await closeStarted;
    expect(timeoutFactory).toHaveBeenCalledWith(300_000);
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    finishClose();
    expect(await operation).toBe(reason);
  });

  it("已取消的请求不读取保存记录或启动查询", async () => {
    const request = new AbortController();
    const reason = new Error("请求已经取消");
    request.abort(reason);
    await expect(checkEquipment(input, request.signal)).rejects.toBe(reason);
    expect(mocks.savedDetail).not.toHaveBeenCalled();
    expect(mocks.createEquipmentSource).not.toHaveBeenCalled();
  });
});
