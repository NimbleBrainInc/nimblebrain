import { getRequestContext } from "../runtime/request-context.ts";
import type { SpanAttrs } from "./tracing.ts";

/**
 * Identity attributes for a span or log line, read from the verified
 * per-request context (AsyncLocalStorage) — NEVER from the wire. Opaque ids
 * only: the user's id, workspace id, and conversation id. The human display
 * name is deliberately excluded (spans/logs are operational telemetry, not a
 * user directory). Tenant id is a process/Resource constant set in
 * `initTracing`, so it is not repeated here.
 *
 * Returns an empty object outside a request scope (CLI boot, background work).
 */
export function requestIdentityAttrs(): SpanAttrs {
  const ctx = getRequestContext();
  if (!ctx) return {};
  const attrs: SpanAttrs = {};
  if (ctx.identity?.id) attrs.user_id = ctx.identity.id;
  if (ctx.workspaceId) attrs.workspace_id = ctx.workspaceId;
  if (ctx.conversationId) attrs.conversation_id = ctx.conversationId;
  // A task run is correlated by its run id, under its own attribute name. It
  // used to arrive as `conversation_id`, which is a value no conversation
  // query can join against and a label the trace cannot be trusted on.
  if (ctx.runId) attrs.run_id = ctx.runId;
  return attrs;
}
