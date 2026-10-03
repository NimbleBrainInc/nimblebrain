import { useApp, useFileUpload } from "@nimblebrain/synapse/react";
import { useCallback, useState } from "react";
import { errorText } from "./Dialogs";
import { ROOT } from "./types";
import { readUploadRefusal, type UploadRefusal } from "./upload";

const NOTICE_MS = 4000;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The writes the browser makes, each followed by `reload`. Files and folders
 * are told apart by id prefix (`fl_`, `fd_`), so a selection can mix them.
 */
export function useFileActions(reload: () => void) {
  const app = useApp();
  const { pickFiles } = useFileUpload();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<UploadRefusal | null>(null);
  const [busy, setBusy] = useState<"upload" | "delete" | null>(null);

  const call = useCallback(
    async <T>(tool: string, args: Record<string, unknown>): Promise<T> => {
      const res = await app.callTool<T>(tool, args);
      if (res.isError) throw new Error(errorText(res.data));
      return res.data;
    },
    [app],
  );

  const flash = useCallback((message: string) => {
    setNotice(message);
    setTimeout(() => setNotice((n) => (n === message ? null : n)), NOTICE_MS);
  }, []);

  const move = useCallback(
    async (ids: string[], target: string) => {
      const fileIds = ids.filter((id) => id.startsWith("fl_"));
      if (fileIds.length > 0) await call("move", { ids: fileIds, folderId: target });
      for (const id of ids.filter((x) => x.startsWith("fd_"))) {
        await call("update_folder", { id, manifest: { parentId: target } });
      }
      flash(`Moved ${plural(ids.length, "item")}`);
      reload();
    },
    [call, flash, reload],
  );

  /** Delete after confirming. A folder that is not empty is refused, and the refusal shown. */
  const remove = useCallback(
    async (ids: string[], label: string): Promise<boolean> => {
      if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return false;
      setError(null);
      setBusy("delete");
      const refused = await deleteEach(call, ids);
      setBusy(null);
      if (refused.length > 0) setError(refused.join(" "));
      else flash(`Deleted ${label}`);
      reload();
      return refused.length === 0;
    },
    [call, flash, reload],
  );

  const createFolder = useCallback(
    async (name: string, parentId: string) => {
      await call("create_folder", {
        manifest: { name, ...(parentId === ROOT ? {} : { parentId }) },
      });
      reload();
    },
    [call, reload],
  );

  const renameFolder = useCallback(
    async (id: string, name: string) => {
      await call("update_folder", { id, manifest: { name } });
      reload();
    },
    [call, reload],
  );

  /**
   * The host stores each pick at the top level; picks made inside a folder are
   * then moved into it, so an upload lands where the reader is.
   */
  const upload = useCallback(
    async (folderId: string) => {
      setBusy("upload");
      setError(null);
      setRefusal(null);
      const picked = await pick(() => pickFiles({ multiple: true }));
      setRefusal(picked.refusal);
      setError(picked.error);
      const storedIds = picked.storedIds;
      try {
        if (storedIds.length === 0) return;
        if (folderId !== ROOT) await call("move", { ids: storedIds, folderId });
        reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [pickFiles, call, reload],
  );

  return {
    call,
    move,
    remove,
    createFolder,
    renameFolder,
    upload,
    notice,
    error,
    setError,
    refusal,
    clearRefusal: () => setRefusal(null),
    uploading: busy === "upload",
    deleting: busy === "delete",
  };
}

/** Delete each item, files and folders alike; returns the refusals, one per item refused. */
async function deleteEach(
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
  ids: string[],
): Promise<string[]> {
  const refused: string[] = [];
  for (const id of ids) {
    try {
      await call(id.startsWith("fd_") ? "delete_folder" : "delete", { id });
    } catch (err) {
      refused.push(err instanceof Error ? err.message : String(err));
    }
  }
  return refused;
}

/**
 * Run the host's picker. A refusal still stores the files that passed, so their
 * ids come back with it, to be placed like any other upload.
 */
async function pick(picker: () => Promise<Array<{ id: string }>>): Promise<{
  storedIds: string[];
  refusal: UploadRefusal | null;
  error: string | null;
}> {
  try {
    return { storedIds: (await picker()).map((f) => f.id), refusal: null, error: null };
  } catch (err) {
    const refusal = readUploadRefusal(err);
    if (refusal) return { storedIds: refusal.storedIds, refusal, error: null };
    const error = err instanceof Error ? `Upload failed: ${err.message}` : "Upload failed";
    return { storedIds: [], refusal: null, error };
  }
}
