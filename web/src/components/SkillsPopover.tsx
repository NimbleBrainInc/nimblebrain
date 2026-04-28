import { Lightbulb } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { callTool } from "../api/client";
import { parseToolResponse } from "../lib/tool-response";

// ── Types ────────────────────────────────────────────────────────────────

interface ActiveSkill {
  id: string;
  layer: 3;
  scope: "platform" | "workspace" | "user" | "bundle";
  tokens: number;
  loadedBy: "always" | "tool_affinity";
  reason: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function shortName(id: string): string {
  // Filesystem ids end in /<name>.md; URI ids look like skill://owner/<name>.
  const slash = id.lastIndexOf("/");
  const tail = slash >= 0 ? id.slice(slash + 1) : id;
  return tail.replace(/\.md$/, "");
}

const SCOPE_COLOR: Record<ActiveSkill["scope"], string> = {
  platform: "text-blue-400",
  workspace: "text-emerald-400",
  user: "text-violet-400",
  bundle: "text-amber-400",
};

// ── Component ────────────────────────────────────────────────────────────

/**
 * Header affordance that shows which Layer 3 skills loaded for the active
 * conversation's most recent turn. Closes the operator-side visibility loop
 * for the per-conversation question — the Skills tab in /settings answers
 * "what skills exist" globally.
 *
 * Reads on every open (cheap; one tool call against an in-memory log) so
 * the panel reflects the latest turn without subscribing to events.
 */
export function SkillsPopover({ conversationId }: { conversationId: string | null }) {
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<ActiveSkill[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(async () => {
    if (!conversationId) {
      setSkills([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await callTool("skills", "active_for", { conversation_id: conversationId });
      const data = parseToolResponse<{ active: ActiveSkill[] }>(res);
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
        aria-label="Active skills"
        aria-expanded={open}
        title="Skills loaded for this conversation"
        className="p-1.5 hover:bg-muted rounded-lg transition-all text-muted-foreground hover:text-foreground"
      >
        <Lightbulb style={{ width: 16, height: 16 }} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-80 rounded-md border bg-popover text-popover-foreground shadow-md">
          <div className="px-3 py-2 border-b flex items-center justify-between">
            <div className="text-xs font-semibold">Active skills</div>
            <Link
              to="/settings/workspace/skills"
              className="text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => setOpen(false)}
            >
              Manage →
            </Link>
          </div>

          <div className="max-h-80 overflow-auto py-1">
            {!conversationId && <Empty>Start a conversation to see which skills load.</Empty>}
            {conversationId && loading && (
              <div className="px-3 py-3 text-xs text-muted-foreground">Loading…</div>
            )}
            {conversationId && error && (
              <div className="px-3 py-3 text-xs text-destructive">{error}</div>
            )}
            {conversationId && !loading && !error && skills && skills.length === 0 && (
              <Empty>
                No skills loaded yet for this conversation. Send a message to populate the log.
              </Empty>
            )}
            {conversationId && !loading && !error && skills && skills.length > 0 && (
              <ul className="divide-y">
                {skills.map((s) => (
                  <li key={s.id} className="px-3 py-2 space-y-0.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-medium truncate">{shortName(s.id)}</span>
                      <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                        {s.tokens} tok
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                      <span className={SCOPE_COLOR[s.scope]}>{s.scope}</span>
                      <span>·</span>
                      <span>loaded: {s.loadedBy}</span>
                    </div>
                    <div className="text-[10px] text-muted-foreground/80 truncate" title={s.reason}>
                      {s.reason}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-3 py-4 text-xs text-muted-foreground">{children}</div>;
}
