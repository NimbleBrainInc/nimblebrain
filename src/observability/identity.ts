import type { SpanAttrs } from "./tracing.ts";

/**
 * Identity attributes for a span or log line, read from the verified
 * per-request context — NEVER from the wire. Opaque ids only: the user's id,
 * workspace id, conversation id, and a task run's id. The human display name
 * is deliberately excluded (spans/logs are operational telemetry, not a user
 * directory). Tenant id is a process/Resource constant set in `initTracing`,
 * so it is not repeated here.
 *
 * The request context belongs to the runtime, which registers the source when
 * it loads (`src/runtime/request-context.ts`). Observability imports nothing of
 * the runtime, so a process that runs only the engine (an ACP agent) logs with
 * no identity rather than carrying the runtime to find none.
 *
 * Returns an empty object outside a request scope (CLI boot, background work)
 * and in a process with no runtime.
 */
let identitySource: () => SpanAttrs = () => ({});

export function requestIdentityAttrs(): SpanAttrs {
  return identitySource();
}

/** Install where identity attributes come from. Called once, by the runtime's request context. */
export function setRequestIdentitySource(source: () => SpanAttrs): void {
  identitySource = source;
}
