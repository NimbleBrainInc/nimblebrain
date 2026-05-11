import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
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

/**
 * Resolve the absolute on-disk path of the workspace bundles directory —
 * the only location an LLM-supplied `.mcpb` path is permitted to reference.
 */
export function resolveWorkspaceBundlesDir(workDir: string, wsId: string): string {
  return join(workDir, "workspaces", wsId, "bundles");
}

/**
 * Canonicalize a path for prefix comparison. Realpaths the file when it
 * exists; when it doesn't, walks up the parent chain to find the deepest
 * existing ancestor, realpaths that, then re-attaches the missing tail.
 *
 * The naive `existsSync(p) ? realpathSync(p) : resolve(p)` form diverges on
 * platforms where ancestors are symlinks (macOS `/var` → `/private/var`):
 * the bundles dir realpaths to the canonical form, the missing file does
 * not, and a guard comparing the two falsely rejects.
 */
function canonicalize(filePath: string): string {
  const abs = resolve(filePath);
  if (existsSync(abs)) return realpathSync(abs);
  // Walk up to find the deepest existing ancestor.
  let parent = dirname(abs);
  let suffix = abs.slice(parent.length); // includes leading sep
  while (parent !== dirname(parent) && !existsSync(parent)) {
    suffix = parent.slice(dirname(parent).length) + suffix;
    parent = dirname(parent);
  }
  if (!existsSync(parent)) return abs;
  return realpathSync(parent) + suffix;
}

/**
 * Assert that `filePath` resolves inside `<workDir>/workspaces/<wsId>/bundles/`.
 * Throws otherwise.
 *
 * Critical defense for the `manage_app({ path })` tool path. Without this
 * guard, prompt-injected agent input can install any `.mcpb` the platform
 * user can read — the spawned subprocess inherits workspace credentials and
 * (for protected bundles) `NB_INTERNAL_TOKEN`. The same check runs at
 * startup re-hydration so a tampered `workspace.json` cannot escape either.
 *
 * Both sides are realpath'd when possible so symlinks pointing outside the
 * bundles dir are rejected. If the file does not exist (uninstall after
 * manual deletion), falls back to a lexical resolve — workspace.json is
 * written by trusted code, so a missing file is not a sign of tampering.
 */
export function assertPathInWorkspaceBundlesDir(
  filePath: string,
  workDir: string,
  wsId: string,
): void {
  const bundlesDir = resolveWorkspaceBundlesDir(workDir, wsId);
  // Realpath the bundles dir if it exists; otherwise fall back to a lexical
  // resolve. The dir is created on first upload, so a missing dir means no
  // bundle could possibly live inside it — a guard violation either way.
  const canonicalBundlesDir = existsSync(bundlesDir)
    ? realpathSync(bundlesDir)
    : resolve(bundlesDir);
  // For a missing file, realpath the parent dir and re-attach the basename.
  // Pure lexical resolve diverges from the bundles-dir canonicalization on
  // platforms where ancestors are themselves symlinks (notably macOS, where
  // /var → /private/var). Without this, an uninstall after manual deletion
  // of a perfectly-valid bundle inside the dir would falsely fail the guard.
  const canonicalFile = canonicalize(filePath);
  if (
    canonicalFile !== canonicalBundlesDir &&
    !canonicalFile.startsWith(canonicalBundlesDir + sep)
  ) {
    throw new Error(
      `Bundle path must live inside the workspace bundles directory ` +
        `(${canonicalBundlesDir}); got ${canonicalFile}`,
    );
  }
}
