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
import { type Ref, useEffect, useRef, useState } from "react";
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
  // Only keep a recognized document extension — an arbitrary trailing dot-token
  // (e.g. a title like "report.final") is NOT an extension and still gets one.
  if (/\.(md|markdown|txt)$/i.test(base)) return base;
  // Extension-less names get one inferred from the MIME: plain text → .txt,
  // markdown (and the catch-all) → .md.
  const ext = normalizeMime(mimeType) === "text/plain" ? "txt" : "md";
  return `${base}.${ext}`;
}

/** Readable text of a resource content item: inline text, or a base64 blob decoded to text; null if neither. */
function readableBody(first: ReadResourceContent): string | null {
  if (first.text !== undefined) return first.text;
  if (first.blob !== undefined) return decodeBlobText(first.blob);
  return null;
}

/** Human-readable message for a resource-load failure, preferring the error's own message. */
function loadErrorMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "Failed to load document";
}

/** State setters the fetch drives; grouped so the effect can hand them off wholesale. */
interface ArtifactFetchSinks {
  setText: (v: string) => void;
  setMimeType: (v: string | undefined) => void;
  setError: (v: string) => void;
  setLoading: (v: boolean) => void;
}

/**
 * Fetch a resource's text and push it into panel state, ignoring every result
 * once `isCancelled()` returns true (the effect that started the fetch has been
 * superseded or unmounted). `fallbackMime` is the descriptor's MIME, used only
 * when the fetched content omits its own.
 */
async function loadArtifactText(
  appName: string,
  uri: string,
  fallbackMime: string | undefined,
  isCancelled: () => boolean,
  sinks: ArtifactFetchSinks,
): Promise<void> {
  try {
    const result = await readResource(appName, uri);
    if (isCancelled()) return;
    const first: ReadResourceContent | undefined = result.contents[0];
    if (!first) throw new Error("No content returned");
    const body = readableBody(first);
    if (body === null) throw new Error("Resource has no readable text content");
    sinks.setText(body);
    sinks.setMimeType(first.mimeType ?? fallbackMime);
  } catch (err) {
    if (isCancelled()) return;
    sinks.setError(loadErrorMessage(err));
  } finally {
    if (!isCancelled()) sinks.setLoading(false);
  }
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

  // artifact?.mimeType is captured only as a fallback at fetch time; the
  // (appName, uri) pair is the identity of the resource being fetched.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fetch keyed on resource identity
  useEffect(() => {
    if (!appName || !uri) return;
    let cancelled = false;

    setLoading(true);
    setError(null);
    setText(null);
    setMimeType(undefined);
    setCopied(false);

    loadArtifactText(appName, uri, artifact?.mimeType, () => cancelled, {
      setText,
      setMimeType,
      setError,
      setLoading,
    });

    return () => {
      cancelled = true;
    };
  }, [appName, uri]);

  // Esc closes the panel while it's open. The panel is the topmost layer, so it
  // claims Esc in the capture phase and stops the event before it reaches other
  // document-level Esc handlers (e.g. ChatChrome's drawer) — otherwise one Esc
  // press would close both.
  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeArtifact();
      }
    }
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true });
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
            <ArtifactHeader
              title={title}
              description={artifact?.description}
              copied={copied}
              disabled={text == null}
              onCopy={onCopy}
              onDownload={onDownload}
              onClose={closeArtifact}
              closeButtonRef={closeButtonRef}
            />

            {/* Body — the scrollable reading region. */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <ArtifactBody
                loading={loading}
                error={error}
                text={text}
                title={title}
                renderMarkdown={renderMarkdown}
              />
            </div>
          </>
        )}
      </aside>
    </>
  );
}

/**
 * Panel header — file title, optional description, and copy / download / close
 * actions. Sticky by virtue of the panel's flex column: the body below scrolls,
 * this stays put.
 */
function ArtifactHeader({
  title,
  description,
  copied,
  disabled,
  onCopy,
  onDownload,
  onClose,
  closeButtonRef,
}: {
  title: string;
  description: string | undefined;
  copied: boolean;
  disabled: boolean;
  onCopy: () => void;
  onDownload: () => void;
  onClose: () => void;
  closeButtonRef: Ref<HTMLButtonElement>;
}) {
  return (
    <header className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-4 py-3">
      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
        {description && <p className="truncate text-xs text-muted-foreground">{description}</p>}
      </div>

      <button
        type="button"
        onClick={onCopy}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 rounded-sm border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-40"
        aria-label="Copy document to clipboard"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? "Copied" : "Copy"}
      </button>
      <button
        type="button"
        onClick={onDownload}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 rounded-sm border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-40"
        aria-label="Download document"
      >
        <Download className="h-3.5 w-3.5" />
        Download
      </button>
      <button
        ref={closeButtonRef}
        type="button"
        onClick={onClose}
        className="ml-1 inline-flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        aria-label="Close document panel"
      >
        <X className="h-4 w-4" />
      </button>
    </header>
  );
}

/** Panel body for the current fetch state: loading spinner, error banner, or the rendered document. */
function ArtifactBody({
  loading,
  error,
  text,
  title,
  renderMarkdown,
}: {
  loading: boolean;
  error: string | null;
  text: string | null;
  title: string;
  renderMarkdown: boolean;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 px-6 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin text-processing" />
        Loading {title}...
      </div>
    );
  }

  if (error) {
    return (
      <div className="m-6 rounded-sm border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive">
        Failed to load {title}: {error}
      </div>
    );
  }

  if (text == null) return null;

  return (
    <article className="mx-auto max-w-3xl px-6 py-8">
      {renderMarkdown ? (
        <Streamdown className="streamdown-container presence-assistant-message">{text}</Streamdown>
      ) : (
        <pre className="whitespace-pre-wrap break-words font-mono text-sm text-foreground">
          {text}
        </pre>
      )}
    </article>
  );
}
