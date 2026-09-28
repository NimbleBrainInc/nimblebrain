// ---------------------------------------------------------------------------
// BriefingView — what needs a member in this workspace, as a list.
//
// Pure: it takes the `nb__briefing` result and the workspace's installed
// connectors and renders. No data fetching — the overview wires it to
// `useWorkspaceBriefing` and the connectors list it already holds.
//
// Two kinds of row:
//   - A facet item from the server: `<count> <label>` with the app's name,
//     opening the app. Label and count are untrusted server data and render as
//     text; an `unavailable` item renders muted and keeps its action.
//   - A connector that is not ready: the status the connector page shows,
//     opening that page. Its facets are never read, so it has no count.
// With neither, the list is one line saying nothing needs the member.
// ---------------------------------------------------------------------------

import type { ReactNode } from "react";
import type { BriefingItem, BriefingOutput } from "../../_generated/platform-schemas/home";
import type { InstalledConnector } from "../../api/client";
import { cn } from "../../lib/utils";
import { statusLabel } from "../connectors/ConnectorStatusHero";

/** Statuses a member resolves on the connector's page. `connecting` and `starting` are in flight. */
const ATTENTION_STATUSES: ReadonlySet<InstalledConnector["status"]> = new Set([
  "needs_auth",
  "needs_setup",
  "failed",
]);

interface BriefingViewProps {
  briefing: BriefingOutput | null;
  /** The workspace's installed connectors; each needing attention adds a row. */
  connectors: readonly InstalledConnector[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** Invoked with a facet item's app route. */
  onOpen: (route: string) => void;
  /** Invoked with the server name of a connector that needs attention. */
  onOpenConnector: (serverName: string) => void;
}

function Row({
  onClick,
  muted,
  children,
  testId,
}: {
  onClick?: () => void;
  muted?: boolean;
  children: ReactNode;
  testId: string;
}) {
  const className = cn(
    "flex w-full items-baseline gap-1.5 px-3 py-2 -mx-3 rounded-sm text-left text-sm",
    muted ? "text-muted-foreground" : "text-foreground",
  );
  return (
    <li data-testid={testId}>
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          className={cn(className, "hover:bg-foreground/5 transition-colors")}
        >
          {children}
        </button>
      ) : (
        <div className={className}>{children}</div>
      )}
    </li>
  );
}

function AppName({ name }: { name: string }) {
  return <span className="text-muted-foreground"> · {name}</span>;
}

function FacetRow({ item, onOpen }: { item: BriefingItem; onOpen: (route: string) => void }) {
  const { route } = item;
  const unavailable = item.state === "unavailable";
  return (
    <Row
      testId={unavailable ? "briefing-item-unavailable" : "briefing-item"}
      muted={unavailable}
      onClick={route ? () => onOpen(route) : undefined}
    >
      <span>
        {unavailable ? (
          <>{item.label} — unavailable</>
        ) : (
          <>
            <span className="font-semibold tabular-nums">{item.count}</span> {item.label}
          </>
        )}
        <AppName name={item.app} />
      </span>
    </Row>
  );
}

function ConnectorRow({
  connector,
  onOpen,
}: {
  connector: InstalledConnector;
  onOpen: (serverName: string) => void;
}) {
  return (
    <Row testId="briefing-connector-status" onClick={() => onOpen(connector.serverName)}>
      <span>
        {statusLabel(connector.status)}
        <AppName name={connector.catalog?.name ?? connector.serverName} />
      </span>
    </Row>
  );
}

function Skeleton() {
  return (
    <div className="space-y-1" aria-hidden data-testid="workspace-briefing-loading">
      <div className="h-9 rounded-sm bg-muted/50 motion-safe:animate-pulse" />
      <div className="h-9 rounded-sm bg-muted/50 motion-safe:animate-pulse" />
    </div>
  );
}

export function BriefingView({
  briefing,
  connectors,
  loading,
  error,
  onRetry,
  onOpen,
  onOpenConnector,
}: BriefingViewProps) {
  const needsAttention = connectors.filter((c) => ATTENTION_STATUSES.has(c.status));
  const items = briefing?.items ?? [];
  const empty = !loading && !error && items.length === 0 && needsAttention.length === 0;

  return (
    <section data-testid="workspace-briefing">
      {loading ? (
        <Skeleton />
      ) : (
        <>
          {(needsAttention.length > 0 || items.length > 0) && (
            <ul>
              {needsAttention.map((c) => (
                <ConnectorRow
                  key={`connector:${c.serverName}`}
                  connector={c}
                  onOpen={onOpenConnector}
                />
              ))}
              {items.map((item) => (
                <FacetRow key={`${item.app}/${item.facet}`} item={item} onOpen={onOpen} />
              ))}
            </ul>
          )}

          {error && (
            <div
              className="mt-2 rounded-sm border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive"
              data-testid="workspace-briefing-error"
            >
              <p>{error}</p>
              <button
                type="button"
                onClick={onRetry}
                className="mt-2 text-xs font-medium text-destructive hover:underline"
              >
                Retry
              </button>
            </div>
          )}

          {empty && (
            <p className="text-sm text-muted-foreground" data-testid="workspace-briefing-empty">
              Nothing needs you in this workspace.
            </p>
          )}
        </>
      )}
    </section>
  );
}
