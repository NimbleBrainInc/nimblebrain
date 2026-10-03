import { useApp, useDataSync } from "@nimblebrain/synapse/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ListResult } from "./types";

/** Files fetched per page; the next page loads as the list's end scrolls into view. */
export const PAGE_SIZE = 100;

export interface FileListState {
  result: ListResult | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  loadMore: () => void;
  reload: () => void;
}

/**
 * One `files__list` query, paged. `params` is the whole query; a change to it
 * starts over at the first page. A response to a query that has since changed
 * is dropped, so fast typing never shows an older search's results.
 */
export function useFileList(params: Record<string, unknown>): FileListState {
  const app = useApp();
  const [result, setResult] = useState<ListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const key = JSON.stringify(params);
  const seq = useRef(0);
  const resultRef = useRef(result);
  resultRef.current = result;

  const fetchPage = useCallback(
    async (offset: number): Promise<ListResult> => {
      const res = await app.callTool<ListResult>("list", {
        ...JSON.parse(key),
        limit: PAGE_SIZE,
        offset,
      });
      if (res.isError) {
        const message = (res.data as unknown as { error?: string } | undefined)?.error;
        throw new Error(message ?? "Failed to load files");
      }
      return res.data;
    },
    [app, key],
  );

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      // Keep as many rows as were showing, so a refresh after a write does not
      // drop the reader back to the first page.
      const next = await fetchAtLeast(fetchPage, resultRef.current?.files.length ?? 0);
      if (mine === seq.current) setResult(next);
    } catch (err) {
      if (mine === seq.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [fetchPage]);

  // A new query starts from nothing, not from the last query's rows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the query; `reload` follows it
  useEffect(() => {
    resultRef.current = null;
    setResult(null);
    reload();
  }, [key]);

  useDataSync(() => {
    reload();
  });

  const loadMore = useCallback(async () => {
    const current = resultRef.current;
    if (!current || loadingMore || current.files.length >= current.total) return;
    const mine = seq.current;
    setLoadingMore(true);
    try {
      const next = await fetchPage(current.files.length);
      if (mine === seq.current) {
        setResult((prev) => (prev ? { ...prev, files: prev.files.concat(next.files) } : prev));
      }
    } catch (err) {
      if (mine === seq.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  }, [fetchPage, loadingMore]);

  return { result, loading, loadingMore, error, loadMore, reload };
}

/** The first page, then further pages until at least `shown` files are held or none are left. */
async function fetchAtLeast(
  fetchPage: (offset: number) => Promise<ListResult>,
  shown: number,
): Promise<ListResult> {
  const first = await fetchPage(0);
  let files = first.files;
  while (files.length < shown && files.length < first.total) {
    const next = await fetchPage(files.length);
    if (next.files.length === 0) break;
    files = files.concat(next.files);
  }
  return { ...first, files };
}
