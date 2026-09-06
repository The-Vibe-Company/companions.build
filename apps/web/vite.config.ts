import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiPort = env.API_PORT || "4311";

  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./src") } },
    server: {
      port: Number(env.WEB_PORT || 4310),
      strictPort: true,
      proxy: { "/api": `http://127.0.0.1:${apiPort}` },
    },
    test: {
      environment: "jsdom",
      setupFiles: "./src/test/setup.ts",
      restoreMocks: true,
    },
  };
});
