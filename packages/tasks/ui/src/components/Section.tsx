import { type ReactNode, useId, useState } from "react";

/**
 * The one section every page is built from: a card the full width of the
 * content, with a header row (its title on the left; its actions or a
 * one-line summary on the right) and its body. Controls inside fill the card;
 * only long prose keeps a reading measure.
 */
export function Section({
  title,
  aside,
  children,
  className,
}: {
  title: ReactNode;
  /** The section's actions, or a one-line summary, at the right of its header. */
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section className={`card${className ? ` ${className}` : ""}`} aria-labelledby={id}>
      <div className="card-head">
        <h2 className="section-heading" id={id}>
          {title}
        </h2>
        {aside && <div className="card-aside">{aside}</div>}
      </div>
      <div className="card-body">{children}</div>
    </section>
  );
}

/** A page's sections, one after another with the section gap between them. */
export function Sections({ children }: { children: ReactNode }) {
  return <div className="sections">{children}</div>;
}

/** One tile of a summary strip; `detail` makes it open a panel under the strip. */
export interface Tile {
  id: string;
  label: string;
  value: ReactNode;
  /** One line under the value. */
  sub?: ReactNode;
  /** What opens under the strip when the tile is picked. */
  detail?: ReactNode;
}

/**
 * The report card: a row of equal tiles that wraps on a narrow page. A tile
 * with more to say opens it in one panel under the strip, and only one is
 * open at a time, the same way for every tile.
 */
export function SummaryStrip({ tiles, label }: { tiles: Tile[]; label: string }) {
  const base = useId();
  const [open, setOpen] = useState<string | null>(null);
  const shown = tiles.find((t) => t.id === open && t.detail);
  return (
    <div className="summary">
      <ul className="summary-strip" aria-label={label}>
        {tiles.map((t) => {
          const body = (
            <>
              <span className="tile-label">{t.label}</span>
              <span className="tile-value">{t.value}</span>
              {t.sub && <span className="tile-sub">{t.sub}</span>}
            </>
          );
          return (
            <li key={t.id} className="tile-cell">
              {t.detail ? (
                <button
                  type="button"
                  className={`tile tile-open${open === t.id ? " on" : ""}`}
                  aria-expanded={open === t.id}
                  aria-controls={`${base}-detail`}
                  onClick={() => setOpen(open === t.id ? null : t.id)}
                >
                  {body}
                  <span className="tile-more" aria-hidden="true" />
                </button>
              ) : (
                <div className="tile">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      {shown && (
        <section className="tile-detail" id={`${base}-detail`} aria-label={shown.label}>
          {shown.detail}
        </section>
      )}
    </div>
  );
}
