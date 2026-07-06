import { Download, FileText, Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { ApiClientError, type ReadResourceContent, readResource } from "../api/client";

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

/** Human-readable message for a resource-load failure, preferring API and Error messages. */
function resolveErrorMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "Failed to load resource";
}

interface FetchedResource {
  content: ReadResourceContent;
  bytes: Uint8Array | null;
}

/** Fetch a resource and decode its blob payload (if any) to bytes; no object URL is created. */
async function fetchResource(appName: string, uri: string): Promise<FetchedResource> {
  const result = await readResource(appName, uri);
  const first = result.contents[0];
  if (!first) throw new Error("No content returned");
  const bytes = first.blob !== undefined ? base64ToBytes(first.blob) : null;
  return { content: first, bytes };
}

/** Placeholder shown while the resource is being fetched. */
function LoadingState({ displayName }: { displayName: string }) {
  return (
    <div className="w-full my-2 rounded-sm border border-border bg-card p-3 flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="w-4 h-4 text-processing animate-spin" />
      Loading {displayName}...
    </div>
  );
}

/** Fallback shown when the resource fails to load. */
function ErrorState({ displayName, error }: { displayName: string; error: string | null }) {
  return (
    <div className="w-full my-2 rounded-sm border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
      Failed to load {displayName}: {error ?? "unknown error"}
    </div>
  );
}

/** Title bar with file name, size, and download affordance for a resource preview. */
function ResourceHeader({
  displayName,
  byteSize,
  objectUrl,
  uri,
  name,
}: {
  displayName: string;
  byteSize: number | null;
  objectUrl: string | null;
  uri: string;
  name?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-muted/20 text-xs">
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
}

/** Inline PDF preview rendered via an iframe backed by the resource's blob URL. */
function PdfPreview({
  header,
  objectUrl,
  displayName,
  description,
}: {
  header: ReactNode;
  objectUrl: string;
  displayName: string;
  description?: string;
}) {
  return (
    <div className="w-full my-2 rounded-sm border border-border bg-card overflow-hidden">
      {header}
      {/* No `sandbox` attribute by design. Chromium routes application/pdf
          to PDFium, which runs in a separate sandboxed renderer process
          and disables the JS APIs a malicious PDF could abuse (no
          window.parent, fetch, cookie, etc.). Adding `sandbox` would not
          tighten that boundary; it would make the iframe an opaque origin
          and Chromium then refuses to navigate it to a parent-owned blob:
          URL — Arc surfaces that refusal as "This page has been blocked
          by Arc". The pattern: pick the HTML primitive by MIME (img for
          images, iframe for PDFs, pre for text, download link otherwise)
          and rely on the browser's per-format process isolation. The
          iframe `sandbox` attribute is for untrusted *HTML*, not for
          binary resources whose viewer the browser already isolates. */}
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

/** Inline image preview backed by the resource's blob URL. */
function ImagePreview({
  header,
  objectUrl,
  displayName,
  description,
}: {
  header: ReactNode;
  objectUrl: string;
  displayName: string;
  description?: string;
}) {
  return (
    <div className="w-full my-2 rounded-sm border border-border bg-card overflow-hidden">
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

/** Inline text preview rendered in a scrollable, wrapped code block. */
function TextPreview({
  header,
  text,
  description,
}: {
  header: ReactNode;
  text: string;
  description?: string;
}) {
  return (
    <div className="w-full my-2 rounded-sm border border-border bg-card overflow-hidden">
      {header}
      <pre className="p-3 text-xs overflow-x-auto whitespace-pre-wrap break-words max-h-96">
        {text}
      </pre>
      {description && (
        <div className="px-3 py-2 text-xs text-muted-foreground border-t border-border">
          {description}
        </div>
      )}
    </div>
  );
}

/** Preview-less fallback offering a download link, or a "no preview" note. */
function DownloadFallback({
  header,
  objectUrl,
  uri,
  name,
  displayName,
  description,
}: {
  header: ReactNode;
  objectUrl: string | null;
  uri: string;
  name?: string;
  displayName: string;
  description?: string;
}) {
  return (
    <div className="w-full my-2 rounded-sm border border-border bg-card">
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

    fetchResource(appName, uri)
      .then((fetched) => {
        if (cancelled) return;
        setContent(fetched.content);
        if (fetched.bytes) {
          const blob = new Blob([fetched.bytes.buffer as ArrayBuffer], {
            type: fetched.content.mimeType ?? mimeType ?? "application/octet-stream",
          });
          createdUrl = URL.createObjectURL(blob);
          setObjectUrl(createdUrl);
          setByteSize(fetched.bytes.byteLength);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(resolveErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [uri, appName, mimeType]);

  const displayName = name ?? uri;
  const resolvedMime = content?.mimeType ?? mimeType ?? "application/octet-stream";

  if (loading) return <LoadingState displayName={displayName} />;
  if (error || !content) return <ErrorState displayName={displayName} error={error} />;

  const header = (
    <ResourceHeader
      displayName={displayName}
      byteSize={byteSize}
      objectUrl={objectUrl}
      uri={uri}
      name={name}
    />
  );

  if (resolvedMime === "application/pdf" && objectUrl) {
    return (
      <PdfPreview
        header={header}
        objectUrl={objectUrl}
        displayName={displayName}
        description={description}
      />
    );
  }

  if (resolvedMime.startsWith("image/") && objectUrl) {
    return (
      <ImagePreview
        header={header}
        objectUrl={objectUrl}
        displayName={displayName}
        description={description}
      />
    );
  }

  if (content.text !== undefined) {
    return <TextPreview header={header} text={content.text} description={description} />;
  }

  return (
    <DownloadFallback
      header={header}
      objectUrl={objectUrl}
      uri={uri}
      name={name}
      displayName={displayName}
      description={description}
    />
  );
}
