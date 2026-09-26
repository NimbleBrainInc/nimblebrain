import { Hono } from "hono";
import { resolvedBrand } from "../../brand/index.ts";

/**
 * `GET /v1/brand` — the deployment's brand block, or `{}` for NimbleBrain.
 *
 * Unauthenticated and publicly cacheable on purpose. The login page paints the
 * brand before anyone has signed in, so it cannot sit behind the session it is
 * asking the visitor to start. Nothing in it is private: a name, public asset
 * URLs, colours and fonts — all of which every visitor's browser renders
 * anyway. A minute of cache keeps a config change visible without a redeploy
 * of anything in front of the runtime.
 */
export function brandRoutes() {
  return new Hono().get("/v1/brand", (c) => {
    c.header("Cache-Control", "public, max-age=60");
    return c.json(resolvedBrand());
  });
}
