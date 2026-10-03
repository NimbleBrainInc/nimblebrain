import { useEffect, useRef } from "react";
import { KIND_FILTERS, SINCE_FILTERS, type Since, SOURCE_FILTERS } from "./format";
import { FolderPlusIcon, UploadIcon } from "./icons";
import type { Crumb, FileKind, ListResult } from "./types";

interface Props {
  /** The view's own title and breadcrumb, for a host that shows neither. */
  showTrail: boolean;
  breadcrumb: Crumb[];
  onOpenFolder: (id: string) => void;

  searchInput: string;
  onSearchInput: (value: string) => void;
  /** The folder a search is held to, or `null` at the top level. */
  scopeName: string | null;
  scoped: boolean;
  onToggleScope: () => void;

  kinds: FileKind[];
  onToggleKind: (kind: FileKind) => void;
  sourceKey: string | null;
  onToggleSource: (key: string) => void;
  since: Since;
  onSelectSince: (since: Since) => void;
  facets: ListResult["facets"] | null;
  hasFilter: boolean;
  onClearFilters: () => void;

  uploading: boolean;
  uploadHint: string | null;
  onUpload: () => void;
  onNewFolder: () => void;
}

export function Toolbar(props: Props) {
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" focuses search from anywhere in the view, as in most file browsers.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing = target?.closest("input, textarea, [contenteditable]");
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const { facets } = props;

  return (
    <div className="toolbar">
      {props.showTrail && (
        <nav className="own-trail" aria-label="Folder">
          <button type="button" className="crumb" onClick={() => props.onOpenFolder("root")}>
            Files
          </button>
          {props.breadcrumb.map((c) => (
            <span key={c.id} className="crumb-step">
              <span className="crumb-sep">/</span>
              <button type="button" className="crumb" onClick={() => props.onOpenFolder(c.id)}>
                {c.name}
              </button>
            </span>
          ))}
        </nav>
      )}

      <div className="toolbar-row">
        <div className="search-wrap">
          <input
            ref={searchRef}
            type="search"
            className="search-input"
            placeholder="Search files and folders"
            aria-label="Search files and folders"
            value={props.searchInput}
            onChange={(e) => props.onSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                props.onSearchInput("");
                e.currentTarget.blur();
              }
            }}
          />
          {props.scopeName !== null && (props.searchInput || props.hasFilter) && (
            <button
              type="button"
              className={`scope-chip${props.scoped ? " active" : ""}`}
              onClick={props.onToggleScope}
              title={
                props.scoped ? "Search everywhere instead" : `Search only in ${props.scopeName}`
              }
            >
              {props.scoped ? `In ${props.scopeName} ×` : `Only in ${props.scopeName}`}
            </button>
          )}
        </div>

        <div className="toolbar-actions">
          <button type="button" className="btn-ghost" onClick={props.onNewFolder}>
            <FolderPlusIcon />
            New folder
          </button>
          <button
            type="button"
            className="upload-btn"
            disabled={props.uploading}
            onClick={props.onUpload}
            title={
              props.uploadHint ? `Upload files (${props.uploadHint.toLowerCase()})` : "Upload files"
            }
          >
            <UploadIcon />
            {props.uploading ? "Uploading…" : "Upload"}
          </button>
        </div>
      </div>

      <div className="filter-row">
        {KIND_FILTERS.map((k) => {
          const count = facets?.kinds[k.key] ?? 0;
          const active = props.kinds.includes(k.key);
          if (!active && count === 0) return null;
          return (
            <button
              key={k.key}
              type="button"
              className={`filter-pill${active ? " active" : ""}`}
              aria-pressed={active}
              onClick={() => props.onToggleKind(k.key)}
            >
              {k.label}
              <span className="filter-pill-count"> {count}</span>
            </button>
          );
        })}
        <span className="filter-sep" aria-hidden />
        {SOURCE_FILTERS.map((s) => {
          const count = s.sources.reduce((n, src) => n + (facets?.sources[src] ?? 0), 0);
          const active = props.sourceKey === s.key;
          if (!active && count === 0) return null;
          return (
            <button
              key={s.key}
              type="button"
              className={`filter-pill${active ? " active" : ""}`}
              aria-pressed={active}
              onClick={() => props.onToggleSource(s.key)}
            >
              {s.label}
              <span className="filter-pill-count"> {count}</span>
            </button>
          );
        })}
        <span className="filter-sep" aria-hidden />
        {SINCE_FILTERS.map((s) => {
          const active = props.since === s.key;
          return (
            <button
              key={s.key}
              type="button"
              className={`filter-pill${active ? " active" : ""}`}
              aria-pressed={active}
              onClick={() => props.onSelectSince(active ? "any" : s.key)}
            >
              {s.label}
            </button>
          );
        })}
        {props.hasFilter && (
          <button type="button" className="filter-clear" onClick={props.onClearFilters}>
            Clear filters
          </button>
        )}
      </div>
      {props.uploadHint && <div className="upload-hint">{props.uploadHint}</div>}
    </div>
  );
}
