// Isolated HTTP adapter for the restart E2E. Only SQLite, profile loading, and
// analysis queries use production code; captured roles and AI responses are fixtures.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite-plus";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const [database, clock, requestedPort = "0"] = process.argv.slice(2);
if (!database || !Number.isFinite(Number(clock)))
  throw new Error("Missing fixture database or clock");
Date.now = () => Number(clock);

const vite = await createViteServer({
  root: repository,
  configFile: false,
  appType: "custom",
  server: { middlewareMode: true, watch: null },
});
const { CrawlStore } = await vite.ssrLoadModule("/server/crawler/store.ts");
const { AnalysisStore } = await vite.ssrLoadModule("/server/analysis/store.ts");
const { loadProfile } = await vite.ssrLoadModule("/server/analysis/profile.ts");
const crawl = new CrawlStore(database);
const store = new AnalysisStore(crawl.db);
const promptFile = path.join(repository, "prompts/role-valuation.md");
const profile = () => loadProfile(crawl.db, promptFile, { allowExpiredMarket: true });
const dist = path.join(repository, "dist");

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const json = (body, status = 200) => {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(body));
  };
  try {
    switch (url.pathname) {
      case "/api/runtime/settings":
        return json({ saveScreenshots: false });
      case "/api/browser/settings":
        return json({ mode: "daily", connected: true, busy: false });
      case "/api/ai/status":
        return json({
          codex: { state: "connected", model: "fixture-model", response: "READY" },
          deepseek: { state: "unconfigured" },
        });
      case "/api/ai/models":
        return json({
          provider: "codex",
          defaultModel: "fixture-model",
          models: [{ id: "fixture-model", name: "重启测试模型" }],
        });
      case "/api/analysis/status":
      case "/api/analysis/progress":
        return json(
          store.overview({
            currentProfile: profile(),
            scope: "complete",
            summary: true,
            page: Number(url.searchParams.get("page") || 1),
            resultsPage: Number(url.searchParams.get("resultsPage") || 1),
            rankingPage: Number(url.searchParams.get("rankingPage") || 1),
            showViewed: url.searchParams.get("showViewed") === "true",
            includeRanking: url.searchParams.get("includeRanking") !== "false",
          }),
        );
      case "/api/analysis/detail":
        return json(store.detail(url.searchParams.get("taskId"), profile()));
      case "/api/analysis/recommendation/view": {
        let body = "";
        for await (const chunk of request) body += chunk;
        return json(store.markRecommendationViewed(JSON.parse(body).key));
      }
      default:
        if (url.pathname.startsWith("/api/")) return json({ error: "Unexpected fixture API" }, 404);
    }
    const filename = path.resolve(
      dist,
      "." + (url.pathname === "/analysis-preview" ? "/index.html" : url.pathname),
    );
    if (!filename.startsWith(dist + path.sep)) return json({ error: "Not found" }, 404);
    response.writeHead(200, {
      "Content-Type": filename.endsWith(".js")
        ? "application/javascript"
        : filename.endsWith(".css")
          ? "text/css"
          : "text/html",
    });
    response.end(await readFile(filename));
  } catch (error) {
    json({ error: String(error) }, 500);
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(Number(requestedPort), "127.0.0.1", resolve);
});
const address = server.address();
console.log(
  JSON.stringify({ event: "ready", pid: process.pid, port: address.port, now: Date.now() }),
);
process.once("SIGTERM", async () => {
  await new Promise((resolve) => server.close(resolve));
  crawl.close();
  await vite.close();
  process.exit(0);
});
