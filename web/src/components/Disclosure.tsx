import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

/** Head tone. Only the activity chip varies; the ledger line has no tone. */
export type DisclosureTone = "running" | "ok" | "error";

/**
 * The collapsible summary line an assistant turn is built from: a leading
 * glyph, caller-supplied head content, and a chevron that opens a drawer.
 *
 * Two surfaces render it, and they stack directly on top of each other inside a
 * message — the Context Ledger's skills line above the first activity chip. So
 * their resting physics are not merely similar, they have to be the same object:
 * one head box, one hover, one focus ring, one chevron on one right edge, one
 * drawer. That is what lives here and in `.disclosure*`.
 *
 * A variant contributes only what genuinely differs — the chip's tone-driven
 * label and icon colors, the ledger's expanded dot — through its own class on
 * the wrapper, alongside `.disclosure`.
 *
 * Every disclosure has a drawer. A head with nothing to open is a label, and a
 * label should not be built out of a button.
 */
export function Disclosure({
  variant,
  tone,
  expanded,
  onToggle,
  glyph,
  children,
  body,
}: {
  /** Variant class, applied alongside `.disclosure`. */
  variant: "turn-pill" | "ledger-line";
  tone?: DisclosureTone;
  expanded: boolean;
  onToggle: () => void;
  /** Leading mark — a dot, a check, a spinner. Styled by the variant. */
  glyph: ReactNode;
  /** Head content between the glyph and the chevron. */
  children: ReactNode;
  /** Drawer content. */
  body: ReactNode;
}) {
  return (
    <div
      className={`disclosure ${variant}`}
      data-expanded={expanded}
      {...(tone ? { "data-tone": tone } : {})}
    >
      <button
        type="button"
        className="disclosure__head"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        {glyph}
        {children}
        <DisclosureChevron size={14} />
      </button>
      {expanded && <div className="disclosure__body">{body}</div>}
    </div>
  );
}

/**
 * The chevron itself, also used by the nested rows inside a drawer — those have
 * their own physics (background hover, no box) but disclose the same way, so
 * they share the mark and its rotation. Size is per-site: the head sits at 14,
 * rows step down from there.
 */
export function DisclosureChevron({ size }: { size: number }) {
  return (
    <ChevronRight className="disclosure__chev" style={{ width: size, height: size }} aria-hidden />
  );
}
