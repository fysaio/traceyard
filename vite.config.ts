import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The product does not need a listening Worker debugger. Explicitly disable it so
// dev startup does not rely on probing host interfaces for an inspector port.
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    cloudflare({
      configPath:
        mode === "acceptance"
          ? "wrangler.acceptance.jsonc"
          : mode === "managed"
            ? "wrangler.managed.jsonc"
            : "wrangler.jsonc",
      inspectorPort: false,
      viteEnvironment: { name: "worker" },
    }),
  ],
  environments: {
    worker: { build: { sourcemap: true } },
  },
  server: {
    port: 5173,
  },
}));
