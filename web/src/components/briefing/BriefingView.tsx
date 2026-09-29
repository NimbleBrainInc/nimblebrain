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
// Every row has a level, shown by icon and colour, and the list is ordered by
// it: `blocked` (something has stopped), then `action` (someone should act),
// then `info` (worth knowing). A facet's level is its server's; a connector
// row's is the host's (`statusLevel`).
// With neither kind of row, the list is one line saying nothing needs the member.
// ---------------------------------------------------------------------------

import { CircleAlert, Info, type LucideIcon, OctagonAlert } from "lucide-react";
import type { ReactNode } from "react";
import type {
  BriefingItem,
  BriefingLevel,
  BriefingOutput,
} from "../../_generated/platform-schemas/home";
import type { InstalledConnector } from "../../api/client";
import { cn } from "../../lib/utils";
import { statusLabel } from "../connectors/ConnectorStatusHero";

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

const LEVELS: Record<
  BriefingLevel,
  { rank: number; icon: LucideIcon; tone: string; name: string }
> = {
  blocked: { rank: 0, icon: OctagonAlert, tone: "text-destructive", name: "Blocked" },
  action: { rank: 1, icon: CircleAlert, tone: "text-warning", name: "Needs action" },
  info: { rank: 2, icon: Info, tone: "text-muted-foreground", name: "For information" },
};

/**
 * The host's level for a connector that is not ready. One it cannot work
 * without someone acting on is `blocked`; one still coming up resolves on its
 * own and is `info`.
 */
export function statusLevel(status: InstalledConnector["status"]): BriefingLevel {
  return status === "connecting" || status === "starting" ? "info" : "blocked";
}

/** A level the web does not know reads as `action`, as the extension requires. */
function levelOf(level: string): BriefingLevel {
  return level in LEVELS ? (level as BriefingLevel) : "action";
}

function Row({
  onClick,
  muted,
  level,
  children,
  testId,
}: {
  onClick?: () => void;
  muted?: boolean;
  level: BriefingLevel;
  children: ReactNode;
  testId: string;
}) {
  const { icon: Icon, tone, name } = LEVELS[level];
  const className = cn(
    "flex w-full items-center gap-2 px-3 py-2 -mx-3 rounded-sm text-left text-sm",
    muted || level === "info" ? "text-muted-foreground" : "text-foreground",
  );
  const body = (
    <>
      <Icon className={cn("h-4 w-4 shrink-0", tone)} aria-hidden />
      <span className="sr-only">{name}: </span>
      {children}
    </>
  );
  return (
    <li data-testid={testId} data-level={level}>
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          className={cn(className, "hover:bg-foreground/5 transition-colors")}
        >
          {body}
        </button>
      ) : (
        <div className={className}>{body}</div>
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
      level={levelOf(item.level)}
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
    <Row
      testId="briefing-connector-status"
      level={statusLevel(connector.status)}
      onClick={() => onOpen(connector.serverName)}
    >
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
  // Every status but `ready`, `connecting` and `starting` included: an OAuth
  // abandoned mid-flow stays `connecting`, and its page is where it is cancelled.
  const needsAttention = connectors.filter((c) => c.status !== "ready");
  const items = briefing?.items ?? [];
  const empty = !loading && !error && items.length === 0 && needsAttention.length === 0;
  // One list, most urgent first. Within a level, connector rows lead and facet
  // items keep the server's order (sort is stable).
  const rows = [
    ...needsAttention.map((c) => ({
      rank: LEVELS[statusLevel(c.status)].rank,
      node: (
        <ConnectorRow key={`connector:${c.serverName}`} connector={c} onOpen={onOpenConnector} />
      ),
    })),
    ...items.map((item) => ({
      rank: LEVELS[levelOf(item.level)].rank,
      node: <FacetRow key={`${item.app}/${item.facet}`} item={item} onOpen={onOpen} />,
    })),
  ].sort((a, b) => a.rank - b.rank);

  return (
    <section data-testid="workspace-briefing">
      {loading ? (
        <Skeleton />
      ) : (
        <>
          {rows.length > 0 && <ul>{rows.map((row) => row.node)}</ul>}

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
