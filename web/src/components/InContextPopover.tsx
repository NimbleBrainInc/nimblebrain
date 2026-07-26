import { Layers } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
// Canonical shapes from `src/tools/platform/schemas/compose.ts`; mirrored
// here via codegen so server + web can't drift.
import type {
  AssembledContextSource,
  ComposeAssembledContextOutput,
} from "../_generated/platform-schemas/compose";
import { callTool } from "../api/client";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import {
  SOURCE_LABEL,
  skillsSlice,
  sourceDetail,
  windowSources,
  windowTokens,
} from "../lib/context-sources";
import {
  formatTokenCount,
  groupByMechanism,
  SCOPE_CLASS,
  skillProvenanceLabel,
} from "../lib/skill-display";
import { parseToolResponse } from "../lib/tool-response";
import { toSlug } from "../lib/workspace-slug";

/**
 * Header affordance — the aggregated projection of the Context Ledger. Answers
 * "what is equipping this conversation, and where did the tokens go" in one
 * place: what occupies the context window this turn (system prompt, tools,
 * history) and which skills the runtime composed, grouped by why they loaded.
 *
 * Reads `compose.assembled_context` on every open (cheap; one tool call against
 * the recorded run telemetry) so the panel reflects the latest turn without
 * subscribing to events. One read powers both sections — same run, one source
 * of truth.
 *
 * A Memory section belongs here once the seed channel ships; it is absent
 * rather than empty until then, because a permanent "Nothing seeded" is chrome
 * that never resolves.
 */
export function InContextPopover({ conversationId }: { conversationId: string | null }) {
  const [open, setOpen] = useState(false);
  const [digest, setDigest] = useState<ComposeAssembledContextOutput | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { activeWorkspace } = useWorkspaceContext();
  // "Open full view" routes into the full-page inspector for this conversation,
  // in the main content area beside the docked chat. Skill management lives
  // there (the inspector) rather than cluttering this triage popover.
  const inspectorPath =
    activeWorkspace && conversationId
      ? `/w/${toSlug(activeWorkspace.id)}/context/${conversationId}`
      : null;

  const refresh = useCallback(async () => {
    if (!conversationId) {
      setDigest(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await callTool("compose", "assembled_context", {
        conversation_id: conversationId,
      });
      setDigest(parseToolResponse<ComposeAssembledContextOutput>(res));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load context.";
      setError(msg);
      setDigest(null);
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  // Refresh on open and whenever the conversation changes.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const hasRun = digest !== null && digest.runId !== null;

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        type="button"
        aria-label="In context"
        aria-expanded={open}
        title="What's equipping this conversation"
        className="p-1.5 hover:bg-muted rounded-sm transition-all text-muted-foreground hover:text-foreground"
      >
        <Layers style={{ width: 16, height: 16 }} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-80 rounded-sm border bg-popover text-popover-foreground shadow-md overflow-hidden">
          <div className="px-3.5 py-2.5 border-b">
            <p className="text-sm font-semibold">In context</p>
            <p className="text-2xs text-muted-foreground mt-0.5">
              What's equipping this conversation
            </p>
          </div>

          <div className="max-h-96 overflow-auto">
            {!conversationId && <Empty>Start a conversation to see what loads.</Empty>}
            {conversationId && loading && (
              <div className="px-3.5 py-3 text-xs text-muted-foreground">Loading…</div>
            )}
            {conversationId && error && (
              <div className="px-3.5 py-3 text-xs text-destructive">{error}</div>
            )}
            {conversationId && !loading && !error && digest && !hasRun && (
              <Empty>No context yet. Send a message to populate this turn.</Empty>
            )}

            {conversationId && !loading && !error && hasRun && digest && (
              <>
                <SectionHeader title="Context window" note="this turn" />
                <BudgetSection sources={digest.sources} />

                <SectionHeader title="Skills" note={`${digest.skills.length} this turn`} />
                {digest.skills.length === 0 ? (
                  <Empty>No skills loaded for this turn.</Empty>
                ) : (
                  groupByMechanism(digest.skills).map((group) => (
                    <div key={group.mechanism}>
                      <p className="px-3.5 pt-1.5 pb-0.5 m-0 text-2xs text-muted-foreground">
                        {group.label}
                      </p>
                      <ul>
                        {group.skills.map((s) => (
                          <li key={s.id} className="ledger-line__row" title={s.reason}>
                            <span className="ledger-line__dot" aria-hidden />
                            <span className="ledger-line__row-name">{s.name}</span>
                            <span className={`ledger-line__scope ${SCOPE_CLASS[s.scope]}`}>
                              {skillProvenanceLabel(s)}
                            </span>
                            {/* Bare count, no `tok`: the window section above
                                already establishes the unit, and at this width
                                the row is carrying a name and a publisher. The
                                chat ledger's drawer keeps the suffix — it has no
                                budget above it to set the unit. */}
                            <span className="ledger-line__row-tok">
                              {formatTokenCount(s.tokens)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))
                )}
              </>
            )}
          </div>

          {inspectorPath && (
            <div className="px-3.5 py-2 border-t flex items-center justify-end">
              <Link
                to={inspectorPath}
                className="text-2xs font-medium text-foreground hover:text-primary"
                onClick={() => setOpen(false)}
              >
                Open full view ↗
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * What occupies the context window this turn, with proportional bars.
 *
 * Three rows, because the window has three disjoint regions. The recorded
 * `skills` row is not a fourth — it measures how much of the system prompt the
 * composed skill bodies account for — so it renders indented beneath system
 * prompt as an "of which", and the total below is the disjoint sum. Rendering
 * all four as peers over a summed total (what this did) both overstated the
 * window and taught that skills sit outside the prompt.
 */
function BudgetSection({ sources }: { sources: AssembledContextSource[] }) {
  const rows = windowSources(sources);
  const skills = skillsSlice(sources);
  const total = windowTokens(sources);
  const max = Math.max(total, 1);
  const width = (tokens: number) => `${Math.round((tokens / max) * 100)}%`;
  return (
    <div className="px-3.5 py-1.5 space-y-1">
      {rows.map((s) => {
        const detail = sourceDetail(s);
        return (
          <div key={s.kind}>
            <BudgetRow
              label={SOURCE_LABEL[s.kind] ?? s.kind}
              detail={detail}
              tokens={s.tokens}
              width={width(s.tokens)}
            />
            {s.kind === "system_prompt" && skills && (
              <BudgetRow
                nested
                label="of which skills"
                detail={sourceDetail(skills)}
                tokens={skills.tokens}
                width={width(skills.tokens)}
              />
            )}
          </div>
        );
      })}
      <div className="flex items-baseline justify-between border-t pt-1 mt-0.5">
        <span className="text-xs font-medium">In the window</span>
        <span className="text-2xs font-medium tabular-nums">{formatTokenCount(total)} tok</span>
      </div>
    </div>
  );
}

/** One budget line: label, proportional bar, token count. */
function BudgetRow({
  label,
  detail,
  tokens,
  width,
  nested = false,
}: {
  label: string;
  detail: string;
  tokens: number;
  width: string;
  nested?: boolean;
}) {
  return (
    <div className={`flex items-center gap-2${nested ? " pl-3" : ""}`}>
      <span
        className={`flex-1 min-w-0 truncate ${nested ? "text-2xs text-muted-foreground" : "text-xs"}`}
      >
        {label}
        {detail && <span className="text-3xs text-muted-foreground"> {detail}</span>}
      </span>
      <span className="h-1 w-14 rounded-full bg-muted overflow-hidden shrink-0">
        <span
          className={`block h-full rounded-full ${nested ? "bg-muted-foreground/25" : "bg-muted-foreground/45"}`}
          style={{ width }}
        />
      </span>
      <span className="text-3xs text-muted-foreground tabular-nums w-10 text-right shrink-0">
        {formatTokenCount(tokens)}
      </span>
    </div>
  );
}

function SectionHeader({ title, note }: { title: string; note: string }) {
  return (
    <div className="px-3.5 pt-2.5 pb-1 flex items-baseline gap-1.5 text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
      {title}
      <small className="font-normal normal-case tracking-normal text-2xs">· {note}</small>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-3.5 py-2.5 text-xs text-muted-foreground">{children}</div>;
}
