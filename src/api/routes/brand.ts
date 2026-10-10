import { Hono } from "hono";
import { resolvedBrand } from "../../brand/index.ts";
import type { BrandResponse } from "../schemas/responses.ts";

/**
 * The script body: one assignment of the brand to `window.__NB_BRAND__`.
 *
 * `JSON.stringify` output is a valid JavaScript expression, and the script is
 * loaded from its own URL rather than inlined into HTML, so no `</script>` in a
 * value can end it early.
 */
export function brandScript(brand: BrandResponse): string {
  return `window.__NB_BRAND__ = ${JSON.stringify(brand)};\n`;
}

/**
 * `GET /v1/brand.js` — the deployment's brand block as a script, `{}` for
 * NimbleBrain.
 *
 * The web shell loads it with a plain `<script>` before its module bundle, so
 * the brand is applied before the first paint, the sign-in page included. That
 * is why it is unauthenticated and publicly cacheable: it is read before anyone
 * has signed in, and nothing in it is private (a name, public asset URLs,
 * colours and fonts that every visitor's browser renders anyway). A minute of
 * cache keeps a config change visible without a redeploy of anything in front
 * of the runtime.
 */
export function brandRoutes() {
  return new Hono().get("/v1/brand.js", () => {
    return new Response(brandScript(resolvedBrand()), {
      status: 200,
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
  });
}
