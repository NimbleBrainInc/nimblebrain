/**
 * Runtime logger — two output formats, one stream (stderr).
 *
 * - **pretty** (default): colored/dimmed stderr lines, for CLI/TUI and local
 *   `bun run dev`. Unchanged from the original logger so the dev loop reads the
 *   same. stdout stays clean for JSON-RPC / pipe output.
 * - **json**: one structured JSON object per line, opted into with
 *   `NB_LOG_FORMAT=json` (the chart sets it for deployed pods). The line shape is
 *   the log CONTRACT consumed by Promtail/Loki/Grafana — keep it stable:
 *     { timestamp, level, service, tenant_id?, ns?, message, trace_id?,
 *       user_id?, workspace_id?, conversation_id?, ...fields }
 *   `trace_id` is the active OTel trace id — the standard W3C/OTel field name,
 *   and what the Grafana Loki→Tempo derived field keys on, so logs pivot to
 *   traces. Identity comes only from the verified request context, never the
 *   wire, and never includes the human display name. On stderr — Kubernetes
 *   captures it alongside stdout, so Promtail ingests it either way.
 *
 * Both formats keep stdout untouched.
 *
 * Severity floor: `NB_LOG_LEVEL` (debug|info|warn|error, default `info`) drops
 * anything below it for the info/warn/error methods. `debug` (NB_DEBUG
 * namespaces) and `bundle` are separate always-available channels and bypass it.
 *
 * Secret-safety: structured `fields` pass through a key-denylist redactor
 * (secret / password / api_key / authorization / cookie / credential / a bare
 * `token` / the secret *_token compounds → "[redacted]") so a stray secret in a
 * field never reaches Loki. LLM usage fields (inputTokens / tokenCount / …) are
 * deliberately preserved. The redactor is a backstop, not a license — still
 * don't deliberately log secrets, and it does not inspect free text, so keep
 * secrets out of the message too.
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
 *   - `auth` — identity-provider verify rejections (routine reasons: no_token, token_expired)
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

// Severity floor. `NB_LOG_LEVEL` (deploy-time, read at call time for test
// control) drops anything below it for the info/warn/error methods. `debug`
// (NB_DEBUG) and `bundle` are separate channels and intentionally bypass this
// floor. NB_-namespaced to match the other knobs and avoid a stray `LOG_LEVEL`
// (aimed at some other tool) silently re-flooring our logs.
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
function levelEnabled(level: Level): boolean {
  const floor = LEVELS[(process.env.NB_LOG_LEVEL ?? "info").toLowerCase() as Level] ?? LEVELS.info;
  return LEVELS[level] >= floor;
}

// Key-denylist redactor: any field whose KEY looks secret-bearing is replaced
// with "[redacted]" before the line is written, so a stray secret in a `fields`
// object never reaches Loki. Walks nested objects/arrays (depth-bounded). The
// enrichment keys (tenant_id, trace_id, user_id, message, …) never match, so
// they pass through untouched. Does not inspect free text — keep secrets out of
// the message.
//
// Bare `token` is deliberately NOT a substring trigger: it is a substring of the
// most important LLM telemetry fields (inputTokens / outputTokens / tokenCount /
// max_tokens), and redacting those would silently corrupt usage/cost telemetry.
// So we match the secret token COMPOUNDS explicitly (access_token, …) plus an
// exact bare `token` key (a `{ token }` field is a credential; `inputTokens` is
// not). See the redaction regression test.
//
// This is a denylist by necessity — an allowlist of safe keys is infeasible when
// callers log arbitrary field names. Accepted residual risk: a novel
// secret-bearing key outside the regex passes through. The redactor is a
// backstop for the convention-only "no secrets in logs" rule, not the primary
// control — don't deliberately log secrets.
const SECRET_KEY =
  /(?:secret|password|passwd|authorization|cookie|credential|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?token|bearer)/i;
function isSecretKey(key: string): boolean {
  return key.toLowerCase() === "token" || SECRET_KEY.test(key);
}
function redact(value: unknown, depth = 0): unknown {
  // depth > 4 bounds the walk against pathological/cyclic structures (a DoS
  // guard, not a redaction policy); a secret nested deeper than 4 levels in a
  // log field is implausible, so the DoS bound wins the tradeoff.
  if (value === null || typeof value !== "object" || depth > 4) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSecretKey(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

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
  const traceId = currentTraceId();
  if (traceId) record.trace_id = traceId;
  if (fields) Object.assign(record, fields);
  process.stderr.write(`${JSON.stringify(redact(record))}\n`);
}

/**
 * Pretty-mode trailer: render extra fields compactly so dev still sees them.
 *
 * NOTE: pretty output is intentionally NOT run through `redact()`. The threat
 * model is "a secret reaches Loki" (retained + queryable), so redaction is
 * scoped to the JSON sink. The local dev terminal is neither retained nor
 * shipped, so `fields` print verbatim here. Don't "fix" this to redact pretty
 * output, and don't treat a pasted pretty-mode line as secret-safe.
 */
function prettyFields(fields?: LogFields): string {
  if (!fields || Object.keys(fields).length === 0) return "";
  return ` ${dim(JSON.stringify(fields))}`;
}

export const log = {
  info: (msg: string, fields?: LogFields) => {
    if (!levelEnabled("info")) return;
    if (isJson()) emitJson("info", msg, fields);
    else console.error(dim(msg) + prettyFields(fields));
  },
  warn: (msg: string, fields?: LogFields) => {
    if (!levelEnabled("warn")) return;
    if (isJson()) emitJson("warn", msg, fields);
    else console.error(yellow(msg) + prettyFields(fields));
  },
  error: (msg: string, fields?: LogFields) => {
    if (!levelEnabled("error")) return;
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
