#!/usr/bin/env node
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The bundled SDK does not expose exec's ephemeral flag. Keep its event/schema
// handling, but run its one-shot requests through the official CLI entrypoint.
export function statelessCodexArgs(args) {
  if (args[0] !== "exec" || args.includes("resume"))
    throw new Error("Codex 单次调用只允许新建临时会话");
  return ["exec", "--ephemeral", ...args.slice(1)];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sdkRequire = createRequire(import.meta.resolve("@openai/codex-sdk"));
  const cli = join(dirname(sdkRequire.resolve("@openai/codex/package.json")), "bin", "codex.js");
  process.argv = [process.execPath, cli, ...statelessCodexArgs(process.argv.slice(2))];
  // Import in this process so the official launcher retains its signal forwarding
  // and exit handling, without adding another parent/child lifetime to manage.
  await import(pathToFileURL(cli).href);
}
