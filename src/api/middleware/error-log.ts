import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createMiddleware } from "hono/factory";
import type { EventSink } from "../../engine/types.ts";
import type { Runtime } from "../../runtime/runtime.ts";
import type { AppEnv } from "../types.ts";

interface ErrorLogDeps {
  runtime: Runtime;
  eventSink: EventSink;
}

/**
 * HTTP error logging middleware for workspace-scoped routes.
 *
 * Runs after the handler completes. For any 4xx/5xx response, writes a
 * structured JSONL record to the workspace's log directory so that
 * ActivityCollector (and `home__activity`) can surface it.
 *
 * Also emits an `http.error` event to the global EventSink for PostHog
 * and any other sinks in the pipeline.
 */
export function errorLog({ runtime, eventSink }: ErrorLogDeps) {
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

    // Write to workspace-scoped log (where ActivityCollector reads from)
    try {
      const wsDir = runtime.getWorkspaceScopedDir(workspaceId);
      const logDir = join(wsDir, "logs");
      mkdirSync(logDir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      appendFileSync(join(logDir, `nimblebrain-${today}.jsonl`), `${JSON.stringify(record)}\n`);
    } catch {
      // Best-effort — don't let logging failures affect the response
    }

    // Emit to global EventSink (PostHog, future sinks)
    eventSink.emit({
      type: "http.error",
      data: record,
    });
  });
}
