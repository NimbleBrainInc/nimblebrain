import { createContext, type ReactNode, useContext } from "react";

/**
 * Whether the host draws the breadcrumb from the trail this app sends
 * (`ai.nimblebrain/location`). When it does, a page shows no back control of
 * its own; on any other host it keeps one.
 */
export const HostTrailContext = createContext(false);

/**
 * The one header every page uses: on the left its heading and a one-line
 * status, on the right that page's actions, centred on the heading's row.
 */
export function PageHeader({
  title,
  status,
  actions,
  onBack,
}: {
  title: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  /** Absent on the home, which has nothing to go back to. */
  onBack?: () => void;
}) {
  const hostShowsTrail = useContext(HostTrailContext);
  return (
    <header className="page-header">
      {onBack && !hostShowsTrail && (
        <button type="button" className="back-btn" onClick={onBack} aria-label="Back">
          ←
        </button>
      )}
      <div className="page-header-text">
        <h1 className="page-heading">{title}</h1>
        {status && <div className="page-status">{status}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}
