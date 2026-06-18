/**
 * Identity-scoped `ToolRouter` — the bridge between Stage 2's identity-bound
 * sessions and the engine's per-call ToolRouter contract.
 *
 * A user's tool surface aggregates across every workspace they belong to
 * (per `products/nimblebrain/code/CLAUDE.md` § "Cross-workspace tool
 * namespacing"). This router is the single composition of:
 *
 *   1. `ToolListAggregator.aggregateToolList(identityId)` — the namespaced
 *      cross-workspace union the engine can discover and promote from.
 *   2. `routeToolCall({ identityId, namespacedName, runtime })` — per-call
 *      workspace existence + membership check, then dispatch into a fresh
 *      `WorkspaceContext` (or `IdentityContext` for kernel identity sources).
 *   3. `runWithRequestContext(perCallCtx, ...)` — restamps the AsyncLocalStorage
 *      scope to the ROUTED workspace, NOT the ambient session workspace,
 *      so shared `nb__*` handlers reading `requireWorkspaceId()` see the
 *      correct workspace on a cross-workspace dispatch.
 *
 * Two consumers today: the chat engine (`Runtime._chatInner`) and the
 * `nb__delegate` child engine (`DelegateContext.tools`). Both need
 * identity-wide reach. Workspace-focused defaults (initial active schemas
 * for the chat surface, default initial active set for delegate) are a
 * concern of the CALLER, not the router — see `CLAUDE.md` § "Progressive
 * disclosure". The router governs what's REACHABLE; the caller decides
 * what's IMMEDIATELY VISIBLE.
 *
 * Trust boundary: `identityId` is captured at construction time from the
 * authenticated request context. The router NEVER accepts a caller-provided
 * identity at execute time — that would defeat the membership gate.
 */

import type { ToolCall, ToolResult, ToolRouter, ToolSchema } from "../engine/types.ts";
import {
  mapOrchestratorErrorToToolResult,
  type OrchestratorRuntime,
  routeToolCall,
} from "../orchestrator/index.ts";
import type { ToolListAggregator } from "../orchestrator/tool-list-aggregator.ts";
import {
  getRequestContext,
  type RequestContext,
  type RequestScope,
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

/**
 * Subset of `ToolListAggregator` the router needs. Narrow contract so
 * unit tests can stub with a tiny in-memory aggregator that doesn't need
 * a workspace store or FS watcher.
 */
export type IdentityToolRouterAggregator = Pick<
  ToolListAggregator,
  "aggregateToolList" | "aggregateScopedToolList"
>;

export interface IdentityToolRouterOptions {
  /**
   * Captured at construction; never read from the request context at execute
   * time. The router's purpose is to commit to one identity per instance —
   * see the module doc-comment's trust-boundary note.
   */
  identityId: string;
  /**
   * Narrow runtime surface for `routeToolCall`. The production `Runtime`
   * satisfies this via `getWorkspaceStore` / `getWorkspaceContext` /
   * `getRegistryForWorkspace` / `getIdentitySource` / `getIdentityContext`.
   */
  runtime: OrchestratorRuntime;
  /** Cross-workspace tool list aggregator. */
  aggregator: IdentityToolRouterAggregator;
  /** Optional audit-attribution hook. See `WorkspaceDispatchHook`. */
  onWorkspaceDispatch?: WorkspaceDispatchHook;
  /**
   * Workspace lockdown (`features.crossWorkspaceTools === false`). When set,
   * the router's REACHABLE set and its INVOCATION gate are both scoped to this
   * workspace set — the session's focused workspace plus the user's personal
   * workspace — instead of the identity's full membership union. The caller
   * resolves it from the feature flag and the focused workspace; the router
   * stays a pure composition. Absent (the default), the ambient cross-workspace
   * union is preserved unchanged.
   */
  allowedWsIds?: readonly string[];
}

export class IdentityToolRouter implements ToolRouter {
  private readonly identityId: string;
  private readonly runtime: OrchestratorRuntime;
  private readonly aggregator: IdentityToolRouterAggregator;
  private readonly onWorkspaceDispatch?: WorkspaceDispatchHook;
  private readonly allowedWsIds?: readonly string[];

  constructor(opts: IdentityToolRouterOptions) {
    // The type system already pins the shape; we only need to catch the
    // construction-time bug (an accidental empty string from a boot path
    // or test fixture). A zero-length id would silently let the router
    // serve "no tools" for every caller — fail loudly instead.
    if (opts.identityId.length === 0) {
      throw new Error("[identity-tool-router] identityId must be a non-empty string");
    }
    this.identityId = opts.identityId;
    this.runtime = opts.runtime;
    this.aggregator = opts.aggregator;
    if (opts.onWorkspaceDispatch) this.onWorkspaceDispatch = opts.onWorkspaceDispatch;
    if (opts.allowedWsIds) this.allowedWsIds = opts.allowedWsIds;
  }

  /**
   * Cross-workspace tool union for the identity, as `ToolSchema[]`.
   *
   * `NamespacedToolDescriptor` carries every `ToolSchema` field plus
   * bookkeeping (`wsId`, `toolName`, `execution`) the engine doesn't
   * consume. We narrow here so the engine's `allToolSchemaMap` doesn't
   * pick up fields it has no contract for.
   */
  async availableTools(): Promise<ToolSchema[]> {
    // Under workspace lockdown the reachable set is scoped to {focused ∪
    // personal}; otherwise it's the identity's full cross-workspace union.
    const aggregated = this.allowedWsIds
      ? await this.aggregator.aggregateScopedToolList(this.identityId, this.allowedWsIds)
      : await this.aggregator.aggregateToolList(this.identityId);
    return aggregated.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
    }));
  }

  /**
   * Route + dispatch a tool call.
   *
   * Workspace requests (`ws_<id>-<source>__<tool>`) route through
   * `routeToolCall`, which enforces membership; identity requests
   * (bare `<source>__<tool>`) route to the kernel identity source the
   * call names. Both arms restamp the AsyncLocalStorage `RequestContext`
   * with the ROUTED scope before `source.execute(...)` so the dispatched
   * handler sees the right `WorkspaceContext` regardless of what the
   * ambient (session-level) scope is.
   *
   * Orchestrator errors are caught and rendered as `isError: true`
   * results via `mapOrchestratorErrorToToolResult`. Non-orchestrator
   * errors propagate to the engine's `run.error` path.
   */
  async execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    let routed: Awaited<ReturnType<typeof routeToolCall>>;
    try {
      routed = await routeToolCall({
        identityId: this.identityId,
        namespacedName: call.name,
        runtime: this.runtime,
        // Focus-gate: under lockdown a member can still be denied a tool whose
        // workspace isn't in {focused ∪ personal}. Undefined preserves ambient.
        ...(this.allowedWsIds ? { allowedWsIds: this.allowedWsIds } : {}),
      });
    } catch (err) {
      return mapOrchestratorErrorToToolResult(err, call.name);
    }

    if (routed.kind === "workspace" && this.onWorkspaceDispatch) {
      this.onWorkspaceDispatch(call.id, routed.context.workspaceId);
    }

    // `routed.toolName` is the inner `<source>__<tool>` form (the
    // namespace primitive only strips the `ws_<id>-` prefix).
    // `ToolSource.execute` takes the bare local tool name (no source
    // prefix) — mirroring `ToolRegistry.execute`'s contract.
    const sepIndex = routed.toolName.indexOf("__");
    const bareToolName = sepIndex >= 0 ? routed.toolName.slice(sepIndex + 2) : routed.toolName;

    // Restamp the per-call scope from the ROUTED namespace, not ambient
    // state. Workspace agent / model overrides ride along on the workspace
    // arm so session-scoped reads keep working unchanged. Identity-routed
    // calls get an identity scope with no workspace fields — there is no
    // nullable workspaceId to leak; `requireWorkspaceId()` hard-fails on
    // an identity-scoped call by construction.
    const outer = getRequestContext();
    const outerScope = outer?.scope;
    const perCallScope: RequestScope =
      routed.kind === "workspace"
        ? {
            kind: "workspace",
            workspaceId: routed.context.workspaceId,
            workspaceAgents: outerScope?.kind === "workspace" ? outerScope.workspaceAgents : null,
            workspaceModelOverride:
              outerScope?.kind === "workspace" ? outerScope.workspaceModelOverride : null,
          }
        : { kind: "identity" };
    const perCallCtx: RequestContext = {
      identity: outer?.identity ?? null,
      scope: perCallScope,
      ...(outer?.conversationId !== undefined ? { conversationId: outer.conversationId } : {}),
      ...(outer?.toolPromotion !== undefined ? { toolPromotion: outer.toolPromotion } : {}),
    };
    return runWithRequestContext(perCallCtx, () =>
      routed.source.execute(bareToolName, call.input, signal),
    );
  }
}
