/**
 * Client-side debug logging, gated by `localStorage.nb_debug`.
 *
 * Mirrors the server-side `log.debug(ns, msg)` convention in `src/cli/log.ts`.
 * Keep namespaces in sync between the two surfaces so the same NB_DEBUG
 * value works in your terminal and your browser devtools.
 *
 * Usage from the browser console (no reload required for read; reload to
 * apply to hooks that cache the Set at module load):
 *
 *   localStorage.setItem("nb_debug", "*")        // everything
 *   localStorage.setItem("nb_debug", "sync")     // just data.changed fan-out
 *   localStorage.removeItem("nb_debug")          // disable
 *
 * Known namespaces:
 *   - `sync` — parent-side SSE `data.changed` arrival + iframe postMessage
 *              dispatch (see `web/src/hooks/useDataSync.ts`)
 *
 * Expensive log sites can call `isDebugEnabled(ns)` first to skip argument
 * construction when the namespace is off.
 */

const enabledNamespaces: Set<string> = (() => {
  try {
    const raw = localStorage.getItem("nb_debug") ?? "";
    return new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  } catch {
    // localStorage can throw in sandboxed contexts; fail closed (silent).
    return new Set<string>();
  }
})();
const allNamespacesEnabled = enabledNamespaces.has("*");

export function isDebugEnabled(ns: string): boolean {
  return allNamespacesEnabled || enabledNamespaces.has(ns);
}

export function debug(ns: string, ...args: unknown[]): void {
  if (!isDebugEnabled(ns)) return;
  // console.log so it shows at default devtools log level (not behind
  // "Verbose"). The `[ns]` prefix is a first argument so devtools formats
  // objects normally rather than stringifying everything.
  console.log(`[${ns}]`, ...args);
}
