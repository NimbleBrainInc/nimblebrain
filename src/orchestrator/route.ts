/**
 * Per-call tool routing — the single primitive every chat / task / `/mcp` tool
 * dispatch flows through. Given a namespaced tool name and the calling identity,
 * `routeToolCall`:
 *
 *   1. Parses the namespace via `parseNamespacedToolName` (the only legal parse
 *      site). Throws `UnknownNamespacedToolName` on malformed input.
 *   2. A bare `<source>__<tool>` — the ONLY wire form, on both doors — routes by
 *      its source segment: a kernel identity source or the reserved personal
 *      marker goes through the IDENTITY door; anything else is the session's own
 *      workspace.
 *   3. A `ws_<id>-<tool>` is the RETIRED form. It is rejected, not routed — so a
 *      workspace other than the session's cannot be NAMED, and cross-workspace
 *      reach is unexpressible rather than denied after the fact. A session with
 *      no workspace (e.g. an external `/mcp` client with no `X-Workspace-Id`)
 *      refuses workspace sources with `WorkspaceToolUnavailable`. **There is no
 *      per-call membership scan** — the session's `workspaceId` was
 *      membership-validated when the session was established, so reaching only it
 *      is reaching only a member workspace.
 *   4. Constructs a fresh `WorkspaceContext` from the bound `wsId` — NEVER from
 *      `runtime.requireWorkspaceId()` or any ambient session-level state.
 *   5. Resolves the dispatch handle (`ToolSource`) in that workspace's registry.
 *      Throws `UnknownToolSource` if the source prefix isn't registered.
 *
 * Design rules:
 *   - **Strict invariants over defensive defaults.** No `wsId ?? "ws_default"`,
 *     no fallback to "current workspace." Every failure throws a structured
 *     error the caller can map.
 *   - **Derive don't cast.** Types flow from `WorkspaceContext` / `ToolSource`.
 *   - **No ambient state.** The wsId comes from the parsed namespace + the
 *     passed `workspaceId` alone.
 *
 * The runtime dependency is a narrow structural type (`OrchestratorRuntime`) so
 * unit tests can stub without a full `Runtime`.
 */

import type { ToolSchema } from "../engine/types.ts";
import type { IdentityContext } from "../identity/context.ts";
import type { PermissionOwner, PermissionStore } from "../permissions/permission-store.ts";
import {
  isIdentitySource,
  isPersonalConnectorName,
  personalConnectorServerName,
} from "../tools/identity-sources.ts";
import { parseNamespacedToolName, UnknownNamespacedToolName } from "../tools/namespace.ts";
import type { ToolSource } from "../tools/types.ts";
import { splitInnerToolName } from "../util/tool-name.ts";
import type { WorkspaceContext } from "../workspace/context.ts";

// ── Errors ─────────────────────────────────────────────────────────

/**
 * Base class for the wall's denial errors. `WorkspaceToolUnavailable` (no
 * workspace on the session) is the only subclass now that naming another
 * workspace is impossible rather than denied. Not thrown directly; the subclass
 * is. The payload
 * carries `identityId` and `wsId` so the HTTP / `/mcp` layer can emit a
 * structured `workspace_access_denied` response without re-parsing the name.
 */
export class WorkspaceAccessDenied extends Error {
  readonly identityId: string;
  readonly wsId: string;

  constructor(identityId: string, wsId: string) {
    super(`[orchestrator] identity "${identityId}" does not have access to workspace "${wsId}"`);
    this.name = "WorkspaceAccessDenied";
    this.identityId = identityId;
    this.wsId = wsId;
  }
}

/**
 * Thrown when an identity-scoped session with NO workspace (e.g. a `/mcp`
 * session, which is identity-bound and carries no workspace) attempts a
 * workspace-scoped tool call. Workspace tools are unreachable on such a session
 * — only the caller's identity tools (conversations / files / automations) are.
 * Subclasses `WorkspaceAccessDenied` so the existing error mapping applies
 * unchanged.
 */
export class WorkspaceToolUnavailable extends WorkspaceAccessDenied {
  /**
   * `sourceName` is deliberately NOT stored. It names the subject in `message`
   * and nothing more: neither `error-mapping.ts` nor `mcp-server.ts` emits
   * anything beyond `{ identityId, wsId }`, so a field would be write-only. What
   * matters is that it does not go into `wsId` — that would publish
   * `data.wsId: "people-mcp"` to external `/mcp` clients reading the
   * discriminator. If the source ever needs to reach a client, add it to both
   * mappers at the same time.
   */
  constructor(identityId: string, sourceName: string) {
    // `WorkspaceAccessDenied` carries a wsId; a session with no workspace has
    // none to report, so it is empty rather than a value that reads like one.
    super(identityId, "");
    this.name = "WorkspaceToolUnavailable";
    this.message = `[orchestrator] this session is identity-scoped (no workspace); source "${sourceName}" is not available`;
  }
}

/**
 * Thrown when the inner tool name's source prefix isn't registered in the
 * session's workspace `ToolRegistry` — the workspace is the bound one, but no
 * bundle in it serves the requested source. A structured error (not a bare
 * `Error`) so the HTTP / `/mcp` layer can distinguish "tool source not
 * installed" from "tool exists but execution failed."
 */
export class UnknownToolSource extends Error {
  readonly wsId: string;
  readonly toolName: string;
  readonly sourceName: string;

  constructor(wsId: string, toolName: string, sourceName: string) {
    super(
      `[orchestrator] no tool source "${sourceName}" registered in workspace "${wsId}" (tool "${toolName}")`,
    );
    this.name = "UnknownToolSource";
    this.wsId = wsId;
    this.toolName = toolName;
    this.sourceName = sourceName;
  }
}

/**
 * Thrown when a bare (identity-scoped) tool name's source isn't in the
 * kernel identity-source set — the identity-side parallel to
 * `UnknownToolSource`. A bare `<source>__<tool>` whose `<source>` is not a
 * recognized identity source (conversations / files / automations) is a
 * mis-namespaced call, surfaced rather than silently treated as workspace.
 */
export class UnknownIdentitySource extends Error {
  readonly toolName: string;
  readonly sourceName: string;

  constructor(toolName: string, sourceName: string) {
    super(`[orchestrator] no identity source "${sourceName}" (tool "${toolName}")`);
    this.name = "UnknownIdentitySource";
    this.toolName = toolName;
    this.sourceName = sourceName;
  }
}

/**
 * Thrown when a personal connector (an identity-owned MCP connection, resolved
 * by `userId`) is reached from a workspace session with no active grant for it in
 * that workspace. A personal connector runs inside a workspace only if the owner
 * granted it there (fail closed) — uniformly, in every workspace including the
 * caller's own personal one. Distinct from `UnknownIdentitySource`
 * (the connector exists, it's just not granted here) so the caller can surface
 * an actionable "grant it in settings" message rather than "no such tool".
 */
export class ConnectorGrantDenied extends Error {
  readonly identityId: string;
  readonly connector: string;
  /** The shared workspace the call ran in; `undefined` for an identity-only session (no room to grant to). */
  readonly workspaceId: string | undefined;

  constructor(identityId: string, connector: string, workspaceId: string | undefined) {
    super(
      `[orchestrator] personal connector "${connector}" is not granted to workspace "${workspaceId ?? "(none)"}"`,
    );
    this.name = "ConnectorGrantDenied";
    this.identityId = identityId;
    this.connector = connector;
    this.workspaceId = workspaceId;
  }
}

// Re-export the parse-time error from the primitive so callers
// importing the orchestrator's surface get the full error taxonomy in
// one place. The orchestrator catches and rethrows this without
// wrapping, per the primitive's contract.
export { UnknownNamespacedToolName };

// ── Runtime dependency (narrow structural type) ───────────────────

/**
 * Methods the orchestrator needs from the runtime. Expressed as a
 * narrow structural type so unit tests can stub without booting a real
 * `Runtime`. The production `Runtime` (`src/runtime/runtime.ts`)
 * satisfies this shape via three pre-existing accessors.
 */
export interface OrchestratorRuntime {
  /**
   * Fresh `WorkspaceContext` for `wsId`. The runtime constructs this
   * per call (no cache) so context-isolation is automatic — see the
   * doc comment on `Runtime.getWorkspaceContext`.
   */
  getWorkspaceContext(wsId: string): WorkspaceContext;

  /**
   * The workspace's `ToolRegistry`-ish surface. Narrowed to just the
   * `getSource(name)` accessor the orchestrator needs.
   */
  getRegistryForWorkspace(wsId: string): {
    getSource(name: string): ToolSource | undefined;
  };

  /**
   * Best-effort recovery for an installed-but-unregistered workspace
   * source. When the per-call source lookup misses, the orchestrator
   * invokes this ONCE before failing with `UnknownToolSource`, giving the
   * runtime a chance to re-spawn a source that a failed credential
   * respawn or a remote-OAuth teardown removed from the registry without
   * re-adding (nothing else on the hot path re-registers it). Returns
   * `true` if the source is registered after the attempt. The runtime
   * cooldown-guards repeats, so calling on every miss is cheap.
   *
   * Optional: test stubs and non-production runtimes may omit it, in
   * which case the orchestrator behaves exactly as before — a miss is a
   * hard `UnknownToolSource`.
   */
  recoverWorkspaceSource?(wsId: string, sourceName: string): Promise<boolean>;

  /**
   * Resolve a kernel identity-scoped source by name (`conversations`, and
   * later `files` / `automations`). Returns `undefined` for an unknown or
   * non-identity source — the orchestrator turns that into
   * `UnknownIdentitySource`. No workspace: these dispatch with identity
   * authority and gate their own reads via `canAccess`.
   */
  getIdentitySource(name: string): ToolSource | undefined;

  /**
   * Resolve a user's personal connector to a started `ToolSource`, lazy-starting
   * it on first use from the caller's identity-plane install record. Returns
   * `undefined` when the user has no such connector installed. The DYNAMIC,
   * per-identity connector door — keyed by `(userId, name)`, distinct from the
   * static kernel `getIdentitySource(name)`. Optional: test stubs may omit it,
   * in which case a connector name resolves to `UnknownIdentitySource`.
   */
  getIdentityConnectorSource?(userId: string, name: string): Promise<ToolSource | undefined>;

  /** Fresh `IdentityContext` for the authenticated identity. No workspace. */
  getIdentityContext(identityId: string): IdentityContext;

  /**
   * The workspace connector-permission store. Callers that dispatch a
   * workspace-scoped tool consult it (via `assertToolAllowed`) to enforce an
   * operator's per-tool `disallow` before `source.execute`. Optional: test
   * stubs and non-production runtimes may omit it, in which case the
   * permission gate is skipped (allow) — the production `Runtime` always
   * provides it via `getPermissionStore`.
   */
  getPermissionStore?(): PermissionStore;

  /**
   * The walled tool surface for a session bounded to `wsId`: that workspace's
   * tools and the caller's identity tools, both bare `<source>__<tool>`, plus —
   * when `identityId` is given — the caller's personal connectors granted to
   * `wsId`, carrying the reserved `my_` marker so they stay distinguishable from
   * a workspace source of the same name. The engine's reachable universe — there
   * is no cross-workspace union.
   */
  listToolsForWorkspace(wsId: string, identityId?: string): Promise<ToolSchema[]>;
}

// ── Routing ───────────────────────────────────────────────────────

/**
 * Output of a successful route. The caller (the runtime's tool-call
 * dispatch path) uses `context` to scope any data access the tool
 * needs, `toolName` as the bare name to pass into `source.execute`,
 * and `source` as the dispatch target.
 */
export type RoutedToolCall =
  | {
      /**
       * Workspace request: a bare `<source>__<tool>` whose source segment is
       * neither a kernel identity source nor `my_`-marked. Authorized by the
       * membership check the session was established with, not per call.
       */
      kind: "workspace";
      /** Fresh `WorkspaceContext` bound to the session's own wsId. */
      context: WorkspaceContext;
      /** The wire name — what the source executes. */
      toolName: string;
      /** The workspace's `ToolSource` for the inner tool's source prefix. */
      source: ToolSource;
    }
  | {
      /** Identity request: bare `<source>__<tool>`, authorized per-entity by `canAccess`. */
      kind: "identity";
      /** Fresh `IdentityContext` for the caller — no workspace. */
      context: IdentityContext;
      /** The bare `<source>__<tool>` the source executes. */
      toolName: string;
      /** The source the inner tool dispatches to: a kernel identity source, or a grant-gated personal connector resolved from the caller's identity. */
      source: ToolSource;
      /**
       * For a **personal connector**: the owner (`{scope:"user"}`) whose per-tool
       * `disallow` policy governs it. Dispatch doors read this to apply the
       * owner's policy, so a granted connector is never more capable than the
       * owner permits. **Undefined for kernel identity sources** (they have no
       * per-tool policy). Stamped here at routing so the doors never re-infer "is
       * this a personal connector."
       */
      policyOwner?: PermissionOwner;
    };

/**
 * Resolve a namespaced tool call to a workspace context + dispatch
 * handle. See module doc-comment for the routing flow and failure
 * modes.
 *
 * Pure of ambient state. Routing never reads
 * `runtime.requireWorkspaceId()` / `getCurrentWorkspaceId()` — the
 * wsId comes from the parsed namespace alone.
 */
export async function routeToolCall(opts: {
  identityId: string;
  namespacedName: string;
  /**
   * The session's single workspace (the wall). When set, a workspace-scoped
   * call dispatches here. No other workspace can be named, so there is no
   * cross-workspace case to deny.
   * Membership + existence were already validated when the session was
   * established, so the per-call store lookup and membership scan are skipped.
   * (Omitted only on the legacy `/mcp` path until its per-request workspace is
   * threaded.)
   */
  workspaceId?: string;
  runtime: OrchestratorRuntime;
}): Promise<RoutedToolCall> {
  const { identityId, namespacedName, workspaceId, runtime } = opts;

  if (typeof identityId !== "string" || identityId.length === 0) {
    // Programmer error, not a routing failure. Surface immediately
    // — the orchestrator's contract requires an identified caller.
    throw new Error("[orchestrator] routeToolCall: identityId is required (non-empty string)");
  }

  // Step 1 — parse. Throws UnknownNamespacedToolName on any malformed
  // input. We let it propagate; the HTTP / engine layer maps it.
  const { scope, toolName } = parseNamespacedToolName(namespacedName);

  // A `ws_<id>-` name is the RETIRED wire form. It is not routed: the platform
  // emits bare names on both doors, and accepting a second form means carrying a
  // second set of semantics for the same string forever. A caller presenting one
  // is working from a stale `tools/list` and needs to re-list, which is what the
  // error says. Rejecting is also what makes cross-workspace reach
  // *unexpressible* rather than merely denied — there is no longer any name that
  // can address a workspace other than the session's own.
  if (scope.kind === "workspace") {
    throw new UnknownNamespacedToolName(
      namespacedName,
      "legacy_namespaced_form",
      `[orchestrator] "${namespacedName}" uses the retired ws_<id>- tool-name form; re-list tools and call "${toolName}"`,
    );
  }

  // Bare `<source>__<tool>` — the current wire form for BOTH doors. The source
  // segment decides which, in priority order:
  //
  //   1. a kernel identity source (`conversations` / `files` / `automations`),
  //      which is excluded from every workspace registry by construction, so it
  //      can never be shadowed by a workspace source of the same name;
  //   2. the reserved personal-connector prefix, which a workspace source may
  //      not claim (`isReservedServerName` / `validateServerName` at install);
  //   3. otherwise the session's own workspace.
  //
  // Note what is NOT here: a cross-workspace check. It is gone because the
  // caller can no longer NAME another workspace, so there is nothing to compare
  // and nothing to deny. The old `ws_<id>-` tripwire only ever fired on a
  // fabricated name — the tool list and the session's `workspaceId` derive from
  // the same value, so it could never detect a mis-bound session. Removing the
  // field makes fabrication unexpressible, which is strictly stronger than
  // catching it after the fact.
  const { sourcePrefix: sourceName } = splitInnerToolName(toolName);
  if (isIdentitySource(sourceName) || isPersonalConnectorName(sourceName)) {
    return routeIdentityCall(identityId, toolName, workspaceId, runtime);
  }

  if (workspaceId === undefined) {
    // Identity-only session (e.g. an external `/mcp` request with no
    // `X-Workspace-Id`, or a non-member one). Workspace sources are unreachable.
    // A bare workspace-source name has no workspace id to report, so this
    // carries the SOURCE name — see `WorkspaceToolUnavailable`, which keeps it
    // in a field of its own rather than overloading `wsId`.
    throw new WorkspaceToolUnavailable(identityId, sourceName);
  }
  const wsId = workspaceId;

  // Step 4 — fresh context. Derived ONLY from the parsed wsId; we
  // never reach for any ambient "current workspace" pointer.
  // `Runtime.getWorkspaceContext` constructs a new instance each call,
  // so two consecutive routes for different wsIds return distinct
  // contexts by construction (cache-isolation test guards against a
  // future regression that aliases them).
  const context = runtime.getWorkspaceContext(wsId);

  // Step 5 — resolve the inner tool's `<source>__` prefix to a dispatch handle
  // in the bound workspace's registry (self-healing a transiently absent source
  // once before failing).
  const source = await resolveWorkspaceSource(wsId, toolName, runtime);

  // NO ambiguity check here, deliberately.
  //
  // A bare name that resolves in the bound workspace IS the workspace source —
  // that is the contract the marker establishes, and `listToolsForWorkspace`
  // already emits the two apart: the workspace source as `gmail__send`, the
  // caller's connector as `my_gmail__send`. A freshly-listed name is never
  // ambiguous, so re-checking here refused the very name the tool list had just
  // handed out, permanently, for anyone holding a same-named personal connector
  // — the default whenever a service is connected both ways, since both install
  // paths slugify the same catalog id.
  //
  // The stale-transcript case that motivated the check is real but
  // indistinguishable from a correct fresh call, so guarding it costs an outage
  // of the common path to catch a rare misroute. A stale pre-marker name is
  // therefore a plain `UnknownToolSource`, which is the honest error: that class
  // also means "installed but transiently absent", and nothing here can tell the
  // two apart without steering a model onto the caller's own credentials during a
  // workspace-source outage.
  return { kind: "workspace", context, toolName, source };
}

/**
 * Route a bare `<source>__<tool>` against the caller's identity. Two source
 * classes, in priority order:
 *
 *   1. A **kernel identity source** (`conversations` / `files` / `automations`)
 *      — the caller's own data, always reachable, gated per-entity by
 *      `canAccess`.
 *   2. A **personal connector** — an MCP connection the caller installed on their
 *      own identity, reached here as a bare identity tool and resolved by
 *      `userId` (never through a workspace registry). Reaching it inside a
 *      workspace requires an active `PersonalConnectorGrant` to THAT workspace
 *      (fail closed → `ConnectorGrantDenied`) — uniformly, with no special case
 *      for the caller's own personal workspace (a personal workspace is just a
 *      workspace). The connector runs as the caller with its own identity-scoped
 *      credentials (`users/<id>/…`), so the session's workspace never enters the
 *      dispatch — no crossing.
 *
 * `workspaceId` is the session's one workspace (the room the call runs in), used
 * ONLY to decide WHICH workspace's grant the connector requires — never
 * free-vs-gated, and never the connector's credential source.
 */
async function routeIdentityCall(
  identityId: string,
  toolName: string,
  workspaceId: string | undefined,
  runtime: OrchestratorRuntime,
): Promise<RoutedToolCall> {
  const { sourcePrefix: wireSource, bareToolName, hasSeparator } = splitInnerToolName(toolName);

  const kernelSource = runtime.getIdentitySource(wireSource);
  if (kernelSource) {
    return {
      kind: "identity",
      context: runtime.getIdentityContext(identityId),
      toolName,
      source: kernelSource,
    };
  }

  // A personal connector is an identity-owned source, resolved by userId on the
  // identity door (lazy-started on first use) — never through a workspace
  // registry.
  //
  // The WIRE name carries the reserved `my_` marker; the connector's own
  // `serverName` does not. Strip it HERE, at the door, and hand the rest of the
  // runtime the canonical `<serverName>__<tool>`. This is load-bearing, not
  // cosmetic: the dispatch doors re-split `routed.toolName` and feed the source
  // segment to `assertToolAllowed`, whose records are persisted under
  // `serverName`. A wire-form name would miss every stored policy, and the
  // store's documented default is "not present ⇒ allow" — so it would fail
  // OPEN, silently re-enabling a tool the owner disabled. `data.changed`
  // matching against the iframe's `data-app` has the same requirement.
  // A marker with nothing after it (`my_granola`, no `__`) is malformed. Left
  // alone it would strip to `granola`, find the connector, and dispatch a
  // synthesized `granola__` with an empty tool segment. Reject by name instead.
  if (isPersonalConnectorName(wireSource) && !hasSeparator) {
    throw new UnknownIdentitySource(toolName, wireSource);
  }
  const sourceName = isPersonalConnectorName(wireSource)
    ? personalConnectorServerName(wireSource)
    : wireSource;
  const canonicalToolName = sourceName === wireSource ? toolName : `${sourceName}__${bareToolName}`;

  const connector = await runtime.getIdentityConnectorSource?.(identityId, sourceName);
  if (connector) {
    // A personal connector is the user's own; reaching it inside a workspace
    // requires an active grant to THAT workspace — uniformly, with no special
    // case for the user's personal workspace (a personal workspace is just a
    // workspace and gets no "free at home" treatment). Fail closed. The
    // connector runs as the caller with its own identity-scoped credentials.
    const granted =
      workspaceId !== undefined &&
      (await runtime
        .getPermissionStore?.()
        ?.isConnectorGranted(identityId, sourceName, workspaceId)) === true;
    if (!granted) {
      throw new ConnectorGrantDenied(identityId, sourceName, workspaceId);
    }
    return {
      kind: "identity",
      context: runtime.getIdentityContext(identityId),
      toolName: canonicalToolName,
      source: connector,
      // The dispatch doors apply the owner's per-tool `disallow` from here — the
      // owner's identity-scoped `{scope:"user"}` policy.
      policyOwner: { scope: "user", userId: identityId },
    };
  }

  // Report the WIRE form the caller actually used (marker included) — the
  // de-marked `sourceName` is an internal detail and naming it in the error
  // would send the caller looking for a tool they never asked for.
  throw new UnknownIdentitySource(toolName, wireSource);
}

/** Resolve a workspace tool name's `<source>__` prefix to its registered `ToolSource`, self-healing a transiently absent source once. */
async function resolveWorkspaceSource(
  wsId: string,
  toolName: string,
  runtime: OrchestratorRuntime,
): Promise<ToolSource> {
  // The inner toolName carries the `<source>__<tool>` form the registry is keyed
  // on, decomposed through the one grammar every door shares.
  //
  // Two shapes name no source: no `__` at all (`sourcePrefix` is then the whole
  // name, which is the right thing to report as the source we failed to find),
  // and a leading `__` (an empty prefix, which no registry key can be). Both are
  // the same answer to the caller.
  const { sourcePrefix: sourceName, hasSeparator } = splitInnerToolName(toolName);
  if (!hasSeparator || sourceName.length === 0) {
    throw new UnknownToolSource(wsId, toolName, sourceName);
  }
  const registry = runtime.getRegistryForWorkspace(wsId);
  let source = registry.getSource(sourceName);
  // Self-heal. An installed bundle's source can be transiently absent from the
  // registry: a failed credential respawn or a remote-OAuth teardown removes it
  // WITHOUT re-adding, and nothing on the chat / automation hot path
  // re-registers it — so the workspace stays toolless until a platform restart
  // (the failure that bricked a workspace's Dropbox tools mid-run for both chat
  // and its scheduled automations). Give the runtime ONE best-effort,
  // cooldown-guarded chance to re-spawn the source from its persisted ref, then
  // re-resolve against the same registry. A still-missing source falls through
  // to the same `UnknownToolSource` — recovery only repairs a recoverable
  // absence, it never hides a genuine failure.
  if (!source && (await attemptSourceRecovery(wsId, sourceName, runtime))) {
    source = registry.getSource(sourceName);
  }
  if (!source) {
    throw new UnknownToolSource(wsId, toolName, sourceName);
  }
  return source;
}

/** Never-throwing wrapper over the runtime's optional source-recovery hook; false when absent or on error. */
async function attemptSourceRecovery(
  wsId: string,
  sourceName: string,
  runtime: OrchestratorRuntime,
): Promise<boolean> {
  if (!runtime.recoverWorkspaceSource) {
    return false;
  }
  try {
    return await runtime.recoverWorkspaceSource(wsId, sourceName);
  } catch {
    // Recovery is strictly best-effort; a throw here is no worse than
    // no recovery at all. Fall through to UnknownToolSource.
    return false;
  }
}
