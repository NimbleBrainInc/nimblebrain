import { createContext, type ReactNode, useContext, useRef } from "react";

/**
 * Whether the host draws the title and breadcrumb from the trail this app
 * sends (`ai.nimblebrain/location`). When it does, a screen shows no title or
 * back control of its own; on any other host it keeps them.
 */
export const HostTrailContext = createContext(false);

/**
 * A screen's head: its status line and actions, and, only where the host
 * shows no breadcrumb, a back control and the title.
 */
export function ScreenHead({
  title,
  onBack,
  sub,
  actions,
}: {
  title: ReactNode;
  onBack: () => void;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  const hostShowsTrail = useContext(HostTrailContext);
  if (hostShowsTrail && !sub && !actions) return null;
  return (
    <header className="screen-head">
      {!hostShowsTrail && (
        <button type="button" className="back-btn" onClick={onBack} aria-label="Back">
          ←
        </button>
      )}
      <div className="screen-head-meta">
        {!hostShowsTrail && <h1 className="page-title">{title}</h1>}
        {sub && <div className="screen-sub">{sub}</div>}
      </div>
      {actions && <div className="screen-actions">{actions}</div>}
    </header>
  );
}

/** A tab list: arrow keys move between tabs, the selected one is the only tab stop. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  idPrefix,
}: {
  tabs: Array<{ id: T; text: string }>;
  value: T;
  onChange: (v: T) => void;
  label: string;
  idPrefix: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div className="view-tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`${idPrefix}-tab-${t.id}`}
          aria-selected={value === t.id}
          aria-controls={`${idPrefix}-panel`}
          tabIndex={value === t.id ? 0 : -1}
          className={`view-tab${value === t.id ? " on" : ""}`}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
            e.preventDefault();
            const next = (i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
            const tab = tabs[next];
            if (!tab) return;
            onChange(tab.id);
            refs.current[next]?.focus();
          }}
        >
          {t.text}
        </button>
      ))}
    </div>
  );
}
