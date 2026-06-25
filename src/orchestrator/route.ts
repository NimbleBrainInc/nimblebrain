/**
 * Per-call workspace routing for cross-workspace tool dispatch.
 *
 * Stage 2 (cross-workspace refactor) makes every chat / `/mcp` tool
 * dispatch flow through this single primitive. Given a namespaced tool
 * name (`ws_<id>-<innerToolName>`) and the calling identity, the
 * orchestrator:
 *
 *   1. Parses the namespace via `parseNamespacedToolName` (T002 — the
 *      only legal parse site for the form). Throws
 *      `UnknownNamespacedToolName` on malformed input.
 *   2. Confirms the workspace exists in the store. Throws
 *      `UnknownWorkspace` if not — distinct from "identity can't see
 *      it" so operators can triage cross-tenant accidents vs typos.
 *   3. Authorizes the identity against the workspace's membership.
 *      Throws `WorkspaceAccessDenied` if the workspace exists but the
 *      identity isn't a member.
 *   4. Constructs a fresh `WorkspaceContext` derived from the parsed
 *      `wsId`. NEVER from `runtime.requireWorkspaceId()` or any other
 *      ambient session-level state — the context IS the workspace boundary.
 *   5. Resolves the dispatch handle (the `ToolSource`) for the inner
 *      tool name in that workspace's registry. Throws
 *      `UnknownToolSource` if the source prefix isn't registered.
 *
 * Design rules carried from Stage 1 lessons:
 *
 *   - **Lesson 3 — strict invariants over defensive defaults.** No
 *     `wsId ?? "ws_default"`, no fallback to "current workspace." Every
 *     failure throws a structured error the caller can map.
 *   - **Lesson 6 — derive don't cast.** Types flow from the existing
 *     `WorkspaceContext` and `ToolSource` shapes; no `as unknown as T`.
 *   - **No ambient state.** The orchestrator never reads
 *     `runtime.requireWorkspaceId()` / `getCurrentWorkspaceId()`. The
 *     wsId comes from the parsed namespace alone.
 *
 * The runtime dependency is expressed as a narrow structural type
 * (`OrchestratorRuntime`) so unit tests can stub without spinning up
 * the full `Runtime`. The production `Runtime` satisfies this shape by
 * exposing `getWorkspaceStore()`, `getWorkspaceContext(wsId)`, and
 * `getRegistryForWorkspace(wsId)` — all already in place pre-Stage-2.
 */

import type { ToolSchema } from "../engine/types.ts";
import type { IdentityContext } from "../identity/context.ts";
import { parseNamespacedToolName, UnknownNamespacedToolName } from "../tools/namespace.ts";
import type { ToolSource } from "../tools/types.ts";
import type { WorkspaceContext } from "../workspace/context.ts";

// ── Errors ─────────────────────────────────────────────────────────

/**
 * Thrown when a namespaced tool name's `wsId` is not registered in the
 * workspace store. Distinct from `WorkspaceAccessDenied` on purpose:
 *
 *   - `UnknownWorkspace`     — the wsId is bogus (typo, cross-tenant
 *                              accident, deleted workspace).
 *   - `WorkspaceAccessDenied` — the workspace exists but the identity
 *                              isn't a member.
 *
 * Operators triaging "tool call failed" need to distinguish these:
 * the former points at a buggy client / stale link; the latter at a
 * permissions misconfiguration or an attempted cross-tenant probe.
 * Conflating them would hide both shapes under one symptom.
 */
export class UnknownWorkspace extends Error {
  readonly wsId: string;

  constructor(wsId: string) {
    super(`[orchestrator] unknown workspace "${wsId}"`);
    this.name = "UnknownWorkspace";
    this.wsId = wsId;
  }
}

/**
 * Thrown when the workspace exists but the calling identity isn't a
 * member. The orchestrator deliberately surfaces this as an explicit
 * error rather than coercing to a "default" workspace.
 *
 * The payload carries both `identityId` and `wsId` so the HTTP layer
 * can emit a structured 403 without re-parsing the name.
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
 * `-32602`) applies unchanged, while `name` / `focusedWorkspaceId` let audit
 * distinguish "walled" from "not a member."
 */
export class CrossWorkspaceReachDenied extends WorkspaceAccessDenied {
  readonly focusedWorkspaceId: string;

  constructor(identityId: string, wsId: string, focusedWorkspaceId: string) {
    super(identityId, wsId);
    this.name = "CrossWorkspaceReachDenied";
    this.message = `[orchestrator] session is bounded to workspace "${focusedWorkspaceId}"; reach to "${wsId}" is denied`;
    this.focusedWorkspaceId = focusedWorkspaceId;
  }
}

/**
 * Thrown when the inner tool name's source prefix isn't registered in
 * the target workspace's `ToolRegistry`. Surfaced separately from
 * `UnknownWorkspace` because the failure mode is different: the
 * workspace exists and the identity has access, but no bundle in that
 * workspace serves the requested source.
 *
 * Not in the task spec's "three distinct types" list — added as a
 * fourth strict error rather than throwing a bare `Error` so the
 * HTTP layer / audit can distinguish "tool source not installed" from
 * "tool exists but execution failed." Disclosed in the task report.
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
   * Workspace-store surface. The orchestrator calls `get(wsId)` to
   * confirm existence and `getWorkspacesForUser(userId)` to confirm
   * membership. Returning a narrowed interface keeps stubs minimal.
   */
  getWorkspaceStore(): {
    get(wsId: string): Promise<{ id: string } | null>;
    getWorkspacesForUser(userId: string): Promise<Array<{ id: string }>>;
  };

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

  /** Fresh `IdentityContext` for the authenticated identity. No workspace. */
  getIdentityContext(identityId: string): IdentityContext;

  /**
   * The walled tool surface for a session bounded to `wsId`: that workspace's
   * tools (namespaced `ws_<id>-<tool>`) plus the caller's identity tools
   * (bare). The engine's reachable universe — there is no cross-workspace
   * union.
   */
  listToolsForWorkspace(wsId: string): Promise<ToolSchema[]>;
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
      /** The kernel identity source the inner tool dispatches to. */
      source: ToolSource;
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
    const sep = toolName.indexOf("__");
    const sourceName = sep > 0 ? toolName.slice(0, sep) : toolName;
    const source = runtime.getIdentitySource(sourceName);
    if (!source) {
      throw new UnknownIdentitySource(toolName, sourceName);
    }
    return {
      kind: "identity",
      context: runtime.getIdentityContext(identityId),
      toolName,
      source,
    };
  }
  const wsId = scope.wsId;

  if (workspaceId !== undefined) {
    // Walled session: reach is bounded to the one workspace. A call to any
    // other workspace is denied even for a member. Membership + existence were
    // validated when the session / `X-Workspace-Id` was established, so there
    // is no per-call store lookup or membership scan.
    if (wsId !== workspaceId) {
      throw new CrossWorkspaceReachDenied(identityId, wsId, workspaceId);
    }
  } else {
    // Legacy `/mcp` path (no session workspace threaded yet): confirm the
    // workspace exists and the identity is a member. `WorkspaceStore.get`
    // returns `null` for both unknown id and ENOENT — both are "doesn't exist."
    const workspaceStore = runtime.getWorkspaceStore();
    const ws = await workspaceStore.get(wsId);
    if (!ws) {
      throw new UnknownWorkspace(wsId);
    }
    const accessible = await workspaceStore.getWorkspacesForUser(identityId);
    if (!accessible.some((w) => w.id === wsId)) {
      throw new WorkspaceAccessDenied(identityId, wsId);
    }
  }

  // Step 4 — fresh context. Derived ONLY from the parsed wsId; we
  // never reach for any ambient "current workspace" pointer.
  // `Runtime.getWorkspaceContext` constructs a new instance each call,
  // so two consecutive routes for different wsIds return distinct
  // contexts by construction (cache-isolation test guards against a
  // future regression that aliases them).
  const context = runtime.getWorkspaceContext(wsId);

  // Step 5 — source lookup. The inner toolName carries the
  // `<source>__<tool>` form the existing registry routes on (see
  // `ToolRegistry.execute` in `src/tools/registry.ts`). We split on
  // the FIRST `__` to mirror that convention.
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
  if (!source && runtime.recoverWorkspaceSource) {
    // Self-heal. An installed bundle's source can be transiently absent
    // from the registry: a failed credential respawn or a remote-OAuth
    // teardown removes it WITHOUT re-adding, and nothing on the chat /
    // automation hot path re-registers it — so the workspace stays
    // toolless until a platform restart (the failure that bricked a
    // workspace's Dropbox tools mid-run for both chat and its scheduled
    // automations). Give the runtime ONE best-effort, cooldown-guarded
    // chance to re-spawn the source from its persisted ref, then
    // re-resolve against the same registry. A still-missing source falls
    // through to the same `UnknownToolSource` as before — recovery only
    // repairs a recoverable absence, it never hides a genuine failure.
    let recovered = false;
    try {
      recovered = await runtime.recoverWorkspaceSource(wsId, sourceName);
    } catch {
      // Recovery is strictly best-effort; a throw here is no worse than
      // no recovery at all. Fall through to UnknownToolSource.
      recovered = false;
    }
    if (recovered) source = registry.getSource(sourceName);
  }
  if (!source) {
    throw new UnknownToolSource(wsId, toolName, sourceName);
  }

  return { kind: "workspace", context, toolName, source };
}
