// ---------------------------------------------------------------------------
// BriefingView — presentational render of a workspace's open counts.
//
// Pure: it takes a `BriefingOutput` (the `nb__briefing` tool's structured
// result) plus error/open callbacks and renders. No data fetching, no
// transport — the workspace dashboard wires it to `useWorkspaceBriefing`.
// Each item is a count an app's server reported through the
// `ai.nimblebrain/facets` extension; label and count are untrusted server data
// and render as text.
// ---------------------------------------------------------------------------

import type { BriefingItem, BriefingOutput } from "../../_generated/platform-schemas/home";

interface BriefingViewProps {
  briefing: BriefingOutput | null;
  error: string | null;
  onRetry: () => void;
  /** Invoked with an item's app route when it is clicked. */
  onOpen?: (route: string) => void;
}

function Eyebrow() {
  return (
    <div className="text-2xs font-bold tracking-[0.08em] uppercase text-muted-foreground">
      Briefing
    </div>
  );
}

function ItemRow({ item, onOpen }: { item: BriefingItem; onOpen?: (route: string) => void }) {
  const unavailable = item.state === "unavailable";
  return (
    <li className="flex items-start gap-2.5 text-sm text-foreground/80">
      <span className="flex-1 leading-relaxed">
        {unavailable ? (
          <span className="text-muted-foreground">{item.label} — unavailable</span>
        ) : (
          <>
            <span className="font-semibold text-foreground">{item.count}</span> {item.label}
          </>
        )}
        <span className="text-muted-foreground"> · {item.app}</span>
      </span>
      {item.route && onOpen && (
        <button
          type="button"
          onClick={() => onOpen(item.route!)}
          className="shrink-0 text-xs font-medium text-primary hover:underline"
        >
          Open &rarr;
        </button>
      )}
    </li>
  );
}

export function BriefingView({ briefing, error, onRetry, onOpen }: BriefingViewProps) {
  // Nothing is waiting in any app: there is nothing to show.
  if (!error && (!briefing || briefing.items.length === 0)) return null;

  return (
    <section data-testid="workspace-briefing">
      <Eyebrow />

      {error && (
        <div
          className="mt-3 rounded-sm border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive"
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

      {briefing && briefing.items.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {briefing.items.map((item) => (
            <ItemRow key={`${item.app}/${item.facet}`} item={item} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </section>
  );
}
