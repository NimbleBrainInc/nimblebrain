import { FILTER_GROUPS, FILTER_LABELS } from "./dateUtils";
import type { DateGroup, FilterKey, RoomScope } from "./types";

interface HeaderProps {
  totalCount: number;
  loading: boolean;
  groups: DateGroup[];
  activeFilter: FilterKey;
  isSearching: boolean;
  searchQuery: string;
  /** Display name of the focused room; absent until the host handshake lands. */
  roomName?: string;
  roomScope: RoomScope;
  onSelectRoomScope: (scope: RoomScope) => void;
  onSelectFilter: (key: FilterKey) => void;
  onSearchInput: (value: string) => void;
  onSearchSubmit: () => void;
  onClearSearch: () => void;
}

// React preserves the input's DOM node across re-renders, so the input keeps
// its focus naturally when the user clears via Esc / × / typing. The original
// inline-HTML implementation needed manual `.focus()` because each render
// rewrote the entire DOM via `innerHTML`; that's no longer the case.
export function Header({
  totalCount,
  loading,
  groups,
  activeFilter,
  isSearching,
  searchQuery,
  roomName,
  roomScope,
  onSelectRoomScope,
  onSelectFilter,
  onSearchInput,
  onSearchSubmit,
  onClearSearch,
}: HeaderProps) {
  const hasQuery = searchQuery.trim().length > 0;

  return (
    <div className="header">
      <div className="header-top">
        <div className="header-title">Conversations</div>
        {roomName && (
          <select
            className="room-select"
            value={roomScope}
            onChange={(e) => onSelectRoomScope(e.target.value as RoomScope)}
            aria-label="Scope conversations by room"
          >
            <option value="current">{roomName}</option>
            <option value="all">All rooms</option>
          </select>
        )}
      </div>
      {!loading && totalCount > 0 && (
        <div className="header-lede">
          You have {totalCount} conversation{totalCount === 1 ? "" : "s"}
        </div>
      )}

      <div className="header-controls">
        <div className="filter-pills">
          {FILTER_LABELS.map((fl) => {
            const isActive = !isSearching && activeFilter === fl.key;
            const indices = FILTER_GROUPS[fl.key];
            const count = indices.reduce((acc, idx) => acc + (groups[idx]?.items.length ?? 0), 0);
            // Hide non-"all" pills with zero matches once data has loaded.
            if (fl.key !== "all" && count === 0 && !loading) return null;
            return (
              <button
                key={fl.key}
                type="button"
                className={`filter-pill${isActive ? " active" : ""}`}
                onClick={() => onSelectFilter(fl.key)}
              >
                {fl.label}
                {!loading && count > 0 && <span className="filter-pill-count"> {count}</span>}
              </button>
            );
          })}
        </div>

        <div className="search-wrap">
          <input
            type="text"
            className="search-input"
            placeholder="Search…"
            value={searchQuery}
            onChange={(e) => onSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (searchQuery.trim()) onSearchSubmit();
              } else if (e.key === "Escape") {
                onClearSearch();
              }
            }}
          />
          <button
            type="button"
            className={`search-clear${hasQuery ? " visible" : ""}`}
            title="Clear search"
            onClick={onClearSearch}
          >
            ×
          </button>
        </div>
      </div>
    </div>
  );
}
