import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import { apiMiddleware } from "./server/api";
import { initializeScanSchedule, shutdownScanSchedule } from "./server/crawler/schedule";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "cbg-browser-middleware",
      configureServer(server) {
        server.middlewares.use(apiMiddleware);
        if (server.httpServer) {
          initializeScanSchedule();
          server.httpServer.once("close", () => {
            void shutdownScanSchedule();
            void import("./server/analysis/controller").then(async (analysis) => {
              await analysis.shutdownAnalysis();
              await (await import("./server/ai-connection")).shutdownAiConnections();
            });
          });
        }
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    watch: { ignored: ["**/.chrome-cbg-profile/**", "**/.git/**", "**/data/**"] },
  },
  // Preserve the user's prompt bytes and their recorded SHA-256.
  fmt: { ignorePatterns: ["prompts/role-valuation.md"] },
  lint: { options: { typeAware: true, typeCheck: true } },
});
