import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { expect, it } from "vite-plus/test";
import { codexHomeDirectory, codexHomeEnv } from "./codex-home";

// Failures: Vite can serve credentials; different projects share state; restarted
// services select different homes; desktop state leaks; proxies are lost or mode is public.
it("使用项目专属私有目录，保留代理并隔离桌面会话和 API Key", () => {
  const root = mkdtempSync(join(tmpdir(), "cbg-codex-home-test-"));
  try {
    const project = join(root, "project-a"),
      otherProject = join(root, "project-b");
    const userHome = join(root, "home");
    mkdirSync(project);
    mkdirSync(otherProject);
    mkdirSync(userHome);
    expect(() => codexHomeEnv({}, userHome, userHome)).toThrow("不能位于项目网页目录内");
    const expected = codexHomeDirectory(project, userHome);
    const insideProject = relative(project, expected);
    expect(insideProject.startsWith("..") || isAbsolute(insideProject)).toBe(true);
    expect(codexHomeDirectory(project, userHome)).toBe(expected);
    expect(codexHomeDirectory(otherProject, userHome)).not.toBe(expected);
    const env = codexHomeEnv(
      {
        CODEX_HOME: "/desktop-home",
        CODEX_SQLITE_HOME: "/desktop-sqlite",
        OPENAI_API_KEY: "fixture",
        CODEX_API_KEY: "fixture",
        OPENAI_BASE_URL: "https://fixture.invalid",
        HTTPS_PROXY: "http://127.0.0.1:9999",
      },
      project,
      userHome,
    );
    expect(env).toEqual({
      CODEX_HOME: expected,
      CODEX_SQLITE_HOME: expected,
      HTTPS_PROXY: "http://127.0.0.1:9999",
    });
    if (process.platform !== "win32") expect(statSync(expected).mode & 0o777).toBe(0o700);
    expect(codexHomeEnv({}, project, userHome).CODEX_HOME).toBe(expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("拒绝家目录下的符号链接将登录数据重定向到网页目录", () => {
  const root = mkdtempSync(join(tmpdir(), "cbg-codex-home-symlink-"));
  try {
    const project = join(root, "project");
    const userHome = join(root, "home");
    mkdirSync(project);
    mkdirSync(userHome);
    symlinkSync(project, join(userHome, ".local"), "dir");
    expect(() => codexHomeEnv({}, project, userHome)).toThrow("不能通过符号链接重定向");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
