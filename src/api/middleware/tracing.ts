import { createMiddleware } from "hono/factory";
import { withInboundSpan } from "../../observability/index.ts";

// Mirror the metrics middleware: clamp the method to the standard verbs so a
// client can't inflate span-name cardinality with arbitrary HTTP method tokens
// (this runs before auth).
const STANDARD_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/**
 * Opens the outer HTTP span for every request, continued from an inbound W3C
 * `traceparent` when present (e.g. the mcp-edge -> runtime hop) so the trace is
 * one across services. The internal `agent.turn` / `llm.call` / `tool.dispatch`
 * spans nest under it for the synchronous chat path.
 *
 * Identity is deliberately NOT stamped here — auth runs later in the chain, and
 * the trust rule forbids reading identity off the raw request. The verified
 * identity lands on `agent.turn` from the request context instead.
 *
 * The span name uses the matched route template (`c.req.routePath`), known only
 * after routing, so it is refined via `setName` once `next()` resolves. The
 * `/metrics` scrape is skipped to keep Prometheus' own polling out of traces.
 */
export function tracingMiddleware() {
  return createMiddleware(async (c, next) => {
    if (c.req.path === "/metrics") {
      return next();
    }
    const method = STANDARD_METHODS.has(c.req.method) ? c.req.method : "OTHER";
    await withInboundSpan(
      `HTTP ${method}`,
      c.req.raw.headers,
      { "http.method": method },
      async (span) => {
        await next();
        const route = c.req.routePath || "/*";
        span.setName(`${method} ${route}`);
        span.setAttrs({ "http.route": route, "http.status_code": c.res.status });
      },
    );
  });
}
