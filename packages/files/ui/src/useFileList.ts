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
 * One `list` query, a page at a time. `params` is the whole query; a change to
 * it goes back to the first page. A response to a query or page that has since
 * changed is dropped, so fast typing never shows an older search.
 *
 * `list` pages by an opaque cursor, so the cursor that opens each page is kept
 * as pages are read: going back reuses one, and a jump past the last page read
 * follows the cursors from there.
 */
export function useFileList(params: Record<string, unknown>): FileListState {
  const app = useApp();
  const [result, setResult] = useState<ListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const key = JSON.stringify(params);
  const seq = useRef(0);
  /** The cursor that opens each page read so far of the query `key`; page 0 has none. */
  const cursors = useRef<{ key: string; at: Array<string | undefined> }>({ key, at: [undefined] });
  if (cursors.current.key !== key) cursors.current = { key, at: [undefined] };

  // A new query starts at its first page. Reset while rendering, so the first
  // read of the new query already asks for page 0.
  const [shownKey, setShownKey] = useState(key);
  if (shownKey !== key) {
    setShownKey(key);
    setPage(0);
    setResult(null);
  }

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchPage(app, key, page, cursors.current.at);
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

/** One `list` call; rejects with the tool's error. */
async function listCall(app: App, args: Record<string, unknown>): Promise<ListResult> {
  const res = await app.callTool<ListResult>("list", args);
  if (res.isError) {
    // `callTool<ListResult>` types `data` as `ListResult` whether or not the call
    // failed; a failed `list` carries `{ code, error }` there instead.
    const message = (res.data as { error?: string } | undefined)?.error;
    throw new Error(message ?? "Failed to load files");
  }
  return res.data;
}

/**
 * Page `page` of the query `key` names, following `cursors` (each page's opening
 * cursor, filled in as pages are read) from the nearest page already reached.
 * A page past the end answers the last page there is.
 */
export async function fetchPage(
  app: App,
  key: string,
  page: number,
  cursors: Array<string | undefined>,
): Promise<ListResult> {
  const query = JSON.parse(key) as Record<string, unknown>;
  let at = Math.min(page, cursors.length - 1);
  for (;;) {
    const cursor = cursors[at];
    const data = await listCall(app, { ...query, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
    if (data.nextCursor) cursors[at + 1] = data.nextCursor;
    if (at >= page || !data.nextCursor) return data;
    at++;
  }
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
