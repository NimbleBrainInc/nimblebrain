import { join } from "node:path";

/** Prefixes reserved for system tools — bundles must not use these as source names. */
const RESERVED_TOOL_PREFIXES = new Set(["nb"]);

/** Throw if a server name would shadow system tool prefixes. */
export function validateServerName(serverName: string): void {
  if (RESERVED_TOOL_PREFIXES.has(serverName)) {
    throw new Error(`Source name '${serverName}' is reserved for system tools`);
  }
}

/** Derive a short server name from a bundle name. */
export function deriveServerName(name: string): string {
  const base = name.includes("/") ? name.split("/").pop()! : name;
  return base.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
}

/**
 * Derive a safe directory name for per-bundle data isolation.
 * Uses the full scoped name to avoid collisions (e.g., @foo/tasks vs @bar/tasks).
 * Matches the mpak cache convention: @scope/name → scope-name
 */
export function deriveBundleDataDir(name: string): string {
  return name.replace("@", "").replace("/", "-");
}

/**
 * Resolve the absolute data directory for a bundle within a workspace.
 * Combines the workspace path with the derived bundle directory name.
 * E.g., resolveBundleDataDir("workspaces/ws_eng", "@nimblebraininc/crm")
 *   → "workspaces/ws_eng/data/nimblebraininc-crm"
 */
export function resolveBundleDataDir(workspacePath: string, bundleName: string): string {
  return join(workspacePath, "data", deriveBundleDataDir(bundleName));
}
