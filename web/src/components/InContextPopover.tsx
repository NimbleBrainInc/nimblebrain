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
import { formatTokenCount, SCOPE_CLASS, shortSkillName } from "../lib/skill-display";
import { parseToolResponse } from "../lib/tool-response";
import { toSlug } from "../lib/workspace-slug";

/**
 * Header affordance — the aggregated projection of the Context Ledger. Answers
 * "what is equipping this conversation, and where did the tokens go" in one
 * place: the per-source budget for the latest turn (system prompt, tools,
 * skills, history), the skills loaded, and (once the memory seed channel ships)
 * the records seeded at session start.
 *
 * Reads `compose.assembled_context` on every open (cheap; one tool call against
 * the recorded run telemetry) so the panel reflects the latest turn without
 * subscribing to events. One read powers both the budget and the skills
 * section — same run, one source of truth. The Memory section is dormant until
 * the memory seed channel ships.
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

  // Memory placeholder — always empty until the seed channel ships. Kept as an
  // array so the section populates data-only when memory wiring lands.
  const memory: never[] = [];

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
                <SectionHeader title="Budget" note="this turn" />
                <BudgetSection sources={digest.sources} totalTokens={digest.totalTokens} />

                <SectionHeader title="Skills" note="this turn" />
                {digest.skills.length === 0 ? (
                  <Empty>No skills loaded for this turn.</Empty>
                ) : (
                  <ul>
                    {digest.skills.map((s) => (
                      <li key={s.id} className="ledger-line__row">
                        <span className="ledger-line__dot" aria-hidden />
                        <span className="ledger-line__row-name">{shortSkillName(s.id)}</span>
                        <span className={`ledger-line__scope ${SCOPE_CLASS[s.scope]}`}>
                          {s.scope}
                        </span>
                        <span className="ledger-line__row-tok">
                          {formatTokenCount(s.tokens)} tok
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                <SectionHeader title="Memory" note="since start" />
                {memory.length === 0 && <Empty>Nothing seeded</Empty>}
              </>
            )}
          </div>

          {inspectorPath && (
            <div className="px-3.5 py-2 border-t flex items-center justify-end">
              <Link
                to={inspectorPath}
                className="text-2xs font-medium text-foreground hover:text-warm"
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

/** Order + human labels for the recorded context sources. */
const SOURCE_ORDER = ["system_prompt", "tool_descriptions", "skills", "history"];
const SOURCE_LABEL: Record<string, string> = {
  system_prompt: "System prompt",
  tool_descriptions: "Tools",
  skills: "Skills",
  history: "History",
};

/** Count / turns / compacted detail suffix for a source row. */
function sourceDetail(s: AssembledContextSource): string {
  const parts: string[] = [];
  if (typeof s.count === "number") parts.push(`${s.count}`);
  if (typeof s.turns === "number") parts.push(`${s.turns} turn${s.turns === 1 ? "" : "s"}`);
  if (s.compacted) parts.push("compacted");
  return parts.join(" · ");
}

/** Per-source token breakdown for the latest turn, with proportional bars. */
function BudgetSection({
  sources,
  totalTokens,
}: {
  sources: AssembledContextSource[];
  totalTokens: number;
}) {
  const rank = (kind: string) => {
    const i = SOURCE_ORDER.indexOf(kind);
    return i === -1 ? SOURCE_ORDER.length : i;
  };
  const ordered = [...sources].sort((a, b) => rank(a.kind) - rank(b.kind));
  const max = Math.max(totalTokens, 1);
  return (
    <div className="px-3.5 py-1.5 space-y-1">
      {ordered.map((s) => {
        const detail = sourceDetail(s);
        return (
          <div key={s.kind} className="flex items-center gap-2">
            <span className="text-xs flex-1 min-w-0 truncate">
              {SOURCE_LABEL[s.kind] ?? s.kind}
              {detail && <span className="text-3xs text-muted-foreground"> {detail}</span>}
            </span>
            <span className="h-1 w-14 rounded-full bg-muted overflow-hidden shrink-0">
              <span
                className="block h-full rounded-full bg-muted-foreground/45"
                style={{ width: `${Math.round((s.tokens / max) * 100)}%` }}
              />
            </span>
            <span className="text-3xs text-muted-foreground tabular-nums w-10 text-right shrink-0">
              {formatTokenCount(s.tokens)}
            </span>
          </div>
        );
      })}
      <div className="flex items-baseline justify-between border-t pt-1 mt-0.5">
        <span className="text-xs font-medium">Total</span>
        <span className="text-2xs font-medium tabular-nums">
          {formatTokenCount(totalTokens)} tok
        </span>
      </div>
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
