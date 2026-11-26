import { type ReactNode, useEffect, useId, useRef } from "react";

/**
 * A dialog over the panel: labelled by its title, Escape and the backdrop
 * close it, and focus moves into it on open and back where it was on close.
 */
export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(
      "input, textarea, select, button:not(.modal-x)",
    );
    (first ?? panel)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, []);

  return (
    <div className="confirm-overlay">
      {/* A click outside the panel closes it. Out of the tab order: Escape and
          the × are the keyboard's ways out. */}
      <button
        type="button"
        className="modal-backdrop"
        aria-label="Close dialog"
        tabIndex={-1}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        className={`confirm-panel${wide ? " modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="modal-head">
          <h2 className="confirm-title" id={titleId}>
            {title}
          </h2>
          <button type="button" className="modal-x" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
