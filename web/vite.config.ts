import path from "path";
import type { Connect, Plugin } from "vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Serve fonts with `Access-Control-Allow-Origin` locally.
 *
 * The local counterpart to the `@fonts` matcher in `web/Caddyfile`, required for
 * the same reason: fonts are fetched in CORS mode, and an embedded app runs in an
 * opaque origin (`srcdoc` without `allow-same-origin`), so its font requests
 * arrive with `Origin: null` and are blocked without this. Vite's own CORS
 * handling reflects concrete origins and does not cover `null`.
 *
 * This and the Caddyfile are two implementations of one rule, and only the
 * Caddyfile has a CI gate — deliberately. That one guards the config the image
 * actually ships; dev and preview are local-only, so the worst case here is a
 * developer's own check missing a header, never a user. Keep both hooks below in
 * step by reading them together, since they are four lines apart.
 *
 * Registered on BOTH dev and preview. `vite preview` is the only local server
 * that serves the built bundle, so it is where you would check this feature
 * before shipping — and a dev-only hook would leave that one check failing in
 * the exact silent mode the feature exists to remove.
 *
 * Scoped to font files deliberately — this is not a blanket CORS opening.
 */
const FONT_PATH = /\.woff2(\?|$)/;

const fontCors: Plugin = {
  name: "nb-font-cors",
  configureServer: (server) => attachFontCors(server.middlewares),
  configurePreviewServer: (server) => attachFontCors(server.middlewares),
};

function attachFontCors(middlewares: Connect.Server): void {
  middlewares.use((req, res, next) => {
    if (req.url && FONT_PATH.test(req.url)) {
      res.setHeader("Access-Control-Allow-Origin", "*");
    }
    next();
  });
}

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
