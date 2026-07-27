import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Serve fonts with `Access-Control-Allow-Origin` in dev.
 *
 * Mirrors the `@fonts` matcher in `web/Caddyfile`, and is required for the same
 * reason: fonts are fetched in CORS mode, and an embedded app runs in an opaque
 * origin (`srcdoc` without `allow-same-origin`), so its font requests arrive
 * with `Origin: null` and are blocked without this. Vite's own CORS handling
 * reflects concrete origins and does not cover `null`.
 *
 * Scoped to font files deliberately — this is not a blanket dev-server CORS
 * opening.
 */
const fontCors = {
  name: "nb-font-cors",
  configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: { setHeader: (k: string, v: string) => void }, next: () => void) => void) => void } }) {
    server.middlewares.use((req, res, next) => {
      if (req.url && /\.woff2?(\?|$)/.test(req.url)) {
        res.setHeader("Access-Control-Allow-Origin", "*");
      }
      next();
    });
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss(), fontCors],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
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
