import { useCallback, useEffect, useMemo, useState } from "react";
import { type Since, SOURCE_FILTERS, sinceToIso } from "./format";
import { type FileKind, ROOT, type SortField, type SortOrder } from "./types";

const SEARCH_DEBOUNCE_MS = 250;

/**
 * Where the reader is and what they asked for, and the `files__list` query
 * that answers it. Searching or filtering gathers files from the folder and
 * everything below it (or from everywhere, once the scope is lifted);
 * otherwise the view is one folder's contents.
 */
export function useBrowseState() {
  const [folderId, setFolderId] = useState<string>(ROOT);
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [scoped, setScoped] = useState(true);
  const [kinds, setKinds] = useState<FileKind[]>([]);
  const [sourceKey, setSourceKey] = useState<string | null>(null);
  const [since, setSince] = useState<Since>("any");
  const [sort, setSort] = useState<SortField>("createdAt");
  const [order, setOrder] = useState<SortOrder>("desc");

  useEffect(() => {
    const t = setTimeout(() => setQuery(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput]);

  const hasFilter = kinds.length > 0 || sourceKey !== null || since !== "any";
  const searching = query !== "" || hasFilter;
  const inFolder = folderId !== ROOT;

  const params = useMemo(
    () => buildParams({ folderId, query, scoped, kinds, sourceKey, since, sort, order, searching }),
    [folderId, query, scoped, kinds, sourceKey, since, sort, order, searching],
  );

  const clearFilters = useCallback(() => {
    setKinds([]);
    setSourceKey(null);
    setSince("any");
  }, []);

  /** Go to a folder, leaving any search or filter behind. */
  const openFolder = useCallback(
    (id: string) => {
      setFolderId(id);
      setSearchInput("");
      setQuery("");
      setScoped(true);
      clearFilters();
    },
    [clearFilters],
  );

  const toggleKind = useCallback((k: FileKind) => {
    setKinds((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));
  }, []);

  const toggleSource = useCallback((key: string) => {
    setSourceKey((cur) => (cur === key ? null : key));
  }, []);

  /** A column header: the same field flips direction; a new one starts at its natural one. */
  const sortBy = useCallback(
    (field: SortField) => {
      if (field === sort) {
        setOrder((o) => (o === "asc" ? "desc" : "asc"));
        return;
      }
      setSort(field);
      setOrder(field === "filename" ? "asc" : "desc");
    },
    [sort],
  );

  return {
    folderId,
    setFolderId,
    searchInput,
    setSearchInput,
    query,
    scoped,
    setScoped,
    kinds,
    toggleKind,
    sourceKey,
    toggleSource,
    since,
    setSince,
    sort,
    order,
    sortBy,
    hasFilter,
    searching,
    inFolder,
    params,
    openFolder,
    clearFilters,
  };
}

function buildParams(s: {
  folderId: string;
  query: string;
  scoped: boolean;
  kinds: FileKind[];
  sourceKey: string | null;
  since: Since;
  sort: SortField;
  order: SortOrder;
  searching: boolean;
}): Record<string, unknown> {
  const p: Record<string, unknown> = { sort: s.sort, order: s.order };
  if (!s.searching) p.folderId = s.folderId;
  else if (s.folderId !== ROOT && s.scoped)
    Object.assign(p, { folderId: s.folderId, recursive: true });
  if (s.query) p.query = s.query;
  if (s.kinds.length > 0) p.kinds = s.kinds;
  const source = SOURCE_FILTERS.find((f) => f.key === s.sourceKey);
  if (source) p.sources = source.sources;
  const after = sinceToIso(s.since);
  if (after) p.createdAfter = after;
  return p;
}
