import { type ReactNode, useEffect, useRef } from "react";

/** Open overlays, innermost last, so Esc closes only the top one. */
const stack: Array<() => void> = [];

/**
 * A dialog drawn over the view: a scrim that closes it on click, Esc to close,
 * and focus moved in on open and given back on close.
 *
 * Not a native modal: the host's sandbox withholds `allow-modals`, which rules
 * out `<dialog>.showModal()`, `alert()`, and `confirm()` (the last returns
 * false without showing anything).
 */
export function Overlay({
  label,
  className,
  onClose,
  children,
}: {
  label: string;
  className: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const entry = () => close.current();
    stack.push(entry);
    const first = panel.current?.querySelector<HTMLElement>(
      "input, button:not([disabled]), [tabindex]",
    );
    (first ?? panel.current)?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && stack[stack.length - 1] === entry) {
        e.stopPropagation();
        entry();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      stack.splice(stack.indexOf(entry), 1);
      previous?.focus?.();
    };
  }, []);

  return (
    <div className="overlay">
      <button
        type="button"
        className="overlay-scrim"
        aria-label="Close"
        tabIndex={-1}
        onClick={() => close.current()}
      />
      <div
        ref={panel}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}
