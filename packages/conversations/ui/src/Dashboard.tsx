import { hostSupports } from "@nimblebrain/synapse";
import {
  useApp,
  useDataSync,
  useHostContext,
  useNotify,
  useOpen,
} from "@nimblebrain/synapse/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConversationList } from "./ConversationList";
import { groupByDate } from "./dateUtils";
import { Header } from "./Header";
import { type Loaded, readNext, readPages } from "./paging";
import { SearchResults } from "./SearchResults";
import type { FilterKey, SearchResultData } from "./types";

type View = "list" | "search";

/** Normalize a thrown value to a message, falling back when it isn't an Error. */
function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function Dashboard() {
  const app = useApp();
  // The host draws this view's title in its own chrome when it declares
  // `ai.nimblebrain/location`, so the view leaves its own out rather than say it
  // twice. A host without it (any other MCP Apps host) gets the view's title.
  const hostShowsTitle = hostSupports(app, "location");
  const open = useOpen();
  const notify = useNotify();
  // Pushed by the host via hostContext: the workspace the shell is focused on —
  // used here ONLY as a change signal (refetch when the user switches
  // workspace), never as a filter value: the server derives the workspace from
  // the request itself, so this app sends no workspace argument.
  const { workspace } = useHostContext<{
    workspace?: { id: string; name: string };
  }>();
  // A primitive (not the workspace object, whose identity churns per push) so a
  // refetch fires when the workspace actually changes and not on every push.
  const workspaceId = workspace?.id;

  const [view, setView] = useState<View>("list");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const conversations = loaded?.conversations ?? [];
  /** Pages read so far, so a background refresh reads as many again. */
  const pagesRef = useRef(1);
  const [activeFilter, setActiveFilter] = useState<FilterKey>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResultData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Previous focused workspace, to tell a real switch from the first render. */
  const lastWorkspaceRef = useRef(workspaceId);

  // `background: true` refreshes data in place without flipping to the skeleton
  // state — used for live background refreshes so the list doesn't flicker.
  // Rows are keyed by id, so React reconciles the swapped data without a
  // visible reload. Skeletons are reserved for the initial load + view switches.
  const loadList = useCallback(
    async (opts?: { background?: boolean }) => {
      if (!opts?.background) setLoading(true);
      setError(null);
      try {
        // No workspace argument. The list is walled to the workspace the REQUEST
        // resolves to (the host's session is at the workspace's `/mcp/<wsId>`), so the
        // scope can't be wrong here and can't be omitted into a cross-workspace
        // read — which is what happened while the host-context handshake was
        // still in flight and this app had no workspace to send.
        const next = await readPages(app, opts?.background ? pagesRef.current : 1);
        pagesRef.current = next.pages;
        setLoaded(next);
      } catch (err) {
        setError(errorMessage(err, "Failed to load conversations"));
      } finally {
        if (!opts?.background) setLoading(false);
      }
    },
    [app],
  );

  // The next page, after the rows already shown.
  const loadMore = useCallback(async () => {
    if (!loaded?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const next = await readNext(app, loaded);
      pagesRef.current = next.pages;
      setLoaded(next);
    } catch (err) {
      setError(errorMessage(err, "Failed to load conversations"));
    } finally {
      setLoadingMore(false);
    }
  }, [app, loaded, loadingMore]);

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
        const result = await app.callTool<SearchResultData>("search", {
          query,
        });
        if (result.isError) {
          setError("Search failed");
          return;
        }
        setSearchResults(result.data);
      } catch (err) {
        setError(errorMessage(err, "Search failed"));
      } finally {
        if (!opts?.background) setLoading(false);
      }
    },
    [app],
  );

  // Initial load, and a reload whenever the focused workspace changes — the
  // iframe stays mounted across a workspace switch, so without `workspaceId`
  // here the panel would keep showing the workspace the user just left.
  // `workspaceId` is a CHANGE SIGNAL only; it is never sent to the server (see
  // `loadList`), so the first load is correctly scoped even on the render
  // before the host-context handshake resolves and this is still `undefined`.
  useEffect(() => {
    // A switch to a different workspace also drops any open search: results are
    // snippets from the workspace we just left, and leaving them on screen is
    // the same cross-workspace display this whole change exists to prevent.
    const previous = lastWorkspaceRef.current;
    lastWorkspaceRef.current = workspaceId;
    if (previous !== undefined && previous !== workspaceId) {
      setView("list");
      setSearchQuery("");
      setSearchResults(null);
    }
    loadList();
  }, [loadList, workspaceId]);

  // Refresh when this app's own server announces a write. `useDataSync` fires
  // only for the conversations source, so there is nothing to filter — and in
  // the background, so the list updates in place without a skeleton flicker.
  // A generated title is one of those writes, so a new chat's row picks up its
  // title here.
  useDataSync(() => {
    if (view === "list") {
      loadList({ background: true });
    } else if (view === "search" && searchQuery) {
      runSearch(searchQuery, { background: true });
    }
  });

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
      // The host refuses a conversation it cannot show; say so rather than
      // leave the click doing nothing.
      open(`conversation://${id}`).catch((err: unknown) =>
        notify({
          level: "error",
          title: "Couldn't open the conversation",
          description: err instanceof Error ? err.message : String(err),
        }).catch(() => {}),
      );
    },
    [open, notify],
  );

  // `conversations` is already workspace-scoped by the server (see `loadList`),
  // so group it directly.
  const groups = useMemo(
    () => (loading ? [] : groupByDate(conversations)),
    [loading, conversations],
  );
  const isSearching = view === "search";

  return (
    <>
      <Header
        totalCount={loaded?.totalCount ?? 0}
        loading={loading}
        groups={groups}
        activeFilter={activeFilter}
        isSearching={isSearching}
        searchQuery={searchQuery}
        workspaceName={workspace?.name}
        showTitle={!hostShowsTitle}
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
          <>
            <ConversationList
              loading={loading}
              groups={groups}
              activeFilter={activeFilter}
              totalConversations={conversations.length}
              onOpen={handleOpenConversation}
            />
            {!loading && loaded?.nextCursor && (
              <button
                type="button"
                className="load-more"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}
