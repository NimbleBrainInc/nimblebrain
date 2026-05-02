import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Mirrors the tsconfig path alias so `@platform/schemas/*` resolves
      // identically at build time and at type-check time. Today the only
      // consumers use `import type` (Vite/esbuild erases these), but a
      // future runtime import would 404 in dev without this alias —
      // adding it preemptively avoids a confusing debugging session.
      "@platform/schemas": path.resolve(__dirname, "../src/tools/platform/schemas"),
    },
  },
  server: {
    port: process.env.NB_WEB_PORT ? Number(process.env.NB_WEB_PORT) : 27246,
    proxy: {
      "/v1": {
        target: `http://localhost:${process.env.NB_API_PORT ?? 27247}`,
        changeOrigin: true,
      },
      // Bridge's MCP transport (StreamableHTTPClientTransport) POSTs to
      // `/mcp` against the page origin. Without this proxy the dev server
      // 404s and the SDK surfaces a generic "Error POSTing to endpoint".
      "/mcp": {
        target: `http://localhost:${process.env.NB_API_PORT ?? 27247}`,
        changeOrigin: true,
      },
    },
  },
});
