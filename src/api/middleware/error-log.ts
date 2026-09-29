import { createMiddleware } from "hono/factory";
import type { EventSink } from "../../engine/types.ts";
import type { AppEnv } from "../types.ts";

interface ErrorLogDeps {
  eventSink: EventSink;
}

/**
 * HTTP error logging middleware for workspace-scoped routes.
 *
 * Runs after the handler completes. For any 4xx/5xx response, emits an
 * `http.error` event to the EventSink, where the workspace log sink records it
 * under its retention and every other sink in the pipeline sees it too.
 */
export function errorLog({ eventSink }: ErrorLogDeps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    await next();

    if (c.res.status < 400) return;

    const workspaceId = c.var.workspaceId;
    const identity = c.var.identity;
    const url = new URL(c.req.url);

    // Read error body from the response (clone to avoid consuming the stream)
    let errorCode = "unknown";
    let errorMessage = c.res.statusText;
    try {
      const cloned = c.res.clone();
      const body = (await cloned.json()) as { error?: string; message?: string };
      if (body.error) errorCode = body.error;
      if (body.message) errorMessage = body.message;
    } catch {
      // Response body may not be JSON (e.g., SSE streams, empty 401)
    }

    const record = {
      ts: new Date().toISOString(),
      event: "http.error",
      status: c.res.status,
      method: c.req.method,
      path: url.pathname,
      error: errorCode,
      message: errorMessage,
      userId: identity?.id ?? null,
      workspaceId: workspaceId ?? null,
    };

    eventSink.emit({
      type: "http.error",
      data: record,
    });
  });
}
