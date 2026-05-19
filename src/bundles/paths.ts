import { readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../cli/log.ts";
import { WorkspaceContext } from "../workspace/context.ts";
import { resolveLocalBundle } from "./resolve.ts";
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
 * Derive a safe directory name for per-bundle data isolation.
 * Uses the full scoped name to avoid collisions (e.g., @foo/tasks vs @bar/tasks).
 * Matches the mpak cache convention: @scope/name → scope-name.
 *
 * Case is preserved — the unsafe-char strip uses `/gi` and there is no
 * `toLowerCase()`. This diverges intentionally from `slugifyServerName`
 * above: server names are URL-routable identifiers and must be lowercase;
 * dataDir slugs only need to round-trip on the filesystem, so preserving
 * the caller's casing keeps `path:` bundle dirs visually traceable back
 * to their source. Don't "consolidate" the two functions.
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
 * Canonical entry point for the bundle-data-dir contract:
 *
 *   <workDir>/workspaces/<wsId>/data/<slug-of-manifest.name>/
 *
 * The slug source is ALWAYS the bundle's manifest name — its stable
 * identity, not the way you happen to be locating its source code
 * (filesystem path, npm-scoped registry name, or URL). Every call site
 * that needs to know where a bundle's data lives must route through
 * here, so the launch path (which sets `MPAK_WORKSPACE` for the
 * subprocess) and the reader path (briefing collector, lifecycle
 * seeding, etc.) cannot drift onto different slugs for the same bundle.
 *
 * Resolution per ref shape:
 *   - `name:`  → `ref.name` is the canonical manifest name by contract.
 *                No disk read needed.
 *   - `path:`  → reads `<path>/manifest.json` and uses `manifest.name`.
 *                Falls back to a path-derived slug + warn only when the
 *                manifest can't be read (bundle source missing/broken).
 *   - `url:`   → uses persisted `ref.serverName` (the slugified
 *                canonical name set at install time from
 *                `ServerDetail.name`). Remote bundles have no on-disk
 *                manifest; this is the stable identity we hold.
 *
 * Synchronous on purpose: path-bundle manifests are local files and
 * boot already does a lot of sync fs work. Making this async would
 * push `Promise<>` through the inventory build for no real win.
 */
export function resolveBundleDataDirForRef(
  workDir: string,
  wsId: string,
  ref: BundleRef,
  configDir?: string,
): string {
  const slugSource = readBundleSlugSource(ref, configDir);
  return new WorkspaceContext({ wsId, workDir }).getDataPath(
    "data",
    deriveBundleDataDir(slugSource),
  );
}

function readBundleSlugSource(ref: BundleRef, configDir: string | undefined): string {
  if ("name" in ref) return ref.name;
  if ("path" in ref) {
    const bundleDir = resolveLocalBundle(ref.path, configDir);
    if (bundleDir) {
      try {
        const raw = JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf-8")) as {
          name?: unknown;
        };
        if (typeof raw.name === "string" && raw.name.length > 0) return raw.name;
      } catch (err) {
        log.warn(
          `[bundles] Failed to read manifest from ${ref.path}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    log.warn(
      `[bundles] Falling back to path-derived dataDir slug for ${ref.path} ` +
        `(manifest unreadable — bundle subprocess will likely fail to start)`,
    );
    return ref.path;
  }
  return ref.serverName ?? ref.url;
}
