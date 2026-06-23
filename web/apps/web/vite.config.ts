import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const pkg = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The BFF origin the dev server proxies `/bff` and `/auth` to. Overridable via
// env so `make dev` can point at a conflict-avoiding BFF port.
const bffTarget = process.env.BFF_PROXY_TARGET || "http://localhost:8787";

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
    // Overridable via env so `make dev` can pick conflict-avoiding ports.
    port: Number(process.env.WEB_PORT) || 5173,
    proxy: {
      // BFF is the only origin the app talks to. The client prefixes API calls
      // with `/bff`; the BFF mounts those routes at the root, so strip the prefix.
      "/bff": {
        target: bffTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/bff/, ""),
      },
      // Auth routes live at `/auth` on the BFF too — forwarded as-is.
      "/auth": { target: bffTarget, changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
});
