/**
 * Per-call tool routing — the single primitive every chat / task / `/mcp` tool
 * dispatch flows through. Given a namespaced tool name and the calling identity,
 * `routeToolCall`:
 *
 *   1. Parses the namespace via `parseNamespacedToolName` (the only legal parse
 *      site). Throws `UnknownNamespacedToolName` on malformed input.
 *   2. A bare `<source>__<tool>` routes through the IDENTITY door (no workspace).
 *   3. A `ws_<id>-<tool>` routes through the WORKSPACE door, walled to the
 *      session's one workspace (`workspaceId`): a call to ANY OTHER workspace is
 *      `CrossWorkspaceReachDenied`, and a session with no workspace (e.g. an
 *      external `/mcp` client with no `X-Workspace-Id`) is
 *      `WorkspaceToolUnavailable`. **There is no per-call membership scan** — the
 *      session's `workspaceId` was membership-validated when the session was
 *      established, so reaching only it is reaching only a member workspace.
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
import { parseNamespacedToolName, UnknownNamespacedToolName } from "../tools/namespace.ts";
import type { ToolSource } from "../tools/types.ts";
import type { WorkspaceContext } from "../workspace/context.ts";

// ── Errors ─────────────────────────────────────────────────────────

/**
 * Base class for the wall's denial errors — `CrossWorkspaceReachDenied` (reach
 * to another workspace) and `WorkspaceToolUnavailable` (no workspace on the
 * session). Not thrown directly today; the two subclasses are. The payload
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
 * Thrown when a walled session tries to reach a workspace other than its own.
 * A session is bounded to exactly one workspace; a `ws_<other>-<tool>` call is
 * denied even though the identity may be a member of that other workspace.
 * Subclasses `WorkspaceAccessDenied` so the existing error mapping (HTTP 403 /
 * `-32602`) applies unchanged; `name` distinguishes "walled" from "not a member"
 * — both map to the same `workspace_access_denied` response (we don't leak
 * whether the other workspace exists). The bounded workspace is named in the
 * message.
 */
export class CrossWorkspaceReachDenied extends WorkspaceAccessDenied {
  constructor(identityId: string, wsId: string, focusedWorkspaceId: string) {
    super(identityId, wsId);
    this.name = "CrossWorkspaceReachDenied";
    this.message = `[orchestrator] session is bounded to workspace "${focusedWorkspaceId}"; reach to "${wsId}" is denied`;
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
  constructor(identityId: string, wsId: string) {
    super(identityId, wsId);
    this.name = "WorkspaceToolUnavailable";
    this.message = `[orchestrator] this session is identity-scoped (no workspace); workspace tool "${wsId}" is not available`;
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
   * tools (namespaced `ws_<id>-<tool>`) plus the caller's identity tools
   * (bare), plus — when `identityId` is given — the caller's personal connectors
   * granted to `wsId` (bare; any workspace, including the caller's own personal
   * one). The engine's reachable universe — there is no cross-workspace union.
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
      /** Workspace request: `ws_<id>-<tool>`, authorized by membership. */
      kind: "workspace";
      /** Fresh `WorkspaceContext` bound to the parsed namespace's wsId. */
      context: WorkspaceContext;
      /** Tool name after stripping the `ws_<id>-` prefix — what the source executes. */
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
   * call MUST target this workspace; any other is `CrossWorkspaceReachDenied`.
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

  // Identity request (a bare `<source>__<tool>`): dispatched against the
  // caller's `IdentityContext` — no workspace. The source must be one of
  // the kernel identity sources; the handler gates entity reads by
  // `canAccess` (owner ∪ shares). See ACCESS_MODEL.
  if (scope.kind === "identity") {
    return routeIdentityCall(identityId, toolName, workspaceId, runtime);
  }
  const wsId = scope.wsId;

  if (workspaceId === undefined) {
    // Identity-scoped session with no workspace (e.g. `/mcp`). Workspace tools
    // are not reachable — only identity (bare) tools. Deny any workspace call.
    throw new WorkspaceToolUnavailable(identityId, wsId);
  }
  // Walled session: reach is bounded to the one workspace. A call to any other
  // workspace is denied even for a member. Membership + existence were validated
  // when the session / `X-Workspace-Id` was established, so there is no per-call
  // store lookup or membership scan.
  if (wsId !== workspaceId) {
    throw new CrossWorkspaceReachDenied(identityId, wsId, workspaceId);
  }

  // Step 4 — fresh context. Derived ONLY from the parsed wsId; we
  // never reach for any ambient "current workspace" pointer.
  // `Runtime.getWorkspaceContext` constructs a new instance each call,
  // so two consecutive routes for different wsIds return distinct
  // contexts by construction (cache-isolation test guards against a
  // future regression that aliases them).
  const context = runtime.getWorkspaceContext(wsId);

  // Step 5 — resolve the inner tool's `<source>__` prefix to a dispatch
  // handle in the bound workspace's registry (self-healing a transiently
  // absent source once before failing).
  const source = await resolveWorkspaceSource(wsId, toolName, runtime);

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
  const sep = toolName.indexOf("__");
  const sourceName = sep > 0 ? toolName.slice(0, sep) : toolName;

  const kernelSource = runtime.getIdentitySource(sourceName);
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
      toolName,
      source: connector,
      // The dispatch doors apply the owner's per-tool `disallow` from here — the
      // owner's identity-scoped `{scope:"user"}` policy.
      policyOwner: { scope: "user", userId: identityId },
    };
  }

  throw new UnknownIdentitySource(toolName, sourceName);
}

/** Resolve a workspace tool name's `<source>__` prefix to its registered `ToolSource`, self-healing a transiently absent source once. */
async function resolveWorkspaceSource(
  wsId: string,
  toolName: string,
  runtime: OrchestratorRuntime,
): Promise<ToolSource> {
  // The inner toolName carries the `<source>__<tool>` form the existing
  // registry routes on (see `ToolRegistry.execute` in `src/tools/registry.ts`).
  // We split on the FIRST `__` to mirror that convention.
  const sepIndex = toolName.indexOf("__");
  if (sepIndex < 0) {
    throw new UnknownToolSource(wsId, toolName, toolName);
  }
  const sourceName = toolName.slice(0, sepIndex);
  if (sourceName.length === 0) {
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
