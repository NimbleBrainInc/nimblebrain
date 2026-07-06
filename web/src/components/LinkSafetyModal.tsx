import { ArrowUpRight, Check, Copy, Link2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LinkSafetyModalProps } from "streamdown";

/**
 * First-party replacement for Streamdown's stock link-safety modal.
 *
 * Streamdown ships a confirmation dialog styled for its own (Vercel/Geist)
 * design language; wired through `linkSafety.renderModal` this renders the
 * NimbleBrain modal instead — on-brand tokens, lucide icons, and a
 * domain-forward hierarchy. The domain is the headline (the thing a reader
 * actually decides on); the path is demoted to a quiet chip. Warm is the
 * "you're leaving the app" accent.
 *
 * `onConfirm` is Streamdown's navigation handler (opens the link); we also
 * call `onClose` so the overlay tears down. Shared across every `<Streamdown>`
 * site via `web/src/lib/streamdown-config`.
 */

interface ParsedUrl {
  domain: string;
  /** Path + query + hash, or "" when the URL is a bare origin. */
  rest: string;
  initial: string;
}

function parseUrl(raw: string): ParsedUrl {
  try {
    const u = new URL(raw);
    const domain = u.hostname.replace(/^www\./, "");
    const rest = `${u.pathname}${u.search}${u.hash}`;
    return {
      domain,
      rest: rest === "/" ? "" : rest,
      initial: domain.charAt(0).toUpperCase() || "?",
    };
  } catch {
    // Not a parseable absolute URL — show it verbatim rather than guess.
    return { domain: raw, rest: "", initial: raw.charAt(0).toUpperCase() || "?" };
  }
}

export function LinkSafetyModal({ isOpen, onClose, onConfirm, url }: LinkSafetyModalProps) {
  const [copied, setCopied] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);

  // Esc to dismiss + lock body scroll while open. Focus lands on the
  // non-destructive action (Copy), so Enter never navigates by accident.
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    // Click-outside closes. Deferred a tick so the link click that opened the
    // modal doesn't immediately dismiss it (same guard as KeyboardShortcutsModal).
    const handleClickOutside = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) onClose();
    };
    const outsideTimer = setTimeout(
      () => document.addEventListener("mousedown", handleClickOutside),
      100,
    );
    document.addEventListener("keydown", handleKeyDown, { capture: true });
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    copyRef.current?.focus();
    return () => {
      clearTimeout(outsideTimer);
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown, { capture: true });
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen, onClose]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (insecure context / denied) — leave state as-is.
    }
  }, [url]);

  const handleVisit = useCallback(() => {
    onConfirm();
    onClose();
  }, [onConfirm, onClose]);

  if (!isOpen) return null;
  const { domain, rest, initial } = parseUrl(url);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Visual backdrop only; dismissal is handled by the document mousedown
          + Esc listeners above, so this needs no interactive handlers. */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Open external link"
        className="relative w-full max-w-sm rounded-2xl border border-border bg-card text-foreground shadow-2xl overflow-hidden"
      >
        <div className="flex items-start gap-3 p-4">
          <div className="shrink-0 grid place-items-center w-10 h-10 rounded-xl border border-warm/20 bg-warm/10 text-warm text-base font-semibold">
            {initial}
          </div>
          <div className="min-w-0 flex flex-col gap-0.5">
            <span className="text-2xs font-mono uppercase tracking-wider text-muted-foreground">
              Leaving NimbleBrain
            </span>
            <span className="text-base font-semibold leading-tight truncate" title={domain}>
              {domain}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
          >
            <X style={{ width: 15, height: 15 }} />
          </button>
        </div>

        {rest && (
          <div className="mx-4 flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-2xs font-mono text-muted-foreground">
            <Link2 className="shrink-0 opacity-70" style={{ width: 12, height: 12 }} />
            <span className="truncate" title={url}>
              {rest}
            </span>
          </div>
        )}

        <div className="flex items-center gap-2 p-4">
          <button
            ref={copyRef}
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
          >
            {copied ? (
              <Check style={{ width: 14, height: 14 }} />
            ) : (
              <Copy style={{ width: 14, height: 14 }} />
            )}
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={handleVisit}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-warm px-4 py-2 text-sm font-semibold text-warm-foreground hover:bg-warm-hover transition-all"
          >
            Visit site
            <ArrowUpRight style={{ width: 15, height: 15 }} />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
