import { readFileSync, existsSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vite-plus/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
it("installs every local host dependency and limits the manifest to one fixed extension ID", () => {
  const directory = fileURLToPath(new URL("../../native/cbg-access/", import.meta.url));
  const world: Record<string, any> = {};
  runInNewContext(
    readFileSync(path.join(directory, "install-plan.mjs"), "utf8")
      .replaceAll("export const ", "const ")
      .replaceAll("export function ", "function ") +
      "\nglobalThis.files=HOST_FILES;globalThis.manifest=nativeHostManifest;",
    world,
  );
  const host = readFileSync(path.join(directory, "host.mjs"), "utf8");
  const dependencies = [...host.matchAll(/from\s+["']\.\/([^"']+)["']/g)].map((match) => match[1]);
  expect(dependencies).toContain("command-authority.mjs");
  for (const dependency of dependencies) {
    expect(world.files).toContain(dependency);
    expect(existsSync(path.join(directory, dependency))).toBe(true);
  }
  const manifest = world.manifest("/private/tmp/host fixture", "a".repeat(32));
  expect(manifest.allowed_origins).toEqual([`chrome-extension://${"a".repeat(32)}/`]);
  expect(manifest.path).toBe("/private/tmp/host fixture/launch-host");
  expect(() => world.manifest("/private/tmp/host", "*")).toThrow();
  const installer = readFileSync(path.join(directory, "install.mjs"), "utf8");
  expect(installer).toContain("HOST_FILES.filter");
  expect(installer).toContain("for (const name of HOST_FILES)");
});
