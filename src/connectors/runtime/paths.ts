import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  isIdentitySource,
  isPersonalConnectorName,
  PERSONAL_CONNECTOR_PREFIX,
} from "../../tools/identity-sources.ts";
import { isHttpUrl } from "../../util/url.ts";
import { WorkspaceContext } from "../../workspace/context.ts";
import type { ConnectorRef } from "./types.ts";

/**
 * The default workDir: `NB_WORK_DIR` when set, `~/.nimblebrain` otherwise,
 * `resolve()`d so every derived path is absolute and cwd-independent.
 *
 * Two kinds of caller share it, which is why it has exactly one home. The
 * connector lifecycle methods read it directly, having no RuntimeConfig in
 * hand. Every CLI entry point passes it to `loadConfig` as `defaultWorkDir`,
 * where it decides both which config file is found (`resolveConfigPath`) and
 * which work directory that config resolves to (`absoluteWorkDir`) — so a
 * command that omits it reads a different config and writes to a different
 * directory than the server does, silently, since both are legitimate paths
 * in isolation.
 */
export function defaultWorkDir(): string {
  return resolve(process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain"));
}

/**
 * Source names the runtime registers in every workspace registry: the `nb`
 * system source and each platform app that is not an identity source. Connector
 * names that belong to platform apps are reserved. A workspace connector of the
 * same name would collide with the shared source in that workspace's registry,
 * and its tools would be listed under the platform app.
 *
 * The runtime checks at boot that every source it creates is reserved
 * (`assertRuntimeSourceNamesReserved`), so a new platform app missing here
 * fails the first start rather than leaving its name open.
 */
const RUNTIME_SOURCE_NAMES: ReadonlySet<string> = new Set([
  "nb",
  "compose",
  "hooks",
  "notifications",
  "skills",
  "usage",
]);

/**
 * True if `serverName` is a name a connector may not take. A source named `nb`
 * emits its tools as `nb__…`, which the surfacing layer classifies as
 * first-party system/kernel tools; a source named after a platform app
 * (`usage`, `skills`, …) collides with that app in the workspace registry. So
 * every name in `RUNTIME_SOURCE_NAMES` is refused. Exposed as a predicate for
 * callers that reject gracefully (returning a tool result);
 * `validateServerName` is the throwing form over the same set.
 *
 * The kernel identity sources (`conversations` / `files` / `tasks`) are
 * reserved on the same footing. They are peers of `nb`, not children of it, and
 * they reach the model under the same bare `<source>__<tool>` shape a workspace
 * source now uses — so a workspace connector named `conversations` would be
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
    RUNTIME_SOURCE_NAMES.has(serverName) ||
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
    // Reached at INSTALL and at every BOOT (`startup.ts` validates each connector
    // start), so an already-installed source with one of these names stops
    // starting after upgrade. That is the honest outcome — `routeToolCall`
    // consults the identity door first, and a platform app already holds its
    // name in every workspace registry, so such a source is unreachable anyway
    // — but the operator sees only this line, so it has to say what to do.
    throw new Error(
      `Source name '${serverName}' is reserved: it belongs to a platform app or system tools. ` +
        `A connector under this name would collide with that app and be unreachable. Reinstall the connector ` +
        `under a different source name, or set an explicit \`serverName\` on its ref.`,
    );
  }
}

/**
 * Throw unless every source the runtime registers itself carries a reserved
 * name. Called at boot over the system source and the platform apps, so the
 * reserved set cannot fall behind the sources it protects.
 */
export function assertRuntimeSourceNamesReserved(sourceNames: readonly string[]): void {
  const open = sourceNames.filter((name) => !isReservedServerName(name));
  if (open.length > 0) {
    throw new Error(
      `Runtime source name(s) not reserved for connectors: ${open.join(", ")}. ` +
        "Add each to RUNTIME_SOURCE_NAMES in src/connectors/runtime/paths.ts.",
    );
  }
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
 * Resolve the lifecycle / registry key for a `ConnectorRef`, or `null` when the
 * row cannot name one. Single authority for the install / boot / uninstall
 * paths so the registered source name matches what consumers later look up.
 *
 * The key is `ref.serverName`: the slugified canonical reverse-DNS form set at
 * install time from `ServerDetail.name`.
 *
 * **Nullable on purpose.** Every caller reads a row off disk, and a hand-edited
 * or malformed row may carry no `serverName`. The null makes the compiler name
 * the set of readers, so each one skips the row instead of throwing a
 * `TypeError` that names neither the workspace nor the row.
 */
export function serverNameFromRef(ref: ConnectorRef): string | null {
  return typeof ref.serverName === "string" && ref.serverName.length > 0 ? ref.serverName : null;
}

/**
 * Whether a row read off disk is a connector this build can start: it names a
 * `serverName` and carries an http(s) `url`. The type promises both, but a
 * hand-edited or partial record does not, so every reader of persisted rows asks
 * this before using one, and skips or refuses a row that fails it.
 */
export function isUsableConnectorRef(ref: ConnectorRef): boolean {
  return serverNameFromRef(ref) !== null && typeof ref.url === "string" && isHttpUrl(ref.url);
}

/**
 * Whether a persisted `workspace.json` row IS the named connector. A row with
 * no `serverName` matches nothing, so it is left alone — which also makes it a
 * referrer for the reference check in `deletableSecretKeys`, the safe direction
 * for a row nothing can identify.
 */
export function matchesServerName(row: ConnectorRef, serverName: string): boolean {
  return serverNameFromRef(row) === serverName;
}

/**
 * Derive a safe directory name for per-connector data isolation.
 * Uses the full scoped name to avoid collisions (e.g., @foo/tasks vs @bar/tasks).
 *
 * Case is preserved — the unsafe-char strip uses `/gi` and there is no
 * `toLowerCase()`. This diverges intentionally from `slugifyServerName`
 * above: server names are URL-routable identifiers and must be lowercase;
 * dataDir slugs only need to round-trip on the filesystem. Don't
 * "consolidate" the two functions.
 */
export function deriveConnectorDataDir(name: string): string {
  return name
    .replace(/^@/, "")
    .replace(/[/.]/g, "-")
    .replace(/[^a-z0-9-]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Canonical entry point for the connector-data-dir contract:
 *
 *   <workDir>/workspaces/<wsId>/data/<slug-of-serverName>/
 *
 * The slug source is the persisted `serverName` — the slugified canonical
 * name set at install time from `ServerDetail.name`. A remote server has no
 * on-disk manifest, so this is the stable identity the platform holds for it.
 * Every call site that needs to know where a connector's host-side data lives
 * routes through here so the readers cannot drift onto different slugs.
 */
export function resolveConnectorDataDirForRef(
  workDir: string,
  wsId: string,
  ref: ConnectorRef,
): string {
  return new WorkspaceContext({ wsId, workDir }).getDataPath(
    "data",
    deriveConnectorDataDir(ref.serverName),
  );
}
