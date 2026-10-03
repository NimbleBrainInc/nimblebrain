import type { App } from "@nimblebrain/synapse";
import { useApp, useDataSync } from "@nimblebrain/synapse/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ListResult } from "./types";

/** Files shown per page. */
export const PAGE_SIZE = 50;

export interface FileListState {
  result: ListResult | null;
  loading: boolean;
  error: string | null;
  /** The page shown, from 0. */
  page: number;
  pageCount: number;
  setPage: (page: number) => void;
  reload: () => void;
}

/**
 * One `files__list` query, a page at a time. `params` is the whole query; a
 * change to it goes back to the first page. A response to a query or page that
 * has since changed is dropped, so fast typing never shows an older search.
 */
export function useFileList(params: Record<string, unknown>): FileListState {
  const app = useApp();
  const [result, setResult] = useState<ListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const key = JSON.stringify(params);
  const seq = useRef(0);

  // A new query starts at its first page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the trigger
  useEffect(() => {
    setPage(0);
    setResult(null);
  }, [key]);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchPage(app, key, page);
      if (mine !== seq.current) return;
      // A write can leave the page past the end (the last files on it deleted);
      // step back to the last page that has any.
      const last = Math.max(0, Math.ceil(data.total / PAGE_SIZE) - 1);
      if (page > last) setPage(last);
      else setResult(data);
    } catch (err) {
      if (mine === seq.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [app, key, page]);

  useEffect(() => {
    reload();
  }, [reload]);

  useDataSync(() => {
    reload();
  });

  const pageCount = result ? Math.max(1, Math.ceil(result.total / PAGE_SIZE)) : 1;
  return { result, loading, error, page, pageCount, setPage, reload };
}

/** One page of the query `key` names; rejects with the tool's error. */
async function fetchPage(app: App, key: string, page: number): Promise<ListResult> {
  const res = await app.callTool<ListResult>("list", {
    ...JSON.parse(key),
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });
  if (res.isError) {
    const message = (res.data as unknown as { error?: string } | undefined)?.error;
    throw new Error(message ?? "Failed to load files");
  }
  return res.data;
}

/**
 * The kind and source counts for `params` alone, for the chips while the view
 * is a plain folder listing: choosing a chip searches the folder and everything
 * below it, so its count must describe that, not the folder's own files.
 * `null` asks for nothing.
 */
export function useFacets(params: Record<string, unknown> | null): ListResult["facets"] | null {
  const app = useApp();
  const [facets, setFacets] = useState<ListResult["facets"] | null>(null);
  const key = params === null ? null : JSON.stringify(params);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (key === null) return;
    const mine = ++seq.current;
    const res = await app.callTool<ListResult>("list", { ...JSON.parse(key), limit: 1 });
    if (mine === seq.current && !res.isError) setFacets(res.data.facets);
  }, [app, key]);

  useEffect(() => {
    load();
  }, [load]);
  useDataSync(() => {
    load();
  });

  return key === null ? null : facets;
}
