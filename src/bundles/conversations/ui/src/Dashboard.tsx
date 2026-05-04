import { useAction, useDataSync, useSynapse } from "@nimblebrain/synapse/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ConversationList } from "./ConversationList";
import { groupByDate } from "./dateUtils";
import { Header } from "./Header";
import { SearchResults } from "./SearchResults";
import type { FilterKey, ListResult, SearchResultData } from "./types";

type View = "list" | "search";

export function Dashboard() {
  const synapse = useSynapse();
  const action = useAction();

  const [view, setView] = useState<View>("list");
  const [conversations, setConversations] = useState<ListResult["conversations"]>([]);
  const [activeFilter, setActiveFilter] = useState<FilterKey>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResultData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
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
      setLoading(false);
    }
  }, [synapse]);

  const runSearch = useCallback(
    async (query: string) => {
      setView("search");
      setSearchQuery(query);
      setSearchResults(null);
      setLoading(true);
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
        setLoading(false);
      }
    },
    [synapse],
  );

  // Initial load
  useEffect(() => {
    loadList();
  }, [loadList]);

  // Reload list/search on host data-changed broadcasts.
  useDataSync(() => {
    if (view === "list") {
      loadList();
    } else if (view === "search" && searchQuery) {
      runSearch(searchQuery);
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
      if (!value.trim() && view === "search") {
        setView("list");
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

  const groups = useMemo(
    () => (loading ? [] : groupByDate(conversations)),
    [loading, conversations],
  );
  const isSearching = view === "search";

  return (
    <>
      <Header
        totalCount={conversations.length}
        loading={loading}
        groups={groups}
        activeFilter={activeFilter}
        isSearching={isSearching}
        searchQuery={searchQuery}
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
            totalConversations={conversations.length}
            onOpen={handleOpenConversation}
          />
        )}
      </div>
    </>
  );
}
