// ---------------------------------------------------------------------------
// ArtifactPanel — the document surface for artifact resources.
//
// INVARIANT: mounted exactly once, globally (by ShellLayout, next to
// ChatChrome). A second mount renders a second drawer. Every ArtifactChip,
// in any conversation, opens into this single instance via
// ArtifactPanelContext.
//
// It is the GENERAL artifact renderer: keyed off the resource descriptor's
// MIME, not off deep-research. Markdown is rendered (via Streamdown, the same
// renderer the assistant's chat messages use) into a clean reading layout
// with a title header and sticky copy / download actions; plain text falls
// back to monospaced preformatted text. Fetch + loading/error states reuse
// ResourceLinkView's `readResource` path and state shape.
// ---------------------------------------------------------------------------

import { Check, Copy, Download, FileText, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { ApiClientError, type ReadResourceContent, readResource } from "../api/client";
import { useArtifactPanel } from "../context/ArtifactPanelContext";
import { isMarkdownMime, normalizeMime } from "../lib/artifact-kind";
import { useIsMobile } from "../lib/hooks/use-is-mobile";

const TRANSITION = "300ms cubic-bezier(0.33, 1, 0.68, 1)";
const PANEL_WIDTH = 720; // px — comfortable reading measure on desktop.

/** Decode a base64 text resource (blob form) to a string. */
function decodeBlobText(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function downloadFilename(
  uri: string,
  name: string | undefined,
  mimeType: string | undefined,
): string {
  const base = name ?? uri.split("/").pop() ?? "document";
  if (/\.[a-z0-9]+$/i.test(base)) return base;
  // Extension-less names get one inferred from the MIME: plain text → .txt,
  // markdown (and the catch-all) → .md.
  const ext = normalizeMime(mimeType) === "text/plain" ? "txt" : "md";
  return `${base}.${ext}`;
}

export function ArtifactPanel() {
  const { artifact, closeArtifact } = useArtifactPanel();
  const isMobile = useIsMobile();
  const isOpen = artifact !== null;

  const [text, setText] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const appName = artifact?.appName;
  const uri = artifact?.uri;

  useEffect(() => {
    if (!appName || !uri) return;
    let cancelled = false;

    setLoading(true);
    setError(null);
    setText(null);
    setMimeType(undefined);
    setCopied(false);

    (async () => {
      try {
        const result = await readResource(appName, uri);
        if (cancelled) return;
        const first: ReadResourceContent | undefined = result.contents[0];
        if (!first) throw new Error("No content returned");
        const body =
          first.text !== undefined
            ? first.text
            : first.blob !== undefined
              ? decodeBlobText(first.blob)
              : null;
        if (body === null) throw new Error("Resource has no readable text content");
        setText(body);
        setMimeType(first.mimeType ?? artifact?.mimeType);
      } catch (err) {
        if (cancelled) return;
        const msg =
          err instanceof ApiClientError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Failed to load document";
        setError(msg);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // artifact?.mimeType is captured only as a fallback at fetch time; the
    // (appName, uri) pair is the identity of the resource being fetched.
    // biome-ignore lint/correctness/useExhaustiveDependencies: fetch keyed on resource identity
  }, [appName, uri]);

  // Esc closes the panel while it's open.
  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeArtifact();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, closeArtifact]);

  // Focus management: when the dialog opens, remember what was focused and
  // move focus to the Close button (the panel's first stable control), so
  // keyboard users land inside the dialog rather than behind it. On close,
  // restore focus to the trigger (the chip). Paired with conditional render +
  // aria-hidden below, this keeps the closed panel out of the tab order and
  // unannounced by screen readers.
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (isOpen) {
      restoreFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
      // Defer one frame so the button is mounted and the slide-in has begun.
      const id = requestAnimationFrame(() => closeButtonRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    const toRestore = restoreFocusRef.current;
    restoreFocusRef.current = null;
    toRestore?.focus?.();
  }, [isOpen]);

  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  async function onCopy() {
    if (text == null) return;
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — no-op */
    }
  }

  function onDownload() {
    if (text == null || !uri) return;
    const blob = new Blob([text], { type: mimeType ?? "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadFilename(uri, artifact?.name, mimeType ?? artifact?.mimeType);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const title = artifact?.name ?? uri?.split("/").pop() ?? "Document";
  const renderMarkdown = isMarkdownMime(mimeType ?? artifact?.mimeType);

  return (
    <>
      {/* Scrim — click to dismiss. Only interactive while open. */}
      <div
        aria-hidden={!isOpen}
        onClick={closeArtifact}
        className="fixed inset-0 z-20 bg-black/20"
        style={{
          opacity: isOpen ? 1 : 0,
          pointerEvents: isOpen ? "auto" : "none",
          transition: `opacity ${TRANSITION}`,
        }}
      />

      {/* The aside stays mounted so the slide transition can play, but when
          closed it is aria-hidden + inert (no focusable controls, not
          announced) and its content is unmounted — which also clears the
          previous document's body so it can't linger off-screen. role=dialog /
          aria-modal therefore only describe a panel that is actually open. */}
      <aside
        {...(isOpen ? { role: "dialog", "aria-modal": true } : { inert: true })}
        aria-hidden={!isOpen}
        aria-label={title}
        data-testid="artifact-panel"
        className="fixed top-0 right-0 z-30 flex h-full max-w-full flex-col border-l border-border bg-background shadow-xl"
        style={{
          width: isMobile ? "100%" : PANEL_WIDTH,
          transform: isOpen ? "translateX(0)" : "translateX(100%)",
          transition: `transform ${TRANSITION}`,
        }}
      >
        {isOpen && (
          <>
            {/* Header — title + actions. Sticky by virtue of the flex column:
                the body below scrolls, this stays put. */}
            <header className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-4 py-3">
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                {title}
              </h2>

              <button
                type="button"
                onClick={onCopy}
                disabled={text == null}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-40"
                aria-label="Copy document to clipboard"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                onClick={onDownload}
                disabled={text == null}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-40"
                aria-label="Download document"
              >
                <Download className="h-3.5 w-3.5" />
                Download
              </button>
              <button
                ref={closeButtonRef}
                type="button"
                onClick={closeArtifact}
                className="ml-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                aria-label="Close document panel"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            {/* Body — the scrollable reading region. */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {loading && (
                <div className="flex items-center gap-2 px-6 py-8 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin text-processing" />
                  Loading {title}...
                </div>
              )}

              {!loading && error && (
                <div className="m-6 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                  Failed to load {title}: {error}
                </div>
              )}

              {!loading && !error && text != null && (
                <article className="mx-auto max-w-3xl px-6 py-8">
                  {renderMarkdown ? (
                    <Streamdown className="streamdown-container presence-assistant-message">
                      {text}
                    </Streamdown>
                  ) : (
                    <pre className="whitespace-pre-wrap break-words font-mono text-sm text-foreground">
                      {text}
                    </pre>
                  )}
                </article>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}
