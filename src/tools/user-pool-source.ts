import { WORKSPACE_PRINCIPAL_ID } from "../bundles/connection.ts";
import { log } from "../cli/log.ts";
import { textContent } from "../engine/content-helpers.ts";
import type { McpSource } from "./mcp-source.ts";
import type { Tool, ToolResult, ToolSource } from "./types.ts";

/**
 * Sentinel principal id used in `oauthScope: "workspace"` Connections.
 * Re-exported under a pool-local alias so existing callers keep working,
 * but sourced from `bundles/connection.ts` to prevent drift between the
 * two constants.
 */
export const POOL_WORKSPACE_PRINCIPAL = WORKSPACE_PRINCIPAL_ID;

/**
 * `ToolSource` adapter that holds N per-principal `McpSource`s under one
 * registry entry. Used for `oauthScope: "user"` URL bundles where each
 * workspace member authenticates independently and tool calls must route
 * to the calling member's tokens.
 *
 * Why this lives at the registry layer rather than inside `McpSource`:
 * the existing `McpSource` is the right granularity for "one Client/
 * Transport/auth provider"; member-scope is a multi-Client concern that
 * doesn't belong inside it. Keeping single- vs multi-principal as
 * separate types means the single-principal McpSource stays small and
 * the multi-principal pool encapsulates the dispatch rules without
 * bimodal logic threading through the inner source.
 *
 * Concurrency model: each per-member McpSource has its own Client and
 * Transport, so concurrent tool calls from different members don't
 * contend on shared mutable state. Tool-list cache assignment is
 * last-writer-wins (idempotent), which is acceptable.
 *
 * Failure isolation: a member's transport crash, refresh-token expiry,
 * or auth flow failure affects only that member's source — others
 * continue working.
 *
 * Tool-list semantics: the pool returns the cached tool list from any
 * member that has connected at least once. Until the first member
 * connects, the pool returns `[]` — agents see no tools from this bundle
 * and the Connections page surfaces "Connect to access N tools" as the
 * affordance. When the first member connects, their `tools/list` result
 * caches at the pool level for everyone (assumption: tool surface is
 * largely user-independent for the services we care about — see
 * REMOTE_MCP_CONNECTIONS.md design § 4 for the rationale).
 */
export class UserPoolSource implements ToolSource {
  readonly name: string;
  /** principalId → underlying McpSource. Lazily populated. */
  private readonly members = new Map<string, McpSource>();
  /** Tool list cached at the pool level; first connecting member fills it. */
  private cachedTools: Tool[] | null = null;
  private stopped = false;

  constructor(serverName: string) {
    this.name = serverName;
  }

  // ── ToolSource lifecycle ─────────────────────────────────────────

  async start(): Promise<void> {
    // No-op at boot. Members create their own per-principal sources
    // lazily when they connect via the UI or call a tool.
    this.stopped = false;
  }

  async stop(): Promise<void> {
    // Tear down every per-member source. Safe to call repeatedly; each
    // source's stop() is idempotent.
    this.stopped = true;
    const sources = [...this.members.values()];
    this.members.clear();
    for (const src of sources) {
      try {
        await src.stop();
      } catch (err) {
        log.debug("mcp", `[member-pool ${this.name}] stop failed for one member: ${String(err)}`);
      }
    }
  }

  async tools(): Promise<Tool[]> {
    if (this.cachedTools) return this.cachedTools;
    // Try any connected member's source — first one that's alive wins.
    for (const src of this.members.values()) {
      try {
        const t = await src.tools();
        this.cachedTools = t;
        return t;
      } catch {
        // Skip dead/uninitialized sources; try the next.
      }
    }
    return [];
  }

  async execute(
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    principalId?: string,
  ): Promise<ToolResult> {
    if (this.stopped) {
      return fail(`Member-scoped bundle "${this.name}" is stopped.`);
    }
    if (!principalId || principalId === POOL_WORKSPACE_PRINCIPAL) {
      // No principal threaded → can't pick member tokens. Surface a
      // structured error that the caller can map to "this is a member-
      // scope bundle; the request needs an identity."
      return fail(
        `Member-scoped bundle "${this.name}" requires an authenticated principal. ` +
          "If you're calling from the agent loop, the conversation needs an owner.",
      );
    }
    const src = this.members.get(principalId);
    if (!src) {
      // Member hasn't connected this bundle. The structured error tells
      // the agent (and the human reading the chat) what to do. The
      // Connections page is the affordance.
      return fail(
        `You haven't connected "${this.name}" yet. Visit Settings → Connections to authenticate.`,
        { code: "pending_auth", serverName: this.name, principalId },
      );
    }
    return src.execute(toolName, input, signal, principalId);
  }

  // ── Pool-specific surface ────────────────────────────────────────

  /**
   * Insert (or replace) a per-member McpSource. Called by lifecycle
   * after constructing the source for a newly-authenticated member.
   *
   * If a previous source for this principal exists it's stopped first
   * so we don't leak Clients on reconnect. Tool-list cache is left in
   * place — the new source's tools should match.
   */
  async setUserSource(principalId: string, source: McpSource): Promise<void> {
    const existing = this.members.get(principalId);
    if (existing) {
      try {
        await existing.stop();
      } catch {
        // ignore — replacing anyway
      }
    }
    this.members.set(principalId, source);
    // Refresh the cache from the new source if we don't have one yet.
    // Best-effort: a transient tools() failure just leaves the cache
    // null and `tools()` will retry next call.
    if (!this.cachedTools) {
      try {
        this.cachedTools = await source.tools();
      } catch {
        // leave null
      }
    }
  }

  /** Get the per-member McpSource, or undefined if the member isn't connected. */
  getUserSource(principalId: string): McpSource | undefined {
    return this.members.get(principalId);
  }

  /** Drop a member from the pool (e.g. on disconnect / member removal). */
  async removeUser(principalId: string): Promise<void> {
    const src = this.members.get(principalId);
    if (!src) return;
    this.members.delete(principalId);
    try {
      await src.stop();
    } catch {
      // ignore
    }
  }

  /** Snapshot of currently-pooled principal ids. Diagnostic / tests only. */
  getMemberIds(): string[] {
    return [...this.members.keys()];
  }
}

function fail(message: string, structured?: Record<string, unknown>): ToolResult {
  return {
    content: textContent(message),
    isError: true,
    ...(structured ? { structuredContent: { error: structured } } : {}),
  };
}
