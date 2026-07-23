import { Layers } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
// Canonical shapes from `src/tools/platform/schemas/skills.ts`; mirrored
// here via codegen so server + web can't drift.
import type {
  ActiveSkillEntry as ActiveSkill,
  SkillsActiveForOutput,
} from "../_generated/platform-schemas/skills";
import { callTool } from "../api/client";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import { formatTokenCount, SCOPE_CLASS, shortSkillName } from "../lib/skill-display";
import { parseToolResponse } from "../lib/tool-response";
import { toSlug } from "../lib/workspace-slug";

/**
 * Header affordance — the aggregated projection of the Context Ledger. Answers
 * "what is equipping this conversation" in one place: the skills loaded for the
 * latest turn, and (once the memory seed channel ships) the records seeded at
 * session start. Two honestly-different categories under one roof, each row in
 * the same grammar as the in-transcript ledger drawer.
 *
 * Reads `skills.active_for` on every open (cheap; one tool call against an
 * in-memory log) so the panel reflects the latest turn without subscribing to
 * events. The Memory section is dormant until the memory seed channel ships —
 * rendered from a generic ledger-entry array so wiring it later is data-only.
 */
export function InContextPopover({ conversationId }: { conversationId: string | null }) {
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<ActiveSkill[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { activeWorkspace } = useWorkspaceContext();
  // Skills are workspace-scoped; "Manage" targets the focused workspace.
  const skillsPath = activeWorkspace ? `/w/${toSlug(activeWorkspace.id)}/settings/skills` : "/";

  // Memory placeholder — always empty until the seed channel ships. Kept as an
  // array so the section populates data-only when memory wiring lands.
  const memory: never[] = [];

  const refresh = useCallback(async () => {
    if (!conversationId) {
      setSkills([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await callTool("skills", "active_for", { conversation_id: conversationId });
      const data = parseToolResponse<SkillsActiveForOutput>(res);
      setSkills(data.active);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load active skills.";
      setError(msg);
      setSkills(null);
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
            <SectionHeader title="Skills" note="this turn" />
            {!conversationId && <Empty>Start a conversation to see which skills load.</Empty>}
            {conversationId && loading && (
              <div className="px-3.5 py-3 text-xs text-muted-foreground">Loading…</div>
            )}
            {conversationId && error && (
              <div className="px-3.5 py-3 text-xs text-destructive">{error}</div>
            )}
            {conversationId && !loading && !error && skills && skills.length === 0 && (
              <Empty>No skills loaded yet. Send a message to populate the log.</Empty>
            )}
            {conversationId && !loading && !error && skills && skills.length > 0 && (
              <ul>
                {skills.map((s) => (
                  <li key={s.id} className="ledger-line__row">
                    <span className="ledger-line__dot" aria-hidden />
                    <span className="ledger-line__row-name">{shortSkillName(s.id)}</span>
                    <span className={`ledger-line__scope ${SCOPE_CLASS[s.scope]}`}>{s.scope}</span>
                    <span className="ledger-line__row-tok">{formatTokenCount(s.tokens)} tok</span>
                  </li>
                ))}
              </ul>
            )}

            <SectionHeader title="Memory" note="since start" />
            {memory.length === 0 && <Empty>Nothing seeded</Empty>}
          </div>

          <div className="px-3.5 py-2 border-t flex items-center justify-end">
            <Link
              to={skillsPath}
              className="text-2xs text-muted-foreground hover:text-foreground"
              onClick={() => setOpen(false)}
            >
              Manage skills ↗
            </Link>
          </div>
        </div>
      )}
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
