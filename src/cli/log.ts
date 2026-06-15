/**
 * Runtime logger — two output formats, one stream (stderr).
 *
 * - **pretty** (default): colored/dimmed stderr lines, for CLI/TUI and local
 *   `bun run dev`. Unchanged from the original logger so the dev loop reads the
 *   same. stdout stays clean for JSON-RPC / pipe output.
 * - **json**: one structured JSON object per line, opted into with
 *   `NB_LOG_FORMAT=json` (the chart sets it for deployed pods). Each line is
 *   auto-enriched with `service`, `tenant_id`, `correlation_id` (the active
 *   trace id), and the verified request identity (`user_id` / `workspace_id` /
 *   `conversation_id`) so logs pivot to traces in Grafana and are queryable by
 *   tenant in Loki. Identity comes only from the verified request context, never
 *   the wire, and never includes the human display name. Still on stderr —
 *   Kubernetes captures it alongside stdout, so Promtail ingests it either way.
 *
 * Both formats keep stdout untouched.
 *
 * Debug messages are gated behind the `NB_DEBUG` environment variable. Set it
 * to a comma-separated list of namespaces to enable, or `*` for all:
 *
 *   NB_DEBUG=*         bun run dev    # everything
 *   NB_DEBUG=mcp       bun run dev    # MCP source lifecycle + dispatch
 *   NB_DEBUG=sse,mcp   bun run dev    # SSE event flow + MCP
 *
 * Known namespaces:
 *   - `mcp` — McpSource construction, dispatch decisions (task-augmented vs inline)
 *   - `sse` — Runtime event sink → SSE broadcast (tool.progress, data.changed)
 *
 * Keep this list in sync with the CLAUDE.md "Debug Logging" section so it's
 * discoverable without reading source.
 *
 * `log.bundle(sourceName, line)` is intentionally NOT gated. Bundle stderr
 * is the bundle author's deliberate diagnostic output (tracebacks, warnings,
 * logs) — different concern than NB's protocol tracing, and the dev-loop
 * cost of hiding it (see issue #116) outweighs the cost of dimmed lines on
 * a chatty bundle. Visual prefix + dim formatting makes it tunable by eye.
 */

import { requestIdentityAttrs } from "../observability/identity.ts";
import { currentTraceId } from "../observability/tracing.ts";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

/** Structured fields attached to a log line. Never put secrets or payloads here. */
export type LogFields = Record<string, unknown>;

type Level = "debug" | "info" | "warn" | "error";

// Read at call time (not module load) so the format is controllable in tests
// and a late `NB_LOG_FORMAT` still takes effect. The comparison is trivial.
const isJson = (): boolean => process.env.NB_LOG_FORMAT === "json";
const SERVICE = process.env.NB_SERVICE_NAME ?? "nimblebrain-runtime";
// Boot-time tenant of this deployment (chart -> NB_TENANT_ID). Unset in dev.
const TENANT_ID = process.env.NB_TENANT_ID;

const enabledNamespaces: Set<string> = (() => {
  const raw = process.env.NB_DEBUG ?? "";
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(items);
})();
const allNamespacesEnabled = enabledNamespaces.has("*");

function isDebugEnabled(ns: string): boolean {
  return allNamespacesEnabled || enabledNamespaces.has(ns);
}

/**
 * Emit one structured JSON line. Identity + correlation are pulled from the
 * active request context / span here, so callers never thread them manually.
 */
function emitJson(level: Level, message: string, fields?: LogFields, ns?: string): void {
  const record: LogFields = {
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE,
    ...(TENANT_ID ? { tenant_id: TENANT_ID } : {}),
    ...(ns ? { ns } : {}),
    message,
    ...requestIdentityAttrs(),
  };
  const correlationId = currentTraceId();
  if (correlationId) record.correlation_id = correlationId;
  if (fields) Object.assign(record, fields);
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

/** Pretty-mode trailer: render extra fields compactly so dev still sees them. */
function prettyFields(fields?: LogFields): string {
  if (!fields || Object.keys(fields).length === 0) return "";
  return ` ${dim(JSON.stringify(fields))}`;
}

export const log = {
  info: (msg: string, fields?: LogFields) => {
    if (isJson()) emitJson("info", msg, fields);
    else console.error(dim(msg) + prettyFields(fields));
  },
  warn: (msg: string, fields?: LogFields) => {
    if (isJson()) emitJson("warn", msg, fields);
    else console.error(yellow(msg) + prettyFields(fields));
  },
  error: (msg: string, fields?: LogFields) => {
    if (isJson()) emitJson("error", msg, fields);
    else console.error(red(msg) + prettyFields(fields));
  },
  /**
   * Emit a gated debug line. Use for tracing that is useful during
   * development / incident response but too noisy for normal operation.
   *
   * Logs only when the process was started with the matching namespace in
   * `NB_DEBUG` (or `NB_DEBUG=*`). Cheap when disabled — the enabled check is
   * a `Set.has` on a cached Set.
   */
  debug: (ns: string, msg: string, fields?: LogFields) => {
    if (!isDebugEnabled(ns)) return;
    if (isJson()) emitJson("debug", msg, fields, ns);
    else console.error(`${cyan(`[${ns}]`)} ${msg}${prettyFields(fields)}`);
  },
  /** Check whether a namespace is enabled, e.g. to skip expensive log args. */
  debugEnabled: isDebugEnabled,
  /**
   * Emit a single line of bundle subprocess stderr output. Default-on,
   * dimmed, prefixed `[bundle:<name>]` so it's visually distinct from NB's
   * own output. In JSON mode it becomes a structured `bundle.stderr` record
   * carrying the raw line, so it stays queryable per bundle. See file header.
   */
  bundle: (sourceName: string, line: string) => {
    if (isJson()) emitJson("info", "bundle.stderr", { bundle: sourceName, line }, "bundle");
    else console.error(dim(`[bundle:${sourceName}] ${line}`));
  },
};
