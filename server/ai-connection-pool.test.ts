import { beforeEach, expect, it, vi } from "vite-plus/test";

// 失败方式：跳过账号校验、取消后旧请求迟到、丢失限流错误或未传递会话清理。
const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  model: vi.fn(),
  models: vi.fn(),
  constructed: vi.fn(),
  acquire: vi.fn(),
  run: vi.fn(),
  release: vi.fn(),
  close: vi.fn(),
  beginBatch: vi.fn(),
  finishBatch: vi.fn(),
  batchRun: vi.fn(),
}));
vi.mock("./ai/codex-lifecycle", () => ({
  beginCodexBatch: mocks.beginBatch,
  withCodexOperation: (work: () => Promise<unknown>) => work(),
  CodexCleanupError: class extends Error {
    readonly code = "CODEX_CLEANUP_FAILED";
  },
}));
vi.mock("./ai/codex", () => ({
  codexAccount: mocks.account,
  codexModel: mocks.model,
  codexModels: mocks.models,
  requestCodex: vi.fn(),
  probeCodex: vi.fn(),
  shutdownCodex: vi.fn(),
  cancelPendingCodexLogin: vi.fn(),
  startCodexLogin: vi.fn(),
  codexLoginStatus: vi.fn(),
  cancelCodexLogin: vi.fn(),
}));
vi.mock("./ai/codex-pool", () => ({
  CodexPool: class {
    constructor(size: number, model: string) {
      mocks.constructed(size, model);
    }
    acquire = mocks.acquire;
    close = mocks.close;
  },
}));

const account = { type: "chatgpt", email: "fixture@example.invalid", planType: "pro" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.account.mockResolvedValue(account);
  mocks.model.mockResolvedValue("configured-model");
  mocks.models.mockResolvedValue([{ id: "configured-model", name: "测试模型" }]);
  mocks.acquire.mockResolvedValue({ run: mocks.run, release: mocks.release });
  mocks.run.mockResolvedValue({ text: "result", usage: { input_tokens: 1 } });
  mocks.release.mockResolvedValue(undefined);
  mocks.close.mockResolvedValue(undefined);
  mocks.finishBatch.mockResolvedValue(undefined);
  mocks.batchRun.mockImplementation((work: () => Promise<unknown>) => work());
  mocks.beginBatch.mockResolvedValue({ run: mocks.batchRun, finish: mocks.finishBatch });
});

it("会话池保留模型、并发、账号校验和请求参数，并交由调用方释放", async () => {
  const { prepareAnalysisClient } = await import("./ai-connection");
  const client = await prepareAnalysisClient("codex");
  if (!("createSessionPool" in client) || !client.createSessionPool)
    throw new Error("未创建 Codex 会话池");
  const pool = client.createSessionPool(10);
  const signal = new AbortController().signal;
  const lease = await pool.acquire(signal);
  const schema = { type: "object" };
  expect(mocks.constructed).toHaveBeenCalledWith(10, "configured-model");
  expect(mocks.acquire).toHaveBeenCalledWith(signal);
  await expect(
    lease.analyze("角色原文", schema, signal, { bareRoleReview: true }),
  ).resolves.toEqual({
    text: "result",
    usage: { input_tokens: 1 },
  });
  expect(mocks.account).toHaveBeenCalledTimes(2);
  expect(mocks.run).toHaveBeenCalledWith("角色原文", schema, signal, { bareRoleReview: true });
  await lease.release(true);
  await pool.close();
  expect(mocks.release).toHaveBeenCalledWith(true);
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.finishBatch).toHaveBeenCalledOnce();
  expect(mocks.close.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.finishBatch.mock.invocationCallOrder[0]!,
  );
});

it("关闭批次先等待分析进程退出，再清共享缓存，重复关闭只执行一次", async () => {
  const { prepareAnalysisClient } = await import("./ai-connection");
  const client = await prepareAnalysisClient("codex");
  if (!("createSessionPool" in client) || !client.createSessionPool) throw new Error("缺少会话池");
  const pool = client.createSessionPool(10);
  let stopped!: () => void;
  mocks.close.mockImplementation(() => new Promise<void>((resolve) => (stopped = resolve)));
  const closing = pool.close();
  await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
  expect(mocks.finishBatch).not.toHaveBeenCalled();
  stopped();
  await closing;
  await pool.close();
  expect(mocks.finishBatch).toHaveBeenCalledOnce();
  expect(mocks.close).toHaveBeenCalledOnce();
});

it("分析进程关闭和缓存清理都失败时保留两个原因，仍尝试批次收尾", async () => {
  const { prepareAnalysisClient } = await import("./ai-connection");
  const client = await prepareAnalysisClient("codex");
  if (!("createSessionPool" in client) || !client.createSessionPool) throw new Error("缺少会话池");
  const pool = client.createSessionPool(1);
  const stopError = new Error("进程未退出");
  const cleanError = new Error("目录被占用");
  mocks.close.mockRejectedValueOnce(stopError);
  mocks.finishBatch.mockRejectedValueOnce(cleanError);
  await expect(pool.close()).rejects.toMatchObject({
    code: "CODEX_CLEANUP_FAILED",
    cause: expect.objectContaining({ errors: [stopError, cleanError] }),
  });
  expect(mocks.finishBatch).toHaveBeenCalledOnce();
});

it("账号已变化时不让已获取的会话启动模型请求", async () => {
  const { prepareAnalysisClient } = await import("./ai-connection");
  const client = await prepareAnalysisClient("codex");
  if (!("createSessionPool" in client) || !client.createSessionPool)
    throw new Error("未创建 Codex 会话池");
  const signal = new AbortController().signal;
  const lease = await client.createSessionPool(1).acquire(signal);
  mocks.account.mockResolvedValueOnce({ ...account, email: "other@example.invalid" });
  await expect(lease.analyze("角色原文", {}, signal)).rejects.toThrow("账号已变化");
  expect(mocks.run).not.toHaveBeenCalled();
});

it("账号检查期间取消时，不让迟到请求启动模型", async () => {
  const { prepareAnalysisClient } = await import("./ai-connection");
  const client = await prepareAnalysisClient("codex");
  if (!("createSessionPool" in client) || !client.createSessionPool)
    throw new Error("未创建 Codex 会话池");
  const controller = new AbortController();
  const lease = await client.createSessionPool(1).acquire(controller.signal);
  let finishAccount!: (value: typeof account) => void;
  mocks.account.mockImplementationOnce(() => new Promise((resolve) => (finishAccount = resolve)));
  const result = lease.analyze("角色原文", {}, controller.signal);
  controller.abort(new Error("已暂停"));
  finishAccount(account);
  await expect(result).rejects.toThrow("已暂停");
  expect(mocks.run).not.toHaveBeenCalled();
});

it("会话请求的429保留限流分类", async () => {
  const { prepareAnalysisClient } = await import("./ai-connection");
  const client = await prepareAnalysisClient("codex");
  if (!("createSessionPool" in client) || !client.createSessionPool)
    throw new Error("未创建 Codex 会话池");
  const signal = new AbortController().signal;
  const lease = await client.createSessionPool(1).acquire(signal);
  mocks.run.mockRejectedValueOnce(new Error("429 Too Many Requests"));
  await expect(lease.analyze("角色原文", {}, signal)).rejects.toMatchObject({ kind: "rate_limit" });
});
