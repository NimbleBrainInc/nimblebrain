import { Download, FileText, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiClientError, readResource, type ReadResourceContent } from "../api/client";

export interface ResourceLinkViewProps {
  /** URI from the resource_link content block (e.g., `collateral://exports/exp_abc.pdf`). */
  uri: string;
  /** Server/app that owns the resource — forwarded to POST /v1/resources/read. */
  appName: string;
  /** Optional display name from the resource_link block. */
  name?: string;
  /** Declared MIME type from the resource_link block. Falls back to the resource's own mimeType. */
  mimeType?: string;
  /** Optional description surfaced to the user. */
  description?: string;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** Decode a base64 string to a Uint8Array in chunks (stack-safe for large blobs). */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function defaultFilename(uri: string, name?: string): string {
  if (name) return name;
  const tail = uri.split("/").pop();
  return tail && tail.length > 0 ? tail : "download";
}

export function ResourceLinkView({
  uri,
  appName,
  name,
  mimeType,
  description,
}: ResourceLinkViewProps) {
  const [content, setContent] = useState<ReadResourceContent | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [byteSize, setByteSize] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;

    setLoading(true);
    setError(null);
    setContent(null);
    setObjectUrl(null);
    setByteSize(null);

    (async () => {
      try {
        const result = await readResource(appName, uri);
        if (cancelled) return;
        const first = result.contents[0];
        if (!first) throw new Error("No content returned");
        setContent(first);
        if (first.blob !== undefined) {
          const bytes = base64ToBytes(first.blob);
          const blob = new Blob([bytes.buffer as ArrayBuffer], {
            type: first.mimeType ?? mimeType ?? "application/octet-stream",
          });
          createdUrl = URL.createObjectURL(blob);
          setObjectUrl(createdUrl);
          setByteSize(bytes.byteLength);
        }
      } catch (err) {
        if (cancelled) return;
        const msg =
          err instanceof ApiClientError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Failed to load resource";
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
  const resolvedMime = content?.mimeType ?? mimeType ?? "application/octet-stream";

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
      <div className="w-full my-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        Failed to load {displayName}: {error ?? "unknown error"}
      </div>
    );
  }

  const header = (
    <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-muted/30 text-xs">
      <div className="flex items-center gap-2 min-w-0">
        <FileText className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{displayName}</span>
        {byteSize !== null && (
          <span className="text-muted-foreground tabular-nums shrink-0">
            {formatBytes(byteSize)}
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

  if (resolvedMime === "application/pdf" && objectUrl) {
    return (
      <div className="w-full my-2 rounded-lg border border-border bg-card overflow-hidden">
        {header}
        {/* sandbox="allow-scripts" lets the browser's PDF viewer run its
            internal scripts in a null origin, so a malicious PDF can't reach
            this document's cookies, storage, or same-origin resources. We
            deliberately omit allow-same-origin. */}
        <iframe
          src={objectUrl}
          title={displayName}
          sandbox="allow-scripts"
          className="w-full"
          style={{ height: 600, border: 0, display: "block" }}
        />
        {description && (
          <div className="px-3 py-2 text-xs text-muted-foreground border-t border-border">
            {description}
          </div>
        )}
      </div>
    );
  }

  if (resolvedMime.startsWith("image/") && objectUrl) {
    return (
      <div className="w-full my-2 rounded-lg border border-border bg-card overflow-hidden">
        {header}
        <img src={objectUrl} alt={displayName} className="block max-w-full h-auto" />
        {description && (
          <div className="px-3 py-2 text-xs text-muted-foreground border-t border-border">
            {description}
          </div>
        )}
      </div>
    );
  }

  if (content.text !== undefined) {
    return (
      <div className="w-full my-2 rounded-lg border border-border bg-card overflow-hidden">
        {header}
        <pre className="p-3 text-xs overflow-x-auto whitespace-pre-wrap break-words max-h-96">
          {content.text}
        </pre>
        {description && (
          <div className="px-3 py-2 text-xs text-muted-foreground border-t border-border">
            {description}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="w-full my-2 rounded-lg border border-border bg-card">
      {header}
      <div className="p-3 text-sm">
        {objectUrl ? (
          <a
            href={objectUrl}
            download={defaultFilename(uri, name)}
            className="inline-flex items-center gap-2 text-primary hover:underline"
          >
            <Download className="w-4 h-4" />
            Download {displayName}
          </a>
        ) : (
          <span className="text-muted-foreground">No preview available.</span>
        )}
      </div>
      {description && (
        <div className="px-3 py-2 text-xs text-muted-foreground border-t border-border">
          {description}
        </div>
      )}
    </div>
  );
}
