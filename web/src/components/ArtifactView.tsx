// ---------------------------------------------------------------------------
// ArtifactView — inline render of an `artifact://` resource_link.
//
// The third leg of ToolWidgets, beside InlineAppView (ui://) and
// ResourceLinkView (everything else). It fetches the artifact through the host
// resolver (POST /v1/resources/read, which the host routes to the data plane
// and resolves as the viewing user — RLS enforced) and hands the bytes to the
// curated, sanitizing ArtifactRenderer registry, keyed by mime_type.
//
// It is GENERIC: no knowledge of any specific capability. Any tool that returns
// an `artifact://` reference gets a sanitized inline render for free.
// ---------------------------------------------------------------------------

import { Download, FileText, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiClientError, type ReadResourceContent, readResource } from "../api/client";
import { normalizeMime } from "../lib/artifact-kind";
import { ArtifactRenderer, rendererKindFor } from "./ArtifactRenderer";

export interface ArtifactViewProps {
  /** The `artifact://<id>` URI from the resource_link block. */
  uri: string;
  /** Producing server/app — passed through to the read endpoint for the
   *  envelope, though the host resolves artifact:// against the data plane (the
   *  bundle is never in the read path). */
  appName?: string;
  /** Optional display name from the resource_link block. */
  name?: string;
  /** Declared MIME type from the resource_link block. Falls back to the
   *  resolved resource's own mimeType. */
  mimeType?: string;
  /** Optional description surfaced to the user. */
  description?: string;
}

/** Decode a base64 string to a Uint8Array in a stack-safe loop. */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function defaultFilename(uri: string, name?: string): string {
  if (name) return name;
  const tail = uri.split("/").pop();
  return tail && tail.length > 0 ? tail : "artifact";
}

export function ArtifactView({ uri, appName, name, mimeType, description }: ArtifactViewProps) {
  const [content, setContent] = useState<ReadResourceContent | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;

    setLoading(true);
    setError(null);
    setContent(null);
    setObjectUrl(null);

    (async () => {
      try {
        // `appName` is irrelevant to artifact:// resolution (host-resolved), but
        // the read endpoint still expects a `server` field; pass a stable
        // placeholder when none was provided.
        const result = await readResource(appName ?? "artifact", uri);
        if (cancelled) return;
        const first = result.contents[0];
        if (!first) throw new Error("No content returned");
        setContent(first);
        // Build an object URL for binary bodies / the download fallback.
        if (first.blob !== undefined) {
          const bytes = base64ToBytes(first.blob);
          const blob = new Blob([bytes.buffer as ArrayBuffer], {
            type: first.mimeType ?? mimeType ?? "application/octet-stream",
          });
          createdUrl = URL.createObjectURL(blob);
          setObjectUrl(createdUrl);
        }
      } catch (err) {
        if (cancelled) return;
        const msg =
          err instanceof ApiClientError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Failed to load artifact";
        setError(msg);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [uri, appName, mimeType]);

  const displayName = name ?? uri;
  const resolvedMime = content?.mimeType ?? mimeType;

  if (loading) {
    return (
      <div className="w-full my-2 rounded-lg border border-border bg-card p-3 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 text-processing animate-spin" />
        Loading {displayName}...
      </div>
    );
  }

  if (error || !content) {
    return (
      <div className="w-full my-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
        Failed to load {displayName}: {error ?? "unknown error"}
      </div>
    );
  }

  // The renderer registry decides how to draw the bytes. A text body flows in
  // as `text`; a binary body (blob) flows to the download fallback via
  // `objectUrl` (and `text: null`). Either way the registry never errors on an
  // unsupported type.
  const kind = rendererKindFor(resolvedMime);
  const isRenderable = kind !== "unsupported" && content.text !== undefined;

  const header = (
    <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-muted/20 text-xs">
      <div className="flex items-center gap-2 min-w-0">
        <FileText className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{displayName}</span>
        {resolvedMime && (
          <span className="text-muted-foreground tabular-nums shrink-0">
            {normalizeMime(resolvedMime)}
          </span>
        )}
      </div>
      {objectUrl && (
        <a
          href={objectUrl}
          download={defaultFilename(uri, name)}
          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
          aria-label={`Download ${displayName}`}
        >
          <Download className="w-3.5 h-3.5" />
        </a>
      )}
    </div>
  );

  return (
    <div className="w-full my-2 rounded-lg border border-border bg-card overflow-hidden">
      {header}
      <div className="p-3 max-h-[32rem] overflow-y-auto">
        <ArtifactRenderer
          mimeType={resolvedMime}
          text={isRenderable ? (content.text ?? null) : null}
          objectUrl={objectUrl}
          downloadName={defaultFilename(uri, name)}
          title={name ?? displayName}
        />
      </div>
      {description && (
        <div className="px-3 py-2 text-xs text-muted-foreground border-t border-border">
          {description}
        </div>
      )}
    </div>
  );
}
