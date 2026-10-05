import { type CSSProperties, useEffect, useId, useRef, useState } from "react";

export interface RowMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/** Rough height of one item, for deciding whether the list fits below the button. */
const ITEM_PX = 34;

/**
 * Where the open list sits: fixed to the viewport beside its button, so no
 * scrolling ancestor clips it, opening upward when there is no room below.
 */
export function menuPosition(
  button: { top: number; bottom: number; right: number },
  viewport: { width: number; height: number },
  items: number,
): CSSProperties {
  const height = items * ITEM_PX + 8;
  const right = Math.max(8, viewport.width - button.right);
  return button.bottom + 4 + height > viewport.height && button.top - 4 - height > 0
    ? { position: "fixed", right, bottom: viewport.height - button.top + 4 }
    : { position: "fixed", right, top: button.bottom + 4 };
}

/**
 * A row's actions behind one button. Arrow keys move through the items,
 * Escape or a click outside closes it and returns focus to the button, and a
 * scroll or resize closes it rather than leave it floating away from its row.
 */
export function RowMenu({
  label,
  items,
  text = "⋯",
}: {
  label: string;
  items: RowMenuItem[];
  text?: string;
}) {
  const id = useId();
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const open = style !== null;

  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus();
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setStyle(null);
    };
    const shut = () => setStyle(null);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", shut);
    window.addEventListener("scroll", shut, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", shut);
      window.removeEventListener("scroll", shut, true);
    };
  }, [open]);

  function toggle() {
    if (open) return setStyle(null);
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setStyle(
      menuPosition(rect, { width: window.innerWidth, height: window.innerHeight }, items.length),
    );
  }

  function close() {
    setStyle(null);
    buttonRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const all = [
      ...(rootRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ??
        []),
    ];
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? (at + 1) % all.length : (at - 1 + all.length) % all.length;
    all[next]?.focus();
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keyboard handling for the menu inside
    <div className="row-menu" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        ref={buttonRef}
        type="button"
        className="btn btn-icon"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label}
        onClick={toggle}
      >
        {text}
      </button>
      {style && (
        <div className="row-menu-list" role="menu" id={id} style={style}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`row-menu-item${item.danger ? " danger" : ""}`}
              disabled={item.disabled}
              onClick={() => {
                setStyle(null);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
