import { useDataSync, useFileUpload, useHostContext, useSynapse } from "@nimblebrain/synapse/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DetailOverlay } from "./DetailOverlay";
import { FileGrid } from "./FileGrid";
import { collectTags, TYPE_FILTERS } from "./format";
import { Header } from "./Header";
import type { FileEntry, FilterKey, ListResult } from "./types";

const SEARCH_DEBOUNCE_MS = 300;

export function Dashboard() {
  const synapse = useSynapse();
  const { pickFiles } = useFileUpload();
  // The workspace the shell is focused on — the list scopes to it. Pushed by
  // the host via hostContext.
  const { workspace } = useHostContext<{
    workspace?: { id: string; name: string; isPersonal?: boolean };
  }>();
  // Primitives (not the workspace object, whose identity churns per push) so
  // `loadFiles` only re-runs when the workspace actually changes.
  const workspaceId = workspace?.id;
  const workspaceIsPersonal = workspace?.isPersonal === true;

  const [files, setFiles] = useState<FileEntry[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [activeFilter, setActiveFilter] = useState<FilterKey>("all");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detailFile, setDetailFile] = useState<FileEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [uploading, setUploading] = useState(false);

  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The list tool is identity-owned — it returns every file the user owns,
      // across all workspaces — so scope it to the workspace we're in. Legacy
      // files with no stamped workspace belong to the personal workspace.
      const args: { limit: number; workspaceId?: string; includeUnstamped?: boolean } = {
        limit: 200,
      };
      if (workspaceId) {
        args.workspaceId = workspaceId;
        if (workspaceIsPersonal) args.includeUnstamped = true;
      }
      const result = await synapse.callTool<typeof args, ListResult>("list", args);
      if (result.isError) {
        setError("Failed to load files");
        return;
      }
      setFiles(result.data.files || []);
      setTotalCount(result.data.totalCount || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load files");
    } finally {
      setLoading(false);
    }
  }, [synapse, workspaceId, workspaceIsPersonal]);

  const searchFiles = useCallback(
    async (query: string) => {
      setLoading(true);
      setError(null);
      try {
        const result = await synapse.callTool<{ query: string; limit: number }, ListResult>(
          "search",
          { query, limit: 100 },
        );
        if (result.isError) {
          setError("Search failed");
          return;
        }
        setFiles(result.data.files || []);
        setTotalCount(result.data.totalCount || 0);
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
    loadFiles();
  }, [loadFiles]);

  // Refresh on data-changed broadcasts (uploads from elsewhere, deletes, etc.)
  useDataSync(() => {
    if (searchQuery.trim()) {
      searchFiles(searchQuery.trim());
    } else {
      loadFiles();
    }
  });

  const handleSearchInput = useCallback(
    (value: string) => {
      setSearchQuery(value);
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      if (!value.trim()) {
        loadFiles();
        return;
      }
      searchTimerRef.current = setTimeout(() => {
        searchFiles(value.trim());
      }, SEARCH_DEBOUNCE_MS);
    },
    [loadFiles, searchFiles],
  );

  const handleClearSearch = useCallback(() => {
    setSearchQuery("");
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    loadFiles();
  }, [loadFiles]);

  const handleUpload = useCallback(async () => {
    setUploading(true);
    setError(null);
    try {
      const result = await pickFiles({ multiple: true, maxSize: 26214400 });
      // pickFiles returns [] if the user cancelled, or the persisted FileEntry
      // records if upload succeeded. The host's POST /v1/resources path
      // already wrote them; we just need to refresh.
      if (result.length > 0) await loadFiles();
    } catch (err) {
      setError(err instanceof Error ? `Upload failed: ${err.message}` : "Upload failed");
    } finally {
      setUploading(false);
    }
  }, [pickFiles, loadFiles]);

  const handleDelete = useCallback(async () => {
    if (!detailFile || deleting) return;
    if (!window.confirm(`Delete ${detailFile.filename}? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      const result = await synapse.callTool<{ id: string }, { ok: boolean }>("delete", {
        id: detailFile.id,
      });
      if (result.isError) {
        setError("Failed to delete file");
        return;
      }
      setDetailFile(null);
      await loadFiles();
    } catch (err) {
      setError(err instanceof Error ? `Delete failed: ${err.message}` : "Delete failed");
    } finally {
      setDeleting(false);
    }
  }, [detailFile, deleting, synapse, loadFiles]);

  // Compose the visible file list = type filter ∩ tag filter.
  const visibleFiles = useMemo(() => {
    if (loading) return [];
    const typeMatch = TYPE_FILTERS.find((tf) => tf.key === activeFilter)?.match ?? (() => true);
    let result = files.filter(typeMatch);
    if (activeTag) result = result.filter((f) => f.tags?.includes(activeTag));
    return result;
  }, [loading, files, activeFilter, activeTag]);

  const tags = useMemo(() => (loading ? [] : collectTags(files)), [loading, files]);
  const hasFilter = activeFilter !== "all" || activeTag !== null;

  return (
    <>
      <Header
        totalCount={totalCount}
        loading={loading}
        files={files}
        activeFilter={activeFilter}
        activeTag={activeTag}
        searchQuery={searchQuery}
        uploading={uploading}
        tags={tags}
        onSelectFilter={setActiveFilter}
        onToggleTag={(tag) => setActiveTag((current) => (current === tag ? null : tag))}
        onSearchInput={handleSearchInput}
        onClearSearch={handleClearSearch}
        onUpload={handleUpload}
      />

      <div className="content">
        {error && <div className="error-banner">{error}</div>}
        <FileGrid
          loading={loading}
          files={visibleFiles}
          searchQuery={searchQuery}
          hasFilter={hasFilter}
          onSelect={setDetailFile}
        />
      </div>

      {detailFile && (
        <DetailOverlay
          file={detailFile}
          deleting={deleting}
          onClose={() => setDetailFile(null)}
          onDelete={handleDelete}
        />
      )}
    </>
  );
}
