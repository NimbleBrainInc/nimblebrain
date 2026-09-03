import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  isIdentitySource,
  isPersonalConnectorName,
  PERSONAL_CONNECTOR_PREFIX,
} from "../tools/identity-sources.ts";
import { isHttpUrl } from "../util/url.ts";
import { WorkspaceContext } from "../workspace/context.ts";
import type { BundleRef } from "./types.ts";

/**
 * Resolved default workDir for callers that don't have the RuntimeConfig in
 * hand. Reads `NB_WORK_DIR` from env, falls back to `~/.nimblebrain`, then
 * `resolve()`s the result so every derived path is absolute and
 * cwd-independent.
 *
 * The cli config-load path absolutizes its workDir at the same boundary;
 * this is the env-only fallback for the bundle lifecycle methods that
 * don't receive the config-derived value. Keep them aligned: if a future
 * change shifts the contract (e.g. relative paths get a different anchor),
 * change both sites.
 */
export function defaultWorkDir(): string {
  return resolve(process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain"));
}

/** Prefixes reserved for system tools — bundles must not use these as source names. */
const RESERVED_TOOL_PREFIXES = new Set(["nb"]);

/**
 * True if `serverName` collides with a reserved system-tool prefix. A source
 * named `nb` emits its tools as `nb__…`, which the surfacing layer classifies
 * as first-party system/kernel tools — so the name is refused. Exposed as a
 * predicate for callers that reject gracefully (returning a tool result);
 * `validateServerName` is the throwing form over the same set.
 *
 * The kernel identity sources (`conversations` / `files` / `automations`) are
 * reserved on the same footing. They are peers of `nb`, not children of it, and
 * they reach the model under the same bare `<source>__<tool>` shape a workspace
 * source now uses — so a workspace bundle named `conversations` would be
 * SHADOWED by the identity door, which `routeToolCall` consults first. Before
 * workspace names went bare the two were distinguishable (`ws_<id>-conversations__x`
 * vs `conversations__x`) and this could not arise; it is reachable now, so the
 * names are reserved rather than left to chance.
 *
 * The personal-connector marker is reserved here too, for the same reason: a
 * workspace source carrying it would shadow the identity door. It is in the
 * predicate for completeness — a function called `isReservedServerName` must not
 * answer `false` for a reserved name — but no current caller can reach it. The
 * two that exist pass either a `slugifyServerName` result (which maps every
 * non-`[a-z0-9-]` character to `-`, so it can never contain `_`) or go through
 * `validateServerName`, which tests the marker separately below to raise a more
 * specific error. The live enforcement path is an operator-set explicit
 * `ref.serverName`, which only `validateServerName` sees.
 */
export function isReservedServerName(serverName: string): boolean {
  return (
    RESERVED_TOOL_PREFIXES.has(serverName) ||
    isIdentitySource(serverName) ||
    isPersonalConnectorName(serverName)
  );
}

/** Throw if a server name would shadow system tool prefixes. */
export function validateServerName(serverName: string): void {
  if (isPersonalConnectorName(serverName)) {
    throw new Error(
      `Source name '${serverName}' is reserved: the '${PERSONAL_CONNECTOR_PREFIX}' prefix marks ` +
        `a personal connector on the identity door, and a workspace source using it would shadow one.`,
    );
  }
  if (isReservedServerName(serverName)) {
    // Reached at INSTALL and at every BOOT (`startup.ts` validates each bundle
    // start), so an already-installed source with one of these names stops
    // starting after upgrade. That is the honest outcome — `routeToolCall`
    // consults the identity door first, so such a source is unreachable anyway
    // — but the operator sees only this line, so it has to say what to do.
    throw new Error(
      `Source name '${serverName}' is reserved for platform tools (nb, conversations, files, automations). ` +
        `Its tools would be shadowed by the identity door and unreachable. Reinstall the bundle under a different ` +
        `source name, or set an explicit \`serverName\` on its ref.`,
    );
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
 * `com.stripe/mcp`, `ai.nimblebrain/echo`) into a single-segment,
 * URL-safe, filesystem-safe identifier used as the `serverName`
 * everywhere downstream.
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
 *   `ai.nimblebrain/echo`          → `ai-nimblebrain-echo`
 *   `@acme/echo`                   → `acme-echo`
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
 * Resolve the lifecycle / registry key for a `BundleRef`, or `null` when the
 * row cannot name one. Single authority for the install / boot / uninstall
 * paths so the registered source name matches what consumers later look up.
 *
 * Honors `ref.serverName` when present — that's the slugified canonical
 * reverse-DNS form set at install time from `ServerDetail.name`. Falls back to
 * `deriveServerName` only for refs that predate canonical-form persistence
 * (pre-#195), and only when the url is one this runtime could actually reach.
 *
 * **Nullable on purpose.** Every caller reads a row off disk, and disk holds
 * rows this build's type no longer describes — a pre-URL `name:`/`path:`
 * entry, or a url that is blank or unparseable. Returning `string` meant
 * `deriveServerName(undefined)` threw from whichever reader touched the row
 * first, which is a `TypeError` naming neither the workspace nor the row, in a
 * caller that has no reason to expect one. The null makes the compiler name
 * the set of readers instead, which is the same argument the URL-only
 * `BundleRef` collapse rests on: put the invariant in the type and let it find
 * the sites.
 */
export function serverNameFromRef(ref: BundleRef): string | null {
  if (ref.serverName) return ref.serverName;
  return isHttpUrl(ref.url) ? deriveServerName(ref.url) : null;
}

/**
 * Derive a safe directory name for per-bundle data isolation.
 * Uses the full scoped name to avoid collisions (e.g., @foo/tasks vs @bar/tasks).
 *
 * Case is preserved — the unsafe-char strip uses `/gi` and there is no
 * `toLowerCase()`. This diverges intentionally from `slugifyServerName`
 * above: server names are URL-routable identifiers and must be lowercase;
 * dataDir slugs only need to round-trip on the filesystem. Don't
 * "consolidate" the two functions.
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
 *   <workDir>/workspaces/<wsId>/data/<slug-of-serverName>/
 *
 * The slug source is the persisted `serverName` — the slugified canonical
 * name set at install time from `ServerDetail.name`. A remote server has no
 * on-disk manifest, so this is the stable identity the platform holds for it.
 * Every call site that needs to know where a bundle's host-side data lives
 * routes through here so the readers cannot drift onto different slugs.
 */
export function resolveBundleDataDirForRef(workDir: string, wsId: string, ref: BundleRef): string {
  return new WorkspaceContext({ wsId, workDir }).getDataPath(
    "data",
    deriveBundleDataDir(ref.serverName ?? ref.url),
  );
}
