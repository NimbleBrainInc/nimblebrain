/**
 * Identity-scoped `ToolRouter` — the bridge between Stage 2's identity-bound
 * sessions and the engine's per-call ToolRouter contract.
 *
 * A session is bounded to one workspace (the wall). This router is the single
 * composition of:
 *
 *   1. `runtime.listToolsForWorkspace(workspaceId)` — the bound workspace's
 *      tools (bare) plus identity tools; the engine's reachable universe.
 *   2. `routeToolCall({ identityId, namespacedName, workspaceId, runtime })` —
 *      per-call wall check (the target must be the bound workspace), then
 *      dispatch into a fresh `WorkspaceContext` (or `IdentityContext` for
 *      kernel identity sources).
 *   3. `runWithRequestContext(perCallCtx, ...)` — restamps the AsyncLocalStorage
 *      scope to the ROUTED workspace, NOT the ambient session workspace,
 *      so shared `nb__*` handlers reading `requireWorkspaceId()` see the
 *      correct workspace on a cross-workspace dispatch.
 *
 * The chat engine (`Runtime._chatInner`) is its consumer. It reaches exactly
 * one workspace's tools plus the caller's identity tools — the bound
 * `workspaceId`, never a cross-workspace union. Which of those reachable
 * tools start IMMEDIATELY VISIBLE (the initial active schemas) is a concern of
 * the CALLER, not the router — see `CLAUDE.md` § "Progressive disclosure". The
 * router governs what's REACHABLE; the caller decides what's visible.
 *
 * Trust boundary: `identityId` is captured at construction time from the
 * authenticated request context. The router NEVER accepts a caller-provided
 * identity at execute time — that would defeat the membership gate.
 */

import type { ToolCall, ToolResult, ToolRouter, ToolSchema } from "../engine/types.ts";
// Imported from the two modules rather than from `../orchestrator/index.ts`:
// the barrel also exports `dispatchUnattended`, which composes THIS router, and
// going through it would close a cycle for no gain.
import { mapOrchestratorErrorToToolResult } from "../orchestrator/error-mapping.ts";
import {
  type OrchestratorRuntime,
  type RoutedToolCall,
  routeToolCall,
} from "../orchestrator/route.ts";
import { assertToolAllowed } from "../permissions/assert-tool-allowed.ts";
import type { PermissionOwner } from "../permissions/permission-store.ts";
import { splitInnerToolName } from "../util/tool-name.ts";
import {
  getRequestContext,
  type RequestContext,
  runWithRequestContext,
} from "./request-context.ts";

/**
 * Hook fired BEFORE `source.execute(...)` runs for a workspace-routed call.
 *
 * The chat surface uses this to stamp the dispatch-time `workspaceId`
 * into a per-call audit map; the wrapped sink reads the entry on
 * `tool.progress` / `tool.done` so events attribute back to the routed
 * workspace, not the chat session's focused workspace. Identity-routed
 * calls don't fire the hook — there's no workspace to stamp (the entity
 * carries its own ownership via `canAccess`).
 *
 * Synchronous on purpose: the hook runs in the critical path before
 * `source.execute` is awaited. A long-running hook would gate the
 * dispatch. Callers should write to in-memory bookkeeping only.
 */
export type WorkspaceDispatchHook = (callId: string, wsId: string) => void;

export interface IdentityToolRouterOptions {
  /**
   * Captured at construction; never read from the request context at execute
   * time. The router's purpose is to commit to one identity per instance —
   * see the module doc-comment's trust-boundary note.
   */
  identityId: string;
  /**
   * The session's single workspace (the wall). `availableTools` lists this
   * workspace plus identity tools; `execute` denies any call to another
   * workspace. Captured at construction alongside the identity.
   */
  workspaceId: string;
  /**
   * Narrow runtime surface for `routeToolCall`. The production `Runtime`
   * satisfies this via `getWorkspaceStore` / `getWorkspaceContext` /
   * `getRegistryForWorkspace` / `getIdentitySource` / `getIdentityContext` /
   * `listToolsForWorkspace`.
   */
  runtime: OrchestratorRuntime;
  /** Optional audit-attribution hook. See `WorkspaceDispatchHook`. */
  onWorkspaceDispatch?: WorkspaceDispatchHook;
}

/**
 * Rebuild the per-call context from the ambient one.
 *
 * A workspace route restamps `workspaceId` from the ROUTED namespace rather
 * than ambient state; the wall guarantees that is the same workspace the
 * session is bound to, so this is a re-assertion, not a widening. An
 * identity-routed call keeps the ambient workspace — every kernel identity
 * source (`files__*`, `automations__*`, `conversations__*`) owns
 * workspace-partitioned data and would otherwise have no workspace in scope
 * even when the chat set one. Workspace model overrides ride along unchanged
 * so session-scoped reads keep working.
 */
function buildPerCallContext(
  outer: RequestContext | undefined,
  routed: RoutedToolCall,
): RequestContext {
  const workspaceId = routed.kind === "workspace" ? routed.context.workspaceId : outer?.workspaceId;
  return {
    identity: outer?.identity ?? null,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(outer?.workspaceModelOverride !== undefined
      ? { workspaceModelOverride: outer.workspaceModelOverride }
      : {}),
    ...(outer?.conversationId !== undefined ? { conversationId: outer.conversationId } : {}),
    // `runId` rides the restamp for the same reason `conversationId` does: it
    // is what correlates a task run's work, and the usage ledger and telemetry
    // read it at tool-dispatch depth. This list is an allowlist — a field not
    // named here is silently absent below the top level, which is how a run's
    // correlation id disappears from everything a tool call records.
    ...(outer?.runId !== undefined ? { runId: outer.runId } : {}),
    // The model the turn runs on rides the restamp so a tool asked what it is
    // running on answers from the run rather than from config.
    ...(outer?.model !== undefined ? { model: outer.model } : {}),
    ...(outer?.toolPromotion !== undefined ? { toolPromotion: outer.toolPromotion } : {}),
    // `unattended` rides the restamp so a tool dispatched from an unattended
    // run stays walled from the automation-authoring surface. Dropping it here
    // would reopen the wall for anything below the top level.
    ...(outer?.unattended !== undefined ? { unattended: outer.unattended } : {}),
    // Rides the restamp for the same reason `unattended` does: the outbound
    // `_meta` stamp is read at dispatch depth, below this rebuild, so dropping
    // it here would erase the provenance from every call the door makes.
    ...(outer?.unattendedReason !== undefined ? { unattendedReason: outer.unattendedReason } : {}),
  };
}

export class IdentityToolRouter implements ToolRouter {
  private readonly identityId: string;
  private readonly workspaceId: string;
  private readonly runtime: OrchestratorRuntime;
  private readonly onWorkspaceDispatch?: WorkspaceDispatchHook;

  constructor(opts: IdentityToolRouterOptions) {
    // The type system already pins the shape; we only need to catch the
    // construction-time bug (an accidental empty string from a boot path
    // or test fixture). A zero-length id would silently let the router
    // serve "no tools" for every caller — fail loudly instead.
    if (opts.identityId.length === 0) {
      throw new Error("[identity-tool-router] identityId must be a non-empty string");
    }
    this.identityId = opts.identityId;
    this.workspaceId = opts.workspaceId;
    this.runtime = opts.runtime;
    if (opts.onWorkspaceDispatch) this.onWorkspaceDispatch = opts.onWorkspaceDispatch;
  }

  /**
   * The session's reachable tool surface, as `ToolSchema[]`: the bound
   * workspace's tools (bare) plus the caller's identity tools. This is
   * the engine's reachable universe — a session reaches exactly one workspace.
   */
  async availableTools(): Promise<ToolSchema[]> {
    return this.runtime.listToolsForWorkspace(this.workspaceId, this.identityId);
  }

  /**
   * Route + dispatch a tool call.
   *
   * Every name is bare `<source>__<tool>`; the source segment picks the door.
   * A kernel identity source or the `my_` personal-connector marker routes to
   * the identity source named; anything else routes through `routeToolCall`
   * into the session's own workspace, which was membership-validated when the
   * session was established. Both arms restamp the AsyncLocalStorage `RequestContext`
   * with the ROUTED scope before `source.execute(...)` so the dispatched
   * handler sees the right `WorkspaceContext` regardless of what the
   * ambient (session-level) scope is.
   *
   * Orchestrator errors are caught and rendered as `isError: true`
   * results via `mapOrchestratorErrorToToolResult`. Non-orchestrator
   * errors propagate to the engine's `run.error` path.
   */
  async execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    let routed: RoutedToolCall;
    try {
      routed = await routeToolCall({
        identityId: this.identityId,
        namespacedName: call.name,
        workspaceId: this.workspaceId,
        runtime: this.runtime,
      });
    } catch (err) {
      return mapOrchestratorErrorToToolResult(err, call.name);
    }

    if (routed.kind === "workspace" && this.onWorkspaceDispatch) {
      this.onWorkspaceDispatch(call.id, routed.context.workspaceId);
    }

    // `routed.toolName` is the inner `<source>__<tool>` form (the namespace
    // primitive only strips the `ws_<id>-` prefix). `ToolSource.execute` takes
    // the bare local tool name (no source prefix), decomposed through the one
    // grammar every door shares (`src/util/tool-name.ts`).
    const { sourcePrefix, bareToolName } = splitInnerToolName(routed.toolName);

    const denied = await this.connectorPermissionDenial(routed, sourcePrefix, bareToolName);
    if (denied) return denied;

    // Restamp the per-call workspace from the ROUTED namespace, not ambient
    // state.
    const outer = getRequestContext();
    const perCallCtx = buildPerCallContext(outer, routed);
    return runWithRequestContext(perCallCtx, () =>
      routed.source.execute(bareToolName, call.input, signal),
    );
  }

  /**
   * Per-tool `disallow` gate, returning the denial result when the tool's policy
   * is `disallow`, else `null`. Runs after routing, before `source.execute`.
   *
   * The policy owner comes from routing, never re-inferred here:
   *   - **Workspace tool** — the focused workspace (`routed.context.workspaceId`),
   *     just like the REST registry and `/mcp` doors.
   *   - **Personal connector** — the owner, stamped on the identity route as
   *     `policyOwner` (the SAME policy the workspace door consults when the
   *     connector runs at home), so a granted connector is never MORE capable in
   *     a shared room than at home.
   *
   * Kernel identity sources have no `policyOwner` and pass through (`null`).
   */
  private async connectorPermissionDenial(
    routed: RoutedToolCall,
    sourcePrefix: string,
    bareToolName: string,
  ): Promise<ToolResult | null> {
    const permissionStore = this.runtime.getPermissionStore?.();
    if (!permissionStore) return null;
    const owner: PermissionOwner | undefined =
      routed.kind === "workspace"
        ? { scope: "workspace", wsId: routed.context.workspaceId }
        : routed.policyOwner;
    if (!owner) return null;
    return assertToolAllowed(permissionStore, owner, sourcePrefix, bareToolName);
  }
}
