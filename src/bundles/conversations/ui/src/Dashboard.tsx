import { useAction, useDataSync, useHostContext, useSynapse } from "@nimblebrain/synapse/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ConversationList } from "./ConversationList";
import { groupByDate } from "./dateUtils";
import { Header } from "./Header";
import { SearchResults } from "./SearchResults";
import type { FilterKey, ListResult, RoomScope, SearchResultData } from "./types";

type View = "list" | "search";

export function Dashboard() {
  const synapse = useSynapse();
  const action = useAction();
  // Conversations with an in-flight assistant turn in this tab — pushed by the
  // host via hostContext. Drives a live per-row streaming indicator.
  // `workspace` is the room the shell is focused on — the binding for the
  // default room-scoped list. `streamingConversationIds` drives the live
  // per-row indicator. Both are pushed by the host via hostContext.
  const { streamingConversationIds, workspace } = useHostContext<{
    streamingConversationIds?: string[];
    workspace?: { id: string; name: string; isPersonal?: boolean };
  }>();
  const streamingIds = useMemo(
    () => new Set(streamingConversationIds ?? []),
    [streamingConversationIds],
  );

  const [view, setView] = useState<View>("list");
  const [conversations, setConversations] = useState<ListResult["conversations"]>([]);
  const [activeFilter, setActiveFilter] = useState<FilterKey>("all");
  // Default to the focused room — the list matches where you are. "All rooms"
  // is the deliberate cross-room escape hatch.
  const [roomScope, setRoomScope] = useState<RoomScope>("current");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResultData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // `background: true` refreshes data in place without flipping to the skeleton
  // state — used for live data-changed refreshes so the list doesn't flicker.
  // Rows are keyed by id, so React reconciles the swapped data without a
  // visible reload. Skeletons are reserved for the initial load + view switches.
  const loadList = useCallback(
    async (opts?: { background?: boolean }) => {
      if (!opts?.background) setLoading(true);
      setError(null);
      try {
        const result = await synapse.callTool<Record<string, never>, ListResult>("list", {});
        if (result.isError) {
          setError("Failed to load conversations");
          return;
        }
        setConversations(result.data.conversations || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load conversations");
      } finally {
        if (!opts?.background) setLoading(false);
      }
    },
    [synapse],
  );

  const runSearch = useCallback(
    async (query: string, opts?: { background?: boolean }) => {
      setView("search");
      setSearchQuery(query);
      if (!opts?.background) {
        setSearchResults(null);
        setLoading(true);
      }
      setError(null);
      try {
        const result = await synapse.callTool<{ query: string }, SearchResultData>("search", {
          query,
        });
        if (result.isError) {
          setError("Search failed");
          return;
        }
        setSearchResults(result.data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Search failed");
      } finally {
        if (!opts?.background) setLoading(false);
      }
    },
    [synapse],
  );

  // Initial load
  useEffect(() => {
    loadList();
  }, [loadList]);

  // Refresh on host data-changed broadcasts — but only for conversation
  // changes (ignore unrelated apps' data.changed), and in the background so
  // the list updates in place without a skeleton flicker.
  useDataSync((event) => {
    if (event.server !== "conversations") return;
    if (view === "list") {
      loadList({ background: true });
    } else if (view === "search" && searchQuery) {
      runSearch(searchQuery, { background: true });
    }
  });

  // Live conversation-title updates from auto-title generation.
  //
  // The host (App.tsx) forwards each `conversation.title` SSE event to this
  // iframe via a `synapse/conversation-title` postMessage. We patch the
  // matching row's title in-place instead of refetching the whole list — the
  // runtime used to fire an extra `data.changed` on title-resolve to force a
  // refetch, but that triggered a full reload of every row. Listening
  // directly is cheaper and updates a single row without flicker.
  //
  // Raw `window.addEventListener` (not via the synapse SDK) because the SDK
  // doesn't know this method; the host owns both ends, so the side channel
  // is safe. The SDK's own `message` listener ignores envelopes whose
  // `method` it doesn't recognize, so there's no double-handling.
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.jsonrpc !== "2.0" || msg.method !== "synapse/conversation-title") return;
      const params = msg.params;
      if (!params || typeof params !== "object") return;
      const conversationId = (params as { conversationId?: unknown }).conversationId;
      const title = (params as { title?: unknown }).title;
      if (typeof conversationId !== "string" || typeof title !== "string") return;
      setConversations((prev) => {
        let changed = false;
        const next = prev.map((c) => {
          if (c.id !== conversationId) return c;
          changed = true;
          return { ...c, title };
        });
        return changed ? next : prev;
      });
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const handleSelectFilter = useCallback(
    (key: FilterKey) => {
      setActiveFilter(key);
      // If a filter pill is clicked while in search view, drop back to the list.
      setView((v) => (v === "search" ? "list" : v));
      setSearchQuery((q) => (view === "search" ? "" : q));
      setSearchResults(null);
    },
    [view],
  );

  const handleSearchInput = useCallback(
    (value: string) => {
      setSearchQuery(value);
      // Empty input while in search view → revert to full list.
      // Clear stale results so the state machine doesn't carry phantom data
      // into the next search session.
      if (!value.trim() && view === "search") {
        setView("list");
        setSearchResults(null);
        loadList();
      }
    },
    [view, loadList],
  );

  const handleSearchSubmit = useCallback(() => {
    const q = searchQuery.trim();
    if (q) runSearch(q);
  }, [searchQuery, runSearch]);

  const handleClearSearch = useCallback(() => {
    setSearchQuery("");
    setSearchResults(null);
    setView("list");
  }, []);

  const handleOpenConversation = useCallback(
    (id: string) => {
      action("openConversation", { id });
    },
    [action],
  );

  // Scope the list to the focused room by default. A chat with no stamped
  // room belongs to the personal room, so it shows only when the focused room
  // IS personal. "All rooms" bypasses the filter for the cross-room view.
  const roomScoped = useMemo(() => {
    if (roomScope === "all" || !workspace) return conversations;
    return conversations.filter((c) =>
      c.workspaceId ? c.workspaceId === workspace.id : workspace.isPersonal === true,
    );
  }, [conversations, roomScope, workspace]);

  const groups = useMemo(() => (loading ? [] : groupByDate(roomScoped)), [loading, roomScoped]);
  const isSearching = view === "search";

  return (
    <>
      <Header
        totalCount={roomScoped.length}
        loading={loading}
        groups={groups}
        activeFilter={activeFilter}
        isSearching={isSearching}
        searchQuery={searchQuery}
        roomName={workspace?.name}
        roomScope={roomScope}
        onSelectRoomScope={setRoomScope}
        onSelectFilter={handleSelectFilter}
        onSearchInput={handleSearchInput}
        onSearchSubmit={handleSearchSubmit}
        onClearSearch={handleClearSearch}
      />
      <div className="content">
        {error && <div className="error-banner">{error}</div>}
        {isSearching ? (
          <SearchResults
            loading={loading}
            results={searchResults}
            query={searchQuery}
            onOpen={handleOpenConversation}
          />
        ) : (
          <ConversationList
            loading={loading}
            groups={groups}
            activeFilter={activeFilter}
            totalConversations={roomScoped.length}
            streamingIds={streamingIds}
            onOpen={handleOpenConversation}
          />
        )}
      </div>
    </>
  );
}
