import { join } from "node:path";
import type { BundleRef } from "./types.ts";

/** Prefixes reserved for system tools — bundles must not use these as source names. */
const RESERVED_TOOL_PREFIXES = new Set(["nb"]);

/** Throw if a server name would shadow system tool prefixes. */
export function validateServerName(serverName: string): void {
  if (RESERVED_TOOL_PREFIXES.has(serverName)) {
    throw new Error(`Source name '${serverName}' is reserved for system tools`);
  }
}

/**
 * Legacy short-slug derivation. Splits at `/` and takes the rightmost
 * segment, then alphanum-dashes. Used only as the fallback in
 * `serverNameFromRef` for refs that predate `serverName`-on-ref
 * persistence (workspace.json rows from before #195's slugify rule
 * landed). New installs always persist `slugifyServerName(entry.id)`
 * on the ref directly; don't introduce new call sites here.
 */
export function deriveServerName(name: string): string {
  const base = name.includes("/") ? name.split("/").pop()! : name;
  return base.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
}

/**
 * Slugify a canonical `ServerDetail.name` (reverse-DNS form, e.g.
 * `com.stripe/mcp`, `dev.mpak.nimblebraininc/echo`,
 * `ai.nimblebrain/echo`) into a single-segment, URL-safe, filesystem-
 * safe identifier used as the `serverName` everywhere downstream.
 *
 * Rule: namespace-preserving — collapses both the slash and the
 * dotted reverse-DNS segments into dashes so the FULL identifier
 * survives the transform. That's what makes the result collision-free
 * by construction:
 *
 *   `com.stripe/mcp`               → `com-stripe-mcp`
 *   `app.linear/mcp`               → `app-linear-mcp`
 *   `com.acme.crm/mcp`             → `com-acme-crm-mcp`
 *   `com.foobar.crm/mcp`           → `com-foobar-crm-mcp`
 *   `dev.mpak.nimblebraininc/echo` → `dev-mpak-nimblebraininc-echo`
 *   `ai.nimblebrain/echo`          → `ai-nimblebrain-echo`
 *   `@nimblebraininc/echo`         → `nimblebraininc-echo`
 *
 * Two distinct canonical names always produce two distinct slugs
 * because the FULL namespace is preserved — the `crm` collisions
 * the rightmost-segment derivation would have produced go away.
 */
export function slugifyServerName(canonicalName: string): string {
  return canonicalName
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[/.]/g, "-")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Resolve the lifecycle / registry key for a `BundleRef`. Single
 * authority for the install / boot / uninstall paths so the
 * registered source name matches what consumers later look up.
 *
 * All three ref variants honor `ref.serverName` first when present —
 * that's the slugified canonical reverse-DNS form set at install time
 * from `ServerDetail.name`. Falls back to `deriveServerName` only for
 * legacy refs that predate canonical-form persistence (pre-#195).
 */
export function serverNameFromRef(ref: BundleRef): string {
  if ("name" in ref) return ref.serverName ?? deriveServerName(ref.name);
  if ("path" in ref) return ref.serverName ?? deriveServerName(ref.path);
  return ref.serverName ?? deriveServerName(ref.url);
}

/**
 * Derive the bundle-name string from a `BundleRef` (for data-dir
 * resolution). Returns the npm-style scoped name for `name` refs, the
 * filesystem path for `path` refs, the URL for `url` refs.
 */
export function bundleNameFromRef(ref: BundleRef): string {
  if ("name" in ref) return ref.name;
  if ("path" in ref) return ref.path;
  return ref.url;
}

/**
 * Derive a safe directory name for per-bundle data isolation.
 * Uses the full scoped name to avoid collisions (e.g., @foo/tasks vs @bar/tasks).
 * Matches the mpak cache convention: @scope/name → scope-name
 */
export function deriveBundleDataDir(name: string): string {
  return name
    .replace(/^@/, "")
    .replace(/[/.]/g, "-")
    .replace(/[^a-z0-9-]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
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
