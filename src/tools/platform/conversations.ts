import {
  type AccessContext,
  ConversationIndex,
  type WorkspaceScope,
} from "../../bundles/conversations/src/index-cache.ts";
import { type ExportInput, handleExport } from "../../bundles/conversations/src/tools/export.ts";
import { type ForkInput, handleFork } from "../../bundles/conversations/src/tools/fork.ts";
import { type GetInput, handleGet } from "../../bundles/conversations/src/tools/get.ts";
import { handleList, type ListInput } from "../../bundles/conversations/src/tools/list.ts";
import { handleSearch, type SearchInput } from "../../bundles/conversations/src/tools/search.ts";
import { handleStats, type StatsInput } from "../../bundles/conversations/src/tools/stats.ts";
import { handleUpdate, type UpdateInput } from "../../bundles/conversations/src/tools/update.ts";
import { capPreview } from "../../conversation/preview.ts";
import { textContent } from "../../engine/content-helpers.ts";
import type { EventSink } from "../../engine/types.ts";
import { getRequestContext } from "../../runtime/request-context.ts";
import type { Runtime } from "../../runtime/runtime.ts";
import { defineInProcessApp, type InProcessTool } from "../in-process-app.ts";
import type { McpSource } from "../mcp-source.ts";
import { loadConversationsUi } from "../platform-resources/conversations/browser.ts";
import {
  ConversationsExportInput,
  ConversationsForkInput,
  ConversationsGetInput,
  ConversationsListInput,
  ConversationsSearchInput,
  ConversationsStatsInput,
  ConversationsUpdateInput,
} from "./schemas/conversations.ts";

/**
 * Create the "conversations" platform source — an in-process MCP server.
 *
 * Replaces the former standalone stdio server (deleted Stage 1 round-8).
 * The standalone server had no identity or ownership gates and would have
 * served every user's conversations to any caller; the in-process source
 * enforces `currentAccess()` on every handler and is now the only entry
 * point. The bundle directory's `src/` (handlers, index-cache,
 * jsonl-reader) and `ui/` (the iframe dist) remain — both are imported
 * by this source.
 *
 * Tools: list, get, search, update, fork, stats, export
 * Resources: ui://conversations/browser (HTML SPA from the bundle's ui/dist)
 * Placements: sidebar conversations link at priority 1
 */
export async function createConversationsSource(
  runtime: Runtime,
  eventSink: EventSink,
): Promise<McpSource> {
  // Single process-wide ConversationIndex over the workspaces root.
  // Conversations are workspace-owned (`workspaces/<wsId>/conversations/<ownerId>/`),
  // so the index recurses every workspace's conversation subtree; each entry keeps
  // its own `filePath`, so the handlers read the right workspace file. Access
  // filtering is the dispatcher's job (see `currentAccess()` below) — the index
  // tracks ownerId on every entry and each handler narrows to the caller's set.
  //
  // Memoise the BUILD PROMISE, not the instance. `build()` publishes the index
  // object and then awaits per-file reads, so caching the instance let a second
  // concurrent caller find a non-null index, hit a no-op `refresh()` (a freshly
  // constructed index is not dirty), and read a half-built map — a short answer
  // that then races the first caller's full one. Awaiting the same promise makes
  // every caller wait for the same completed build.
  let indexBuild: Promise<ConversationIndex> | null = null;

  async function getIndex(): Promise<{ index: ConversationIndex; dir: string }> {
    const dir = runtime.getWorkspaceStore().getWorkspacesDir();
    if (!indexBuild) {
      indexBuild = (async () => {
        const idx = new ConversationIndex();
        await idx.build(dir);
        // The recursive workspace layout defeats a root `fs.watch` (it can't see nested
        // `ws_*/conversations/<owner>/*.jsonl` writes), so freshness rides the
        // runtime's invalidation hook instead of the watcher, and `refresh()`
        // acts on it at the next read.
        //
        // A conversation write (create/delete/append) names the conversation it
        // touched, so only that one file is re-read. A signal without one — a
        // workspace membership change or archive-delete, which moves an unbounded
        // set — falls back to the full rebuild. Passing the change through is what
        // keeps opening a conversation off the whole volume: the hook fires once
        // per appended event line, so a rebuild per signal means the index is
        // effectively never warm.
        runtime.onConversationsChanged((change) => {
          if (change) idx.invalidateConversation(change);
          else idx.invalidate();
        });
        return idx;
      })();
      // A failed build must not be memoised as the permanent answer.
      indexBuild.catch(() => {
        indexBuild = null;
      });
    }
    const index = await indexBuild;
    // `refresh()` coalesces concurrent rebuilds itself — it is the only place
    // the in-flight build and the dirty flag are both visible. It returns an
    // index at least as fresh as this call, not the newest possible one.
    await index.refresh();
    return { index, dir };
  }

  /**
   * Resolve the current request's access context. Reads
   * `runtime.getCurrentIdentity()`; throws if the dispatcher fires
   * without an authenticated request — these tools are user-facing
   * and have no defensible "system" caller post-Stage-1.
   */
  function currentAccess(): AccessContext {
    const identity = runtime.getCurrentIdentity();
    if (!identity) {
      throw new Error(
        "[conversations] no authenticated identity in request context — " +
          "the platform conversation tools require a user-scoped caller.",
      );
    }
    return { userId: identity.id };
  }

  /**
   * The one workspace this request's reads are walled to.
   *
   * Conversations are workspace-owned, so every read resolves inside exactly
   * one workspace: `RequestContext.workspaceId`, set on every door that can
   * reach this source — chat (the conversation's OWN workspace, so a resumed
   * thread lists its own workspace's chats no matter where the user is
   * focused), automation runs (provenance), `/mcp` (validated
   * `X-Workspace-Id`), and REST (validated header, else personal). Same seam
   * `files__*` and `automations__*` use.
   *
   * Deliberately NOT a tool argument. A caller-supplied workspace can be
   * omitted — which is exactly how the iframe's pre-handshake first call used
   * to produce a full-tenant read — and it is a coordinate the caller names
   * rather than one the request proves. No workspace in scope ⇒ deny, never a
   * cross-workspace fallback.
   */
  function currentScope(): WorkspaceScope {
    const workspaceId = getRequestContext()?.workspaceId;
    if (!workspaceId) {
      throw new Error(
        "[conversations] no workspace in scope (conversations are workspace-owned) — " +
          "the caller must carry a bound workspace, e.g. a validated X-Workspace-Id.",
      );
    }
    return { workspaceId };
  }

  /**
   * Cap a summary's `preview` on the way out.
   *
   * `preview` is the conversation's first user message and these are tool
   * responses, so an uncapped one carries a whole pasted document into the
   * agent's context — twenty of them on a default `list` page. Applied HERE,
   * at the wire, and never at the index: the stored preview backs the
   * substring match behind `list?search=`, so capping at production would
   * silently narrow recall. See `src/conversation/preview.ts`.
   */
  function capSummary<T extends { preview?: unknown }>(summary: T): T {
    if (typeof summary.preview !== "string") return summary;
    return { ...summary, preview: capPreview(summary.preview) };
  }

  /** Shared error handler — catches, formats, returns isError result. */
  function withErrorHandling(
    fn: (input: Record<string, unknown>) => Promise<object>,
  ): (
    input: Record<string, unknown>,
  ) => Promise<{ content: ReturnType<typeof textContent>; isError: boolean }> {
    return async (input) => {
      try {
        const result = await fn(input);
        return {
          content: textContent(JSON.stringify(result, null, 2)),
          isError: false,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: textContent(JSON.stringify({ error: message })),
          isError: true,
        };
      }
    };
  }

  const tools: InProcessTool[] = [
    {
      name: "list",
      description:
        "List conversations in the current workspace, with pagination, sorting, and filtering. Returns conversation metadata (title, timestamps, token counts, preview). Scoped to the workspace you are in — there is no cross-workspace listing, and no workspace argument to pass.",
      inputSchema: ConversationsListInput,
      handler: withErrorHandling(async (input) => {
        const { index } = await getIndex();
        const access = currentAccess();
        const result = await handleList(
          input as unknown as ListInput,
          index,
          currentScope(),
          access,
        );
        return { ...result, conversations: result.conversations.map(capSummary) };
      }),
    },
    {
      name: "get",
      description:
        'Load a conversation by ID. Returns metadata plus, by default, the most recent ~20 messages (with the message payload capped to ~30 KB; the full pretty-printed response stays under ~50 KB). Use expand:"metadata" for just the metadata or expand:"full" when you actually need the entire transcript — long conversations can run hundreds of thousands of tokens and full reads are recorded in tool history.',
      inputSchema: ConversationsGetInput,
      handler: withErrorHandling(async (input) => {
        const { index } = await getIndex();
        const get = input as unknown as GetInput;
        return handleGet(get, index, currentAccess(), runtime.isTurnActive(get.id));
      }),
    },
    {
      name: "search",
      description:
        "Full-text search across message content in the current workspace's conversations. Returns matching conversations with context snippets around each match. Scoped to the workspace you are in — it does not reach other workspaces.",
      inputSchema: ConversationsSearchInput,
      handler: withErrorHandling(async (input) => {
        const { index } = await getIndex();
        const access = currentAccess();
        return handleSearch(input as unknown as SearchInput, index, currentScope(), access);
      }),
    },
    {
      name: "update",
      description: "Update a conversation's title.",
      inputSchema: ConversationsUpdateInput,
      handler: withErrorHandling(async (input) => {
        const { index } = await getIndex();
        return capSummary(
          await handleUpdate(input as unknown as UpdateInput, index, currentAccess()),
        );
      }),
    },
    {
      name: "fork",
      description:
        "Fork a conversation at a specific message index, creating a new conversation with messages up to that point.",
      inputSchema: ConversationsForkInput,
      handler: withErrorHandling(async (input) => {
        const { index } = await getIndex();
        return capSummary(await handleFork(input as unknown as ForkInput, index, currentAccess()));
      }),
    },
    {
      name: "stats",
      description:
        "Token usage analytics for the current workspace. Returns total tokens, breakdown by model and skill, and top tools used.",
      inputSchema: ConversationsStatsInput,
      handler: withErrorHandling(async (input) => {
        const { index } = await getIndex();
        const access = currentAccess();
        return handleStats(input as unknown as StatsInput, index, currentScope(), access);
      }),
    },
    {
      name: "export",
      description:
        "Export a conversation as markdown or JSON. Markdown renders messages as a readable document; JSON returns raw JSONL content as a JSON array.",
      inputSchema: ConversationsExportInput,
      handler: withErrorHandling(async (input) => {
        const { index } = await getIndex();
        return handleExport(input as unknown as ExportInput, index, currentAccess());
      }),
    },
  ];

  const resources = new Map([
    ["ui://conversations/browser", { text: loadConversationsUi, mimeType: "text/html" }],
  ]);

  return defineInProcessApp(
    {
      name: "conversations",
      version: "1.0.0",
      tools,
      resources,
      placements: [
        {
          slot: "sidebar",
          resourceUri: "ui://conversations/browser",
          route: "@nimblebraininc/conversations",
          label: "Conversations",
          icon: "message-square-text",
          priority: 1,
        },
      ],
    },
    eventSink,
  );
}
