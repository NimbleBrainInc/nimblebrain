/**
 * `GET /iframe-bridge.js` — serves the inline-HTML bundle bridge helper.
 *
 * Bundle UIs that render as srcdoc (or otherwise inline HTML) load this
 * via `<script src="/iframe-bridge.js"></script>` and then use
 * `window.NBBridge.send(...)` / `NBBridge.on(...)` instead of raw
 * `parent.postMessage(..., "*")` and unvalidated `window.addEventListener`.
 *
 * The script is short, dependency-free, and safe to cache aggressively
 * (it's keyed implicitly to the platform deploy).
 */

import { Hono } from "hono";
import { IFRAME_BRIDGE_SCRIPT } from "../iframe-bridge-script.ts";
import type { AppContext } from "../types.ts";

export function iframeBridgeRoutes(_ctx: AppContext) {
  const app = new Hono();

  app.get("/iframe-bridge.js", (c) => {
    return c.body(IFRAME_BRIDGE_SCRIPT, 200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    });
  });

  return app;
}
