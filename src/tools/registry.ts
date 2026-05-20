import { log } from "../cli/log.ts";
import { textContent } from "../engine/content-helpers.ts";
import type { ToolCall, ToolResult, ToolRouter, ToolSchema } from "../engine/types.ts";
import type { PermissionStore } from "../permissions/permission-store.ts";
import type { McpSource } from "./mcp-source.ts";
import { rankToolSearchResults } from "./search-ranking.ts";
import type { Tool, ToolSource } from "./types.ts";

/**
 * Structural check for "looks like an McpSource task-aware surface".
 *
 * The `/mcp` task handlers (Task 002) need a source that exposes the
 * per-phase task methods so they can route `tasks/get`, `tasks/result`,
 * and `tasks/cancel` back to the originating McpSource. We probe by shape
 * rather than `instanceof` to stay friendly to `SharedSourceRef`-wrapped
 * sources and to test doubles.
 */
export function isTaskAwareSource(
  source: ToolSource,
): source is ToolSource &
  Pick<McpSource, "startToolAsTask" | "awaitToolTaskResult" | "getTaskStatus" | "cancelTask"> {
  const s = source as Partial<McpSource>;
  return (
    typeof s.startToolAsTask === "function" &&
    typeof s.awaitToolTaskResult === "function" &&
    typeof s.getTaskStatus === "function" &&
    typeof s.cancelTask === "function"
  );
}

/**
 * Non-stoppable reference wrapper for shared ToolSource objects.
 * When protected sources (e.g., default bundles, system tools) are added to
 * per-workspace registries, this wrapper prevents workspace cleanup from
 * stopping the underlying shared process.
 */
export class SharedSourceRef implements ToolSource {
  constructor(private readonly inner: ToolSource) {}
  get name(): string {
    return this.inner.name;
  }
  async start(): Promise<void> {
    // No-op — lifecycle owned by the original source
  }
  async stop(): Promise<void> {
    // No-op — prevents workspace registry cleanup from killing the shared process
  }
  tools(): Promise<Tool[]> {
    return this.inner.tools();
  }
  execute(
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    return this.inner.execute(toolName, input, signal);
  }
  /** Forward readiness subscriptions to the shared underlying source so a
   *  per-workspace registry wrapping it still learns when its tools change. */
  subscribeToolsChanged(listener: () => void): () => void {
    return this.inner.subscribeToolsChanged?.(listener) ?? (() => {});
  }
  /** Unwrap to the underlying source — used by task-aware dispatch. */
  unwrap(): ToolSource {
    return this.inner;
  }
}

/**
 * Aggregates multiple ToolSources into a single ToolRouter.
 * Routes execute() calls by prefix: "sourceName__toolName".
 */
export class ToolRegistry implements ToolRouter {
  private sources = new Map<string, ToolSource>();
  /** Workspace this registry serves (set by Runtime when constructing per-workspace). */
  private wsId: string | null = null;
  /** Permission store for tool-level policy enforcement (set by Runtime). */
  private permissionStore: PermissionStore | null = null;
  /**
   * Fired when this registry's enumerable tool set may have changed — a
   * source added/removed, or an existing source's tools transitioning
   * (subprocess (re)connect, native `tools/list_changed`). The Runtime wires
   * this to the cross-workspace tool-list aggregator's per-workspace
   * invalidation so a memoized union refreshes reactively. Null for
   * registries with no consumer (tests, CLI flows).
   */
  private invalidationListener: (() => void) | null = null;
  /** Per-source unsubscribe handles for readiness subscriptions, so
   *  `removeSource` can detach the listener it attached in `addSource`. */
  private toolsChangedUnsubs = new Map<string, () => void>();

  /**
   * Configure permission enforcement context. Called once when the
   * registry is built per-workspace. Without this context, permission
   * checks short-circuit to "allow" — for tests / CLI flows that don't
   * route through the platform's per-workspace registries.
   */
  setPermissionContext(wsId: string, permissionStore: PermissionStore): void {
    this.wsId = wsId;
    this.permissionStore = permissionStore;
  }

  /**
   * Wire the invalidation listener (typically
   * `() => aggregator.invalidateWorkspace(wsId)`). Set by the Runtime AFTER
   * boot population so the boot-time `addSource` storm doesn't fire
   * invalidations before any union is cached; post-boot mutations and
   * source-readiness transitions then invalidate reactively. Idempotent.
   */
  setInvalidationListener(listener: () => void): void {
    this.invalidationListener = listener;
  }

  private fireInvalidation(): void {
    this.invalidationListener?.();
  }

  addSource(source: ToolSource): void {
    if (this.sources.has(source.name)) {
      throw new Error(`Source "${source.name}" is already registered`);
    }
    this.sources.set(source.name, source);
    // Bridge the source's own readiness transitions (subprocess (re)connect,
    // native `tools/list_changed`) to this registry's invalidation listener.
    // Crucially this covers paths that do NOT re-enter `addSource` — a
    // HealthMonitor restart reuses the same source object, and a deferred /
    // pending-auth start completes long after the source was registered.
    const unsub = source.subscribeToolsChanged?.(() => this.fireInvalidation());
    if (unsub) this.toolsChangedUnsubs.set(source.name, unsub);
    // The membership change itself is also an invalidation trigger.
    this.fireInvalidation();
  }

  async removeSource(name: string): Promise<void> {
    const source = this.sources.get(name);
    if (source) {
      this.toolsChangedUnsubs.get(name)?.();
      this.toolsChangedUnsubs.delete(name);
      await source.stop();
      this.sources.delete(name);
      this.fireInvalidation();
    }
  }

  async availableTools(): Promise<ToolSchema[]> {
    const all: ToolSchema[] = [];
    for (const source of this.sources.values()) {
      // Per-source error containment. A connector in `starting` /
      // `pending_auth` / `dead` state has `this.client === null` and
      // throws `"<name>" not started` from McpSource.tools(). Without
      // this guard, ONE stuck connector's enumeration error rejects
      // the whole call and every chat turn fails — exactly the
      // platform-level outage shape we don't want from one bad
      // workspace source. Surface the failure in the source's own
      // status (Configure page renders it from BundleInstance.state)
      // and leave the chat usable.
      let tools: Tool[];
      try {
        tools = await source.tools();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(
          `[registry] availableTools: skipping source "${source.name}" — ${msg}. ` +
            `The bundle's own state surface (Connectors page) reflects this; the chat list ` +
            `omits its tools until the source recovers.`,
        );
        continue;
      }
      for (const tool of tools) {
        all.push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        });
      }
    }
    return all;
  }

  async execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const sepIndex = call.name.indexOf("__");
    if (sepIndex === -1) {
      // Auto-search for matching tools to help the LLM recover
      const suggestions = await this.searchTools(call.name);
      const hint =
        suggestions.length > 0
          ? `\n\nDid you mean one of these?\n${suggestions.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`
          : "";
      return {
        content: textContent(
          `Invalid tool name "${call.name}". Tool names must use the format "source__tool" (e.g., "synapse-crm__create_contact").${hint}\n\nUse nb__search to discover available tools.`,
        ),
        isError: true,
      };
    }

    const prefix = call.name.slice(0, sepIndex);
    const localName = call.name.slice(sepIndex + 2);

    const source = this.sources.get(prefix);
    if (!source) {
      const available = [...this.sources.keys()].join(", ");
      return {
        content: textContent(
          `Unknown source "${prefix}". Available sources: ${available || "none"}. Use nb__search to discover available tools.`,
        ),
        isError: true,
      };
    }

    // Permission gate: when configured, look up the per-tool policy
    // for the connector. Stage 2: every source is workspace-scoped —
    // the legacy user-pool path was deleted along with `UserPoolSource`.
    if (this.permissionStore && this.wsId) {
      const owner = { scope: "workspace" as const, wsId: this.wsId };
      const policy = await this.permissionStore.get(owner, prefix, localName);
      if (policy === "disallow") {
        return {
          content: textContent(
            `Tool "${prefix}__${localName}" is disabled by policy. Adjust in Settings → Connectors → ${prefix} → Configure.`,
          ),
          isError: true,
          structuredContent: {
            error: "tool_permission_denied",
            connector: prefix,
            tool: localName,
            scope: owner.scope,
          },
        };
      }
    }

    return source.execute(localName, call.input, signal);
  }

  /** Search all tools by natural-language terms over name + description. */
  private async searchTools(query: string): Promise<Array<{ name: string; description: string }>> {
    const all = await this.availableTools();
    return rankToolSearchResults(all, query)
      .slice(0, 5)
      .map((t) => ({ name: t.name, description: t.description }));
  }

  /** Get all registered source names. */
  sourceNames(): string[] {
    return [...this.sources.keys()];
  }

  /** Check if a source is registered. */
  hasSource(name: string): boolean {
    return this.sources.has(name);
  }

  /** Look up a single source by name. Returns undefined when absent. */
  getSource(name: string): ToolSource | undefined {
    return this.sources.get(name);
  }

  /** Get all registered sources. */
  getSources(): ToolSource[] {
    return [...this.sources.values()];
  }

  /**
   * Look up the task-aware (McpSource-shaped) source by name, unwrapping
   * `SharedSourceRef` if necessary.
   *
   * Returns `null` if the name doesn't resolve to a source, or if the
   * underlying source doesn't implement the split task API. Used by the
   * `/mcp` endpoint (Task 002) to route `tasks/{get,result,cancel}` back
   * to the originating McpSource.
   */
  findTaskAwareSource(
    name: string,
  ):
    | (ToolSource &
        Pick<McpSource, "startToolAsTask" | "awaitToolTaskResult" | "getTaskStatus" | "cancelTask">)
    | null {
    const source = this.sources.get(name);
    if (!source) return null;
    const unwrapped = source instanceof SharedSourceRef ? source.unwrap() : source;
    return isTaskAwareSource(unwrapped) ? unwrapped : null;
  }
}
