import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import { apiMiddleware } from "./server/api";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "cbg-browser-middleware",
      configureServer(server) {
        server.middlewares.use(apiMiddleware);
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    watch: { ignored: ["**/.chrome-cbg-profile/**", "**/.git/**", "**/data/**"] },
  },
  fmt: {},
  lint: { options: { typeAware: true, typeCheck: true } },
});
