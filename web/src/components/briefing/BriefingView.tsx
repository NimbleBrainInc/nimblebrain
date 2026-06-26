// ---------------------------------------------------------------------------
// BriefingView — presentational render of a workspace activity briefing.
//
// Pure: it takes a `BriefingOutput` (the `nb__briefing` tool's structured
// result) plus loading/error/action callbacks and renders. No data fetching,
// no transport — the workspace dashboard wires it to `useWorkspaceBriefing`,
// and the future home control panel can reuse it against a cross-workspace
// source. The briefing is LLM-generated from each installed app's declared
// facets; this component is the surface the workspace reorg dropped.
// ---------------------------------------------------------------------------

import type { ReactNode } from "react";
import type {
  BriefingAction,
  BriefingOutput,
  BriefingSection,
} from "../../_generated/platform-schemas/home";
import { cn } from "../../lib/utils";

interface BriefingViewProps {
  briefing: BriefingOutput | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** Invoked when a section's action is clicked (navigate / startChat). */
  onAction?: (action: BriefingAction) => void;
}

// Render order: anything needing attention first, then what happened, then
// what's ahead.
const CATEGORIES: { key: BriefingSection["category"]; label: string }[] = [
  { key: "attention", label: "Needs attention" },
  { key: "recent", label: "Recent" },
  { key: "upcoming", label: "Coming up" },
];

/** Sentiment → dot color. Positive reads calm, warning reads urgent. */
function dotClass(type: BriefingSection["type"]): string {
  if (type === "positive") return "bg-emerald-500";
  if (type === "warning") return "bg-red-500";
  return "bg-amber-500";
}

/**
 * Minimal inline markdown — `**bold**` and `` `code` `` — rendered as React
 * nodes, never injected HTML. Briefing text is platform-generated, but we
 * still render structurally so there's no `dangerouslySetInnerHTML` surface.
 */
function formatInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith("**")) {
      out.push(
        <strong key={key++} className="font-semibold text-foreground">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      out.push(
        <code key={key++} className="rounded bg-muted px-1 py-0.5 text-[0.85em] font-mono">
          {token.slice(1, -1)}
        </code>,
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Eyebrow() {
  return (
    <div className="text-2xs font-bold tracking-[0.08em] uppercase text-muted-foreground">
      Briefing
    </div>
  );
}

function Skeleton() {
  return (
    <div className="mt-3 space-y-2.5" aria-hidden>
      <div className="h-3 w-2/3 rounded bg-muted-foreground/20 animate-pulse" />
      <div className="h-3 w-1/2 rounded bg-muted-foreground/20 animate-pulse" />
      <div className="h-3 w-3/5 rounded bg-muted-foreground/20 animate-pulse" />
    </div>
  );
}

function SectionGroup({
  label,
  items,
  onAction,
}: {
  label: string;
  items: BriefingSection[];
  onAction?: (action: BriefingAction) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-4 first:mt-3">
      <div className="text-2xs font-semibold tracking-[0.06em] uppercase text-muted-foreground/60">
        {label}
      </div>
      <ul className="mt-1.5 space-y-1.5">
        {items.map((item) => (
          <li key={item.id} className="flex items-start gap-2.5 text-sm text-foreground/80">
            <span
              className={cn("mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full", dotClass(item.type))}
              aria-hidden
            />
            <span className="flex-1 leading-relaxed">{formatInline(item.text)}</span>
            {/* v1 renders navigate actions (router-routable). `startChat`
                actions need the chat composer, which a shell page can't reach
                without subscribing to ChatContext (re-renders the shell every
                token); they render as text-only until an isolated handler
                lands. */}
            {item.action?.type === "navigate" && onAction && (
              <button
                type="button"
                onClick={() => onAction(item.action!)}
                className="shrink-0 text-xs font-medium text-primary hover:underline"
              >
                {item.action.label || "View"} &rarr;
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function BriefingView({ briefing, loading, error, onRetry, onAction }: BriefingViewProps) {
  const hasSections = (briefing?.sections.length ?? 0) > 0;

  return (
    <section data-testid="workspace-briefing">
      <Eyebrow />

      {loading && !briefing && <Skeleton />}

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

      {briefing && (
        <>
          {briefing.lede && (
            <p className="mt-1.5 text-sm text-muted-foreground italic leading-relaxed">
              {briefing.lede}
            </p>
          )}
          {hasSections ? (
            CATEGORIES.map(({ key, label }) => (
              <SectionGroup
                key={key}
                label={label}
                items={briefing.sections.filter((s) => s.category === key)}
                onAction={onAction}
              />
            ))
          ) : (
            <p
              className="mt-2 text-sm text-muted-foreground"
              data-testid="workspace-briefing-empty"
            >
              Nothing needs your attention right now.
            </p>
          )}
        </>
      )}
    </section>
  );
}
