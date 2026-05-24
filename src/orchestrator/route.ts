/**
 * Per-call workspace routing for cross-workspace tool dispatch.
 *
 * Stage 2 (delegation-model refactor) makes every chat / `/mcp` tool
 * dispatch flow through this single primitive. Given a namespaced tool
 * name (`ws_<id>/<innerToolName>`) and the calling identity, the
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
 *      ambient session-level state — per `SPEC_REFERENCE.md`
 *      § Constraints item 3 the context IS the workspace boundary.
 *   5. Resolves the dispatch handle (the `ToolSource`) for the inner
 *      tool name in that workspace's registry. Throws
 *      `UnknownToolSource` if the source prefix isn't registered.
 *
 * Design rules carried from Stage 1 lessons (`SPEC_REFERENCE.md`):
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
 * error rather than coercing to a "default" workspace — see
 * `SPEC_REFERENCE.md` § Constraints item 5.
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
 * Thrown when a tool name parses to identity scope (`me-<tool>`) but the
 * identity dispatch path isn't wired yet.
 *
 * Placeholder for Phase A2 (placement scope + `IdentityContext`). Until
 * then the cross-workspace aggregator namespaces every tool by workspace,
 * so no surface emits a `me-` name — this is unreachable in normal flow
 * and exists only to fail closed on a crafted `/mcp` call. Replaced by
 * real identity routing when `IdentityContext` lands.
 */
export class IdentityScopeNotRoutable extends Error {
  readonly toolName: string;

  constructor(toolName: string) {
    super(`[orchestrator] identity-scoped tool dispatch is not yet available (tool "${toolName}")`);
    this.name = "IdentityScopeNotRoutable";
    this.toolName = toolName;
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
}

// ── Routing ───────────────────────────────────────────────────────

/**
 * Output of a successful route. The caller (the runtime's tool-call
 * dispatch path) uses `context` to scope any data access the tool
 * needs, `toolName` as the bare name to pass into `source.execute`,
 * and `source` as the dispatch target.
 */
export interface RoutedToolCall {
  /** Fresh `WorkspaceContext` bound to the parsed namespace's wsId. */
  context: WorkspaceContext;
  /** Tool name after stripping the `ws_<id>/` prefix — what the source executes. */
  toolName: string;
  /** The dispatch target — the workspace's `ToolSource` registered under the inner tool's source prefix. */
  source: ToolSource;
}

/**
 * Resolve a namespaced tool call to a workspace context + dispatch
 * handle. See module doc-comment for the routing flow and failure
 * modes.
 *
 * Pure of ambient state. Routing never reads
 * `runtime.requireWorkspaceId()` / `getCurrentWorkspaceId()` — the
 * wsId comes from the parsed namespace alone, per
 * `SPEC_REFERENCE.md` § Constraints item 3.
 */
export async function routeToolCall(opts: {
  identityId: string;
  namespacedName: string;
  runtime: OrchestratorRuntime;
}): Promise<RoutedToolCall> {
  const { identityId, namespacedName, runtime } = opts;

  if (typeof identityId !== "string" || identityId.length === 0) {
    // Programmer error, not a routing failure. Surface immediately
    // — the orchestrator's contract requires an identified caller.
    throw new Error("[orchestrator] routeToolCall: identityId is required (non-empty string)");
  }

  // Step 1 — parse. Throws UnknownNamespacedToolName on any malformed
  // input. We let it propagate; the HTTP / engine layer maps it.
  const { scope, toolName } = parseNamespacedToolName(namespacedName);

  // Identity-scoped dispatch (`me-<tool>`) routes through an
  // `IdentityContext`, not a workspace. That path lands in the next
  // commit (Phase A2 — placement scope + IdentityContext); until then no
  // producer emits `me-` names (the aggregator namespaces every tool by
  // workspace), so this branch is unreachable in normal flow. A crafted
  // `/mcp` call carrying a `me-` name lands here and fails closed.
  if (scope.kind === "identity") {
    throw new IdentityScopeNotRoutable(toolName);
  }
  const wsId = scope.wsId;

  // Step 2 — workspace existence. Distinct from access denial so
  // operators can tell "typo / cross-tenant accident" from
  // "permissions misconfiguration." `WorkspaceStore.get` returns
  // `null` for both unknown id and ENOENT — both are "doesn't exist"
  // from the orchestrator's vantage.
  const workspaceStore = runtime.getWorkspaceStore();
  const ws = await workspaceStore.get(wsId);
  if (!ws) {
    throw new UnknownWorkspace(wsId);
  }

  // Step 3 — authorization. Membership is the access check; we don't
  // consult roles here (the workspace's tools are visible to every
  // member, and per-tool permissions are enforced by the registry
  // downstream via `PermissionStore`). Personal workspaces work the
  // same way: `personalWorkspaceIdFor(userId)` lives in the user's
  // own membership list by construction.
  const accessible = await workspaceStore.getWorkspacesForUser(identityId);
  const isMember = accessible.some((w) => w.id === wsId);
  if (!isMember) {
    throw new WorkspaceAccessDenied(identityId, wsId);
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
  const source = registry.getSource(sourceName);
  if (!source) {
    throw new UnknownToolSource(wsId, toolName, sourceName);
  }

  return { context, toolName, source };
}
