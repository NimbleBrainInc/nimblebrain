// ---------------------------------------------------------------------------
// ArtifactRenderer — the host's curated, sanitizing renderer registry for
// capability-produced artifacts.
//
// First principles:
//
//   1. **Artifact bytes are UNTRUSTED.** A capability (an MCP server) can store
//      whatever it wants in the data plane, and a report can quote a hostile web
//      page verbatim. So the render path is an injection surface. Every renderer
//      here either sanitizes (markdown via Streamdown, which does not execute
//      raw HTML) or isolates (HTML only inside a script-less sandboxed iframe).
//
//   2. **The registry is CLOSED.** Capabilities cannot register renderers —
//      that would be injecting UI code into the host. The host owns a curated
//      map keyed by `mime_type`. Adding a renderer is a deliberate host change.
//
//   3. **GENERIC.** This component knows nothing about any specific capability.
//      It renders any artifact of a supported media type and falls back to a
//      download affordance for anything else — never an error, never per-bundle
//      rendering code.
//
//   4. **Open `type` for meaning · standard `mime_type` for format · closed,
//      sanitizing registry for drawing.**
// ---------------------------------------------------------------------------

import { Download, FileWarning } from "lucide-react";
import { useMemo } from "react";
import { Streamdown } from "streamdown";
import { isMarkdownMime, normalizeMime } from "../lib/artifact-kind";

export interface ArtifactRendererProps {
  /** Declared (or resolved) media type of the artifact body. */
  mimeType: string | undefined;
  /** The artifact body as text. Binary artifacts are handled by the caller
   *  (download fallback) and never reach the text-oriented renderers here. */
  text: string | null;
  /** A ready-to-use object URL for download / binary preview, when available. */
  objectUrl?: string | null;
  /** Suggested download filename. */
  downloadName?: string;
  /** Optional human title for fallbacks. */
  title?: string;
}

/** The set of media types the host renders. Anything else → download fallback. */
export type ArtifactRendererKind = "markdown" | "json" | "html" | "text" | "unsupported";

/**
 * Map a media type to the renderer that draws it. Pure + exported so the
 * registry's routing is unit-testable without mounting React.
 *
 * `text/html` is supported, but ONLY through the script-less sandboxed iframe
 * (see {@link SandboxedHtml}) — never injected into the host DOM. Unknown or
 * absent types are `unsupported` and fall back to download.
 */
export function rendererKindFor(mimeType: string | undefined): ArtifactRendererKind {
  const mime = normalizeMime(mimeType);
  if (!mime) return "unsupported";
  if (isMarkdownMime(mime)) return "markdown";
  if (mime === "application/json") return "json";
  if (mime === "text/html") return "html";
  if (mime === "text/plain") return "text";
  return "unsupported";
}

export function ArtifactRenderer({
  mimeType,
  text,
  objectUrl,
  downloadName,
  title,
}: ArtifactRendererProps) {
  const kind = rendererKindFor(mimeType);

  // Every text-oriented renderer needs the body. If we have no text (binary
  // artifact, or a body that didn't decode), fall straight to download — never
  // attempt to draw bytes as text.
  if (text === null && kind !== "unsupported") {
    return <DownloadFallback objectUrl={objectUrl} downloadName={downloadName} title={title} />;
  }

  switch (kind) {
    case "markdown":
      // Streamdown is the same sanitizing renderer the assistant's (untrusted)
      // chat output uses: it renders markdown to React elements and does NOT
      // execute raw HTML embedded in the source. Exactly the property we need
      // for attacker-influenced report text.
      return (
        <Streamdown className="streamdown-container presence-assistant-message">
          {text ?? ""}
        </Streamdown>
      );
    case "json":
      return <JsonView text={text ?? ""} />;
    case "html":
      return <SandboxedHtml html={text ?? ""} title={title} />;
    case "text":
      return (
        <pre className="whitespace-pre-wrap break-words font-mono text-sm text-foreground">
          {text}
        </pre>
      );
    default:
      return <DownloadFallback objectUrl={objectUrl} downloadName={downloadName} title={title} />;
  }
}

/**
 * Pretty-print JSON as data. We parse + re-stringify so the displayed form is
 * normalized data, not raw bytes — and a parse failure degrades to the raw text
 * in a `<pre>` rather than throwing. Rendered as monospaced text, never as
 * executable markup.
 */
function JsonView({ text }: { text: string }) {
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }, [text]);
  return (
    <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground overflow-x-auto">
      {pretty}
    </pre>
  );
}

/**
 * Render untrusted HTML inside a maximally-locked-down iframe.
 *
 * The `sandbox` attribute is EMPTY — no `allow-scripts`, no `allow-same-origin`,
 * no `allow-forms`, no top-navigation. With an empty sandbox the frame is an
 * opaque origin that cannot run JavaScript, cannot reach the parent, cannot read
 * cookies/storage, and cannot navigate the top frame. The HTML is delivered via
 * `srcDoc` (never written into the host DOM), so even malicious markup is inert
 * display only. This is the only path by which artifact HTML is ever shown.
 */
function SandboxedHtml({ html, title }: { html: string; title?: string }) {
  return (
    <iframe
      // Intentionally empty sandbox — see the block comment above. Do not add
      // allow-scripts/allow-same-origin: that would defeat the isolation that
      // makes showing untrusted HTML safe.
      sandbox=""
      srcDoc={html}
      title={title ?? "Artifact preview"}
      className="w-full"
      style={{ height: 480, border: 0, display: "block" }}
    />
  );
}

function DownloadFallback({
  objectUrl,
  downloadName,
  title,
}: {
  objectUrl?: string | null;
  downloadName?: string;
  title?: string;
}) {
  const label = title ?? downloadName ?? "artifact";
  return (
    <div className="flex items-center gap-3 rounded-sm border border-border bg-card p-4 text-sm">
      <FileWarning className="h-5 w-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">No preview available</p>
        <p className="truncate text-xs text-muted-foreground">{label}</p>
      </div>
      {objectUrl && (
        <a
          href={objectUrl}
          download={downloadName ?? "artifact"}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          <Download className="h-3.5 w-3.5" />
          Download
        </a>
      )}
    </div>
  );
}
