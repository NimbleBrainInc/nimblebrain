import { Download, FileText, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiClientError, getResources, type ResourceResponse } from "../api/client";

export interface ResourceLinkViewProps {
  /** URI from the resource_link content block (e.g., `collateral://exports/exp_abc.pdf`). */
  uri: string;
  /** App/server that emitted the link — used as the `{appName}` in the resources route. */
  appName: string;
  /** Optional display name from the resource_link block. */
  name?: string;
  /** Declared MIME type from the resource_link block. Falls back to the response's Content-Type. */
  mimeType?: string;
  /** Optional description surfaced to the user. */
  description?: string;
}

/**
 * Extract the opaque path used to fetch a resource_link URI via the platform's
 * `/v1/apps/{appName}/resources/{path}` route. The scheme and authority are
 * discarded (the app binds the URI space); only `{authority}/{path}` is kept.
 */
function extractResourcePath(uri: string): string {
  const match = uri.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(.+)$/);
  if (match) return match[1]!;
  return uri.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:/, "");
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function ResourceLinkView({
  uri,
  appName,
  name,
  mimeType,
  description,
}: ResourceLinkViewProps) {
  const [resource, setResource] = useState<ResourceResponse | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;

    setLoading(true);
    setError(null);
    setResource(null);
    setObjectUrl(null);

    const path = extractResourcePath(uri);

    (async () => {
      try {
        const res = await getResources(appName, path);
        if (cancelled) return;
        setResource(res);
        if (res.kind === "blob") {
          createdUrl = URL.createObjectURL(res.body);
          setObjectUrl(createdUrl);
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
  }, [uri, appName]);

  const displayName = name ?? uri;
  const resolvedMime = resource?.mimeType ?? mimeType ?? "application/octet-stream";

  if (loading) {
    return (
      <div className="w-full my-2 rounded-lg border border-border bg-card p-3 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 text-processing animate-spin" />
        Loading {displayName}...
      </div>
    );
  }

  if (error || !resource) {
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
        {resource.kind === "blob" && (
          <span className="text-muted-foreground tabular-nums shrink-0">
            {formatBytes(resource.body.size)}
          </span>
        )}
      </div>
      {objectUrl && (
        <a
          href={objectUrl}
          download={name ?? extractResourcePath(uri).split("/").pop() ?? "download"}
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
        <iframe
          src={objectUrl}
          title={displayName}
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

  if (resource.kind === "text") {
    return (
      <div className="w-full my-2 rounded-lg border border-border bg-card overflow-hidden">
        {header}
        <pre className="p-3 text-xs overflow-x-auto whitespace-pre-wrap break-words max-h-96">
          {resource.body}
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
            download={name ?? extractResourcePath(uri).split("/").pop() ?? "download"}
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
