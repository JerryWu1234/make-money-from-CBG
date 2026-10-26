import { beforeEach, expect, it, vi } from "vite-plus/test";
import { openDedicatedBrowser } from "./dedicated-browser";

const mocks = vi.hoisted(() => ({ launch: vi.fn(), record: vi.fn(), mkdir: vi.fn() }));
vi.mock("playwright-core", () => ({ chromium: { launchPersistentContext: mocks.launch } }));
vi.mock("node:fs/promises", () => ({ mkdir: mocks.mkdir }));
vi.mock("./diagnostics", () => ({ diagnostics: { record: mocks.record } }));
beforeEach(() => vi.clearAllMocks());

it("复现已启动进程后初始化超时：明确分类，保留原错误且不误报安装或目录占用", async () => {
  const original = Object.assign(
    new Error(
      "browserType.launchPersistentContext: Timeout 180000ms exceeded.\n<launched> pid=20530",
    ),
    { name: "TimeoutError" },
  );
  mocks.launch.mockRejectedValue(original);
  const error = await openDedicatedBrowser("/temporary/profile").catch(
    (failure: unknown) => failure,
  );
  expect(error).toMatchObject({
    name: "DedicatedBrowserLaunchError",
    kind: "timeout",
    cause: original,
  });
  expect((error as Error).message).toContain("初始化超时");
  expect((error as Error).message).not.toContain("确认已安装");
  expect(mocks.launch).toHaveBeenCalledOnce();
  expect(mocks.launch).toHaveBeenCalledWith(
    "/temporary/profile",
    expect.objectContaining({ timeout: 60_000 }),
  );
  expect(mocks.record).toHaveBeenCalledWith(
    "browser.launch_error",
    expect.objectContaining({ kind: "timeout", childPid: 20530, directory: "/temporary/profile" }),
  );
});

it.each([
  ["Executable doesn't exist at /Applications/Google Chrome.app", "not_installed"],
  ["Failed to create a ProcessSingleton for your profile directory", "profile_in_use"],
  ["Target page, context or browser has been closed", "launch_failed"],
])("只按实际启动证据分类：%s", async (message, kind) => {
  mocks.launch.mockRejectedValue(new Error(message));
  await expect(openDedicatedBrowser("/temporary/profile")).rejects.toMatchObject({ kind });
  expect(mocks.launch).toHaveBeenCalledOnce();
});
