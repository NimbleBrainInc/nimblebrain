import type { Synapse } from "@nimblebrain/synapse";
import { useSynapse } from "@nimblebrain/synapse/react";
import { useCallback, useEffect, useState } from "react";

export type FileUrlState = "idle" | "loading" | "loaded" | "error";

/**
 * Read a stored file's bytes through the Synapse bridge (`resources/read`
 * on `files://<id>`) and return them as a Blob.
 *
 * The bridge is the right path — not `/v1/files/:id` directly. The app
 * runs in a sandboxed `srcdoc` iframe: a bare `<img>`/fetch GET carries no
 * auth token (so it 401s under bearer auth), and the iframe CSP only
 * permits `data:`/`blob:`/`https:` sources, never the `http:` host origin
 * in dev. The bridge already holds the authenticated MCP session.
 */
export async function fetchFileBlob(
  synapse: Synapse,
  fileId: string,
  mimeType: string | undefined,
): Promise<Blob> {
  const result = await synapse.readResource(`files://${fileId}`);
  const part = result.contents?.[0];
  // Binary resources arrive as base64 in `blob`; text resources as `text`.
  if (part && "blob" in part && typeof part.blob === "string") {
    return new Blob([base64ToBytes(part.blob)], {
      type: mimeType || "application/octet-stream",
    });
  }
  if (part && "text" in part && typeof part.text === "string") {
    return new Blob([part.text], { type: mimeType || "text/plain" });
  }
  throw new Error("file resource has no readable contents");
}

/**
 * Resolve a stored file into a `blob:` object URL usable as an `<img>`
 * src. A `blob:` URL is CSP-clean inside the sandboxed iframe.
 *
 * Pass `enabled=false` to defer the fetch (e.g. off-screen thumbnails).
 * The object URL is revoked on unmount and whenever the file id changes.
 */
export function useFileObjectUrl(
  fileId: string,
  mimeType: string | undefined,
  enabled: boolean,
): { url: string | null; state: FileUrlState } {
  const synapse = useSynapse();
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<FileUrlState>("idle");

  useEffect(() => {
    if (!enabled) {
      setState("idle");
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    setState("loading");

    (async () => {
      try {
        const blob = await fetchFileBlob(synapse, fileId, mimeType);
        objectUrl = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        setUrl(objectUrl);
        setState("loaded");
      } catch {
        if (!cancelled) setState("error");
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [synapse, fileId, mimeType, enabled]);

  return { url, state };
}

/**
 * Returns a callback that downloads a file to the user's machine. Fetches
 * the bytes through the bridge, then triggers a same-document anchor
 * download from a `blob:` URL. Requires the host iframe sandbox to carry
 * `allow-downloads` (see `web/src/bridge/iframe.ts`).
 */
export function useFileDownload(): (file: {
  id: string;
  filename: string;
  mimeType?: string;
}) => Promise<void> {
  const synapse = useSynapse();
  return useCallback(
    async (file) => {
      const blob = await fetchFileBlob(synapse, file.id, file.mimeType);
      const objectUrl = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = file.filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    },
    [synapse],
  );
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
