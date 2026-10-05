import { createContext, type ReactNode, useContext } from "react";

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
