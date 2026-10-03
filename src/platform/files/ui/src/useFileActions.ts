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
  const { pickFiles, uploadFiles } = useFileUpload();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
      try {
        const fileIds = ids.filter((id) => id.startsWith("fl_"));
        if (fileIds.length > 0) await call("move", { ids: fileIds, folderId: target });
        for (const id of ids.filter((x) => x.startsWith("fd_"))) {
          await call("update_folder", { id, manifest: { parentId: target } });
        }
        flash(`Moved ${plural(ids.length, "item")}`);
      } finally {
        // A move that fails part way has still moved what came before it.
        reload();
      }
    },
    [call, flash, reload],
  );

  /**
   * Delete files and folders, once the reader has confirmed. A folder that is
   * not empty is refused, and the refusal shown.
   */
  const remove = useCallback(
    async (ids: string[], label: string): Promise<boolean> => {
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
   * Store files, picked (`files` omitted) or already held (dropped), in a
   * folder. The host stores each at the top level; they are then moved into the
   * folder, so an upload lands where the reader is. The outcome says how many
   * were stored and, when any were refused, why, for the upload dialog to show.
   */
  const upload = useCallback(
    async (folderId: string, files?: readonly File[]): Promise<UploadOutcome> => {
      setBusy("upload");
      const sent = await send(() => (files ? uploadFiles(files) : pickFiles({ multiple: true })));
      try {
        if (sent.storedIds.length > 0 && folderId !== ROOT) {
          await call("move", { ids: sent.storedIds, folderId });
        }
        return sent;
      } catch (err) {
        // The files were stored but the move failed: they sit at the top level.
        const reason = err instanceof Error ? err.message : String(err);
        return {
          ...sent,
          error: `${plural(sent.storedIds.length, "file")} uploaded to the top level, not moved here: ${reason}`,
        };
      } finally {
        if (sent.storedIds.length > 0) reload();
        setBusy(null);
      }
    },
    [pickFiles, uploadFiles, call, reload],
  );

  return {
    call,
    flash,
    move,
    remove,
    createFolder,
    renameFolder,
    upload,
    notice,
    error,
    setError,
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

/** What an upload did: the files stored, and why any others were not. */
export interface UploadOutcome {
  storedIds: string[];
  refusal: UploadRefusal | null;
  error: string | null;
}

/**
 * Hand files to the host, picked or held. A refusal still stores the files that
 * passed, so their ids come back with it, to be placed like any other upload.
 */
async function send(upload: () => Promise<Array<{ id: string }>>): Promise<UploadOutcome> {
  try {
    return { storedIds: (await upload()).map((f) => f.id), refusal: null, error: null };
  } catch (err) {
    const refusal = readUploadRefusal(err);
    if (refusal) return { storedIds: refusal.storedIds, refusal, error: null };
    const error = err instanceof Error ? `Upload failed: ${err.message}` : "Upload failed";
    return { storedIds: [], refusal: null, error };
  }
}
