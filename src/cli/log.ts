/**
 * Startup logger — colored stderr output for CLI boot messages.
 *
 * Info messages use dim text, warnings use yellow, errors use red.
 * All output goes to stderr to keep stdout clean for JSON-RPC / pipe output.
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
 * Keep this list in sync with the CLAUDE.md "Debugging" section so it's
 * discoverable without reading source.
 */

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

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

export const log = {
  info: (msg: string) => console.error(dim(msg)),
  warn: (msg: string) => console.error(yellow(msg)),
  error: (msg: string) => console.error(red(msg)),
  /**
   * Emit a gated debug line. Use for tracing that is useful during
   * development / incident response but too noisy for normal operation.
   *
   * Logs only when the process was started with the matching namespace in
   * `NB_DEBUG` (or `NB_DEBUG=*`). Cheap when disabled — the enabled check is
   * a `Set.has` on a cached Set.
   */
  debug: (ns: string, msg: string) => {
    if (!isDebugEnabled(ns)) return;
    console.error(`${cyan(`[${ns}]`)} ${msg}`);
  },
  /** Check whether a namespace is enabled, e.g. to skip expensive log args. */
  debugEnabled: isDebugEnabled,
};
