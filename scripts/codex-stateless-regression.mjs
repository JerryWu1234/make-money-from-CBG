import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { statelessCodexArgs } from "./codex-stateless.mjs";

void test("SDK single-shot arguments always select ephemeral mode without changing schema/provider", () => {
  const args = [
    "exec",
    "--experimental-json",
    "--output-schema",
    "/tmp/schema.json",
    "--config",
    'model_provider="openai_http"',
  ];
  assert.deepEqual(statelessCodexArgs(args), ["exec", "--ephemeral", ...args.slice(1)]);
  assert.equal(args.includes("--ephemeral"), false);
});

void test("stored conversations and other commands cannot use the single-shot entrypoint", () => {
  assert.throws(() => statelessCodexArgs(["exec", "resume", "old-thread"]), /临时会话/);
  assert.throws(() => statelessCodexArgs(["app-server"]), /临时会话/);
});

void test("the SDK executable entrypoint launches the bundled CLI and rejects resume", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "cbg-stateless-exec-check-")));
  const executable = fileURLToPath(new URL("./codex-stateless.mjs", import.meta.url));
  const env = { ...process.env, CODEX_HOME: home, CODEX_SQLITE_HOME: home };
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL"])
    delete env[key];
  try {
    const help = spawnSync(executable, ["exec", "--help"], {
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(help.status, 0, String(help.error || help.stderr));
    assert.match(help.stdout, /--ephemeral/);
    const resume = spawnSync(executable, ["exec", "resume", "old-thread"], {
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.notEqual(resume.status, 0);
    assert.match(resume.stderr, /只允许新建临时会话/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
