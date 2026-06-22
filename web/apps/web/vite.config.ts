import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const pkg = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Map workspace packages to their TS source so Vite transpiles them directly
    // (the packages publish source, not a build).
    alias: {
      "@carrier/contract": pkg("../../packages/contract/src/index.ts"),
      "@carrier/ui": pkg("../../packages/ui/src/index.ts"),
      "@carrier/carrier-client": pkg("../../packages/carrier-client/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // BFF is the only origin the app talks to.
      "/bff": { target: "http://localhost:8787", changeOrigin: true },
      "/auth": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
});
