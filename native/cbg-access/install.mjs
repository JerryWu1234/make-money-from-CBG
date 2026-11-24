#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { HOST_FILES, nativeHostManifest } from "./install-plan.mjs";
const base = path.dirname(fileURLToPath(import.meta.url));
const home = path.join(os.homedir(), "Library/Application Support/CBGAccess");
const manifest = path.join(
  os.homedir(),
  "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.cbg.access_bridge.json",
);
if (process.argv.includes("--uninstall")) {
  fs.rmSync(manifest, { force: true });
  // Remove only the dedicated host files; never Chrome profiles, browser data, or collected evidence.
  for (const name of HOST_FILES) fs.rmSync(path.join(home, name), { force: true });
  console.log("Native messaging registration removed; browser profiles and evidence retained.");
  process.exit(0);
}
const extensionId = process.argv[2],
  socketPath = process.argv[3];
if (
  process.platform !== "darwin" ||
  !/^[a-p]{32}$/.test(extensionId || "") ||
  !socketPath ||
  !path.isAbsolute(socketPath) ||
  socketPath.length > 100 ||
  socketPath.split("").some((character) => [0, 10, 13].includes(character.charCodeAt(0)))
)
  throw new Error("Usage: node install.mjs EXTENSION_ID ABSOLUTE_SOCKET_PATH (macOS only)");
fs.mkdirSync(home, { recursive: true, mode: 0o700 });
fs.chmodSync(home, 0o700);
const binary = path.join(home, "cbg-input");
const compiled = spawnSync(
  "/usr/bin/clang",
  [
    "-fobjc-arc",
    "-fblocks",
    path.join(base, "Input.m"),
    "-o",
    binary,
    "-framework",
    "Cocoa",
    "-framework",
    "ApplicationServices",
  ],
  { stdio: "inherit" },
);
if (compiled.status !== 0) process.exit(compiled.status || 1);
for (const name of HOST_FILES.filter((file) => file.endsWith(".mjs")))
  fs.copyFileSync(path.join(base, name), path.join(home, name));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
fs.writeFileSync(
  path.join(home, "launch-host"),
  `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(home, "host.mjs"))} "$@"\n`,
  { mode: 0o700 },
);
fs.writeFileSync(
  path.join(home, "host.json"),
  JSON.stringify({ version: 1, extensionId, socketPath }),
  { mode: 0o600 },
);
fs.mkdirSync(path.dirname(manifest), { recursive: true });
fs.writeFileSync(manifest, JSON.stringify(nativeHostManifest(home, extensionId), null, 2), {
  mode: 0o600,
});
console.log(
  `Installed ${manifest}. Enable Accessibility and Input Monitoring for ${binary}; screen recording is required only for screen evidence. No permission prompt was opened.`,
);
