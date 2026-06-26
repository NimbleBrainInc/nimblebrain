import { TYPE_FILTERS } from "./format";
import { UploadIcon } from "./icons";
import type { FileEntry, FilterKey, RoomScope, TagCount } from "./types";

interface Props {
  totalCount: number;
  loading: boolean;
  files: FileEntry[];
  activeFilter: FilterKey;
  activeTag: string | null;
  searchQuery: string;
  uploading: boolean;
  tags: TagCount[];
  /** Display name of the focused room; absent until the host handshake lands. */
  roomName?: string;
  roomScope: RoomScope;
  onSelectRoomScope: (scope: RoomScope) => void;
  onSelectFilter: (key: FilterKey) => void;
  onToggleTag: (tag: string) => void;
  onSearchInput: (value: string) => void;
  onClearSearch: () => void;
  onUpload: () => void;
}

export function Header({
  totalCount,
  loading,
  files,
  activeFilter,
  activeTag,
  searchQuery,
  uploading,
  tags,
  roomName,
  roomScope,
  onSelectRoomScope,
  onSelectFilter,
  onToggleTag,
  onSearchInput,
  onClearSearch,
  onUpload,
}: Props) {
  // For pill counts, scope to the tag-filtered set so the numbers reflect
  // what the user would see if they clicked. Mirrors the original logic.
  const baseFiles = activeTag ? files.filter((f) => f.tags?.includes(activeTag)) : files;

  const hasQuery = searchQuery.length > 0;

  return (
    <>
      <div className="header">
        <div className="header-top">
          <div className="header-top-left">
            <div>
              <div className="header-title">Files</div>
              {!loading && totalCount > 0 && (
                <div className="header-lede">
                  {totalCount} file{totalCount === 1 ? "" : "s"}
                </div>
              )}
            </div>
            {roomName && (
              <select
                className="room-select"
                value={roomScope}
                onChange={(e) => onSelectRoomScope(e.target.value as RoomScope)}
                aria-label="Scope files by room"
              >
                <option value="current">{roomName}</option>
                <option value="all">All rooms</option>
              </select>
            )}
          </div>
          <button
            type="button"
            className="upload-btn"
            disabled={uploading}
            onClick={onUpload}
            title="Upload files"
          >
            <UploadIcon />
            {uploading ? "Uploading…" : "Upload"}
          </button>
        </div>

        <div className="header-controls">
          <div className="filter-pills">
            {TYPE_FILTERS.map((tf) => {
              const isActive = activeFilter === tf.key;
              const count = loading ? 0 : baseFiles.filter(tf.match).length;
              if (tf.key !== "all" && count === 0 && !loading) return null;
              return (
                <button
                  key={tf.key}
                  type="button"
                  className={`filter-pill${isActive ? " active" : ""}`}
                  onClick={() => onSelectFilter(tf.key)}
                >
                  {tf.label}
                  {!loading && count > 0 && <span className="filter-pill-count"> {count}</span>}
                </button>
              );
            })}
          </div>

          <div className="search-wrap">
            <input
              type="text"
              className="search-input"
              placeholder="Search files…"
              value={searchQuery}
              onChange={(e) => onSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") onClearSearch();
              }}
            />
            <button
              type="button"
              className={`search-clear${hasQuery ? " visible" : ""}`}
              title="Clear"
              onClick={onClearSearch}
            >
              ×
            </button>
          </div>
        </div>
      </div>

      {tags.length > 0 && !loading && (
        <div className="tag-bar">
          {tags.slice(0, 20).map((t) => (
            <button
              key={t.tag}
              type="button"
              className={`tag-chip${activeTag === t.tag ? " active" : ""}`}
              onClick={() => onToggleTag(t.tag)}
            >
              {t.tag}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
