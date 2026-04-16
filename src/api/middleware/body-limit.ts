import { createMiddleware } from "hono/factory";
import { apiError } from "../types.ts";

/**
 * Request body size limit middleware.
 * Returns 413 Payload Too Large if Content-Length exceeds the limit.
 */
export function bodyLimit(maxBytes: number) {
  return createMiddleware(async (c, next) => {
    const method = c.req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      await next();
      return;
    }
    const contentLength = c.req.header("content-length");
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
      return apiError(413, "payload_too_large", "Payload too large");
    }
    await next();
  });
}
