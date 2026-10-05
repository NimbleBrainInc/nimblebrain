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
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes it (window listener above)
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is not a control
    <div className="confirm-overlay" onClick={onClose}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the click only stops the backdrop's close; Escape is handled on window */}
      <div
        ref={panelRef}
        className={`confirm-panel${wide ? " modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
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
