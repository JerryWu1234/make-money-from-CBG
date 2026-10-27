import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { createServer, resolveConfig } from "vite-plus";
import { expect, it } from "vite-plus/test";
import projectConfig from "../vite.config";
import { codexHomeGuard } from "../vite.config";

// Failure cases: a workspace root exposes the isolated auth or session files via
// /@fs/, direct paths or symlink aliases bypass the deny rule, or adding it
// removes Vite's defaults.
it("Vite blocks project Codex home and retains its default sensitive-file rules", async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "cbg-vite-guard-")));
  const project = join(workspace, "project");
  const home = join(workspace, ".local/share/make-money-from-cbg/fixture/codex-home");
  await mkdir(project, { recursive: true });
  await mkdir(join(home, "sessions"), { recursive: true });
  await writeFile(join(workspace, "pnpm-workspace.yaml"), "packages: []\n");
  await writeFile(join(home, "auth.json"), '{"fixture":true}');
  await writeFile(join(home, "sessions", "fixture.jsonl"), '{"fixture":true}\n');
  await writeFile(join(project, "normal.txt"), "ordinary fixture");
  await writeFile(join(project, "normal%2Ffile"), "encoded fixture");
  await writeFile(join(project, ".env"), "fixture only");
  await symlink(join(home, "auth.json"), join(project, "alias.json"));
  await symlink(join(home, "auth.json"), join(project, "alias%2Fsecret"));
  await symlink(join(home, "auth.json"), join(project, "alias%3Fsecret"));
  await symlink(join(home, "auth.json"), join(project, "alias%23secret"));
  await symlink(join(home, "auth.json"), join(project, "lower%2fsecret"));
  await symlink(join(home, "sessions"), join(project, "session-alias"), "dir");
  await mkdir(join(project, "public"));
  await symlink(join(home, "auth.json"), join(project, "public", "public-alias.json"));

  async function status(server: Awaited<ReturnType<typeof createServer>>, url: string) {
    let bytes = "";
    const socket = new Duplex({
      read() {},
      write(chunk, _encoding, callback) {
        bytes += chunk.toString();
        callback();
      },
    }) as unknown as Socket;
    const request = new IncomingMessage(socket);
    request.url = url;
    request.method = "GET";
    request.headers = { host: "localhost" };
    const response = new ServerResponse(request);
    response.assignSocket(socket);
    await new Promise<void>((resolve, reject) => {
      response.once("finish", resolve);
      server.middlewares(request, response, (error?: unknown) => {
        if (error) reject(error);
        else response.end();
      });
    });
    socket.destroy();
    return { code: response.statusCode, bytes };
  }

  async function withServer(
    root: string,
    run: (server: Awaited<ReturnType<typeof createServer>>) => Promise<void>,
  ) {
    const server = await createServer({
      root,
      configFile: false,
      plugins: [codexHomeGuard(() => home)],
      appType: "custom",
      server: {
        middlewareMode: true,
        fs: projectConfig.server?.fs,
        hmr: false,
        ws: false,
        watch: null,
      },
    });
    try {
      await run(server);
    } finally {
      await server.close();
    }
  }
  try {
    const defaults = await resolveConfig({ configFile: false }, "serve");
    expect(projectConfig.server?.fs?.deny).toEqual(expect.arrayContaining(defaults.server.fs.deny));
    await withServer(project, async (server) => {
      expect(server.config.server.fs.allow).toContain(workspace);
      expect((await status(server, `/@fs/${home}/auth.json`)).code).toBe(403);
      expect((await status(server, `/@fs/${home}/sessions/fixture.jsonl`)).code).toBe(403);
      expect((await status(server, "/alias.json")).code).toBe(403);
      expect((await status(server, `/@fs/${project}/alias.json`)).code).toBe(403);
      expect((await status(server, "/alias%2Fsecret")).code).toBe(403);
      expect((await status(server, `/@fs/${project}/alias%2Fsecret`)).code).toBe(403);
      expect((await status(server, "/alias%252Fsecret")).code).toBe(403);
      expect((await status(server, `/@fs/${project}/alias%252Fsecret`)).code).toBe(403);
      expect((await status(server, "/alias%3Fsecret")).code).toBe(403);
      expect((await status(server, `/@fs/${project}/alias%3Fsecret`)).code).toBe(403);
      expect((await status(server, "/alias%23secret")).code).toBe(403);
      expect((await status(server, `/@fs/${project}/alias%23secret`)).code).toBe(403);
      expect((await status(server, "/lower%2fsecret")).code).toBe(403);
      expect((await status(server, `/@fs/${project}/lower%2fsecret`)).code).toBe(403);
      expect((await status(server, "/session-alias/fixture.jsonl")).code).toBe(403);
      expect((await status(server, `/@fs/${project}/session-alias/fixture.jsonl`)).code).toBe(403);
      expect((await status(server, "/public-alias.json")).code).toBe(403);
      expect((await status(server, "/.env")).code).toBe(403);
      expect((await status(server, "/normal.txt")).bytes).toContain("ordinary fixture");
      expect((await status(server, "/normal%2Ffile")).bytes).toContain("encoded fixture");
    });
    await withServer(workspace, async (server) => {
      expect(
        (await status(server, "/.local/share/make-money-from-cbg/fixture/codex-home/auth.json"))
          .code,
      ).toBe(403);
      expect(
        (
          await status(
            server,
            "/.local/share/make-money-from-cbg/fixture/codex-home/sessions/fixture.jsonl",
          )
        ).code,
      ).toBe(403);
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
