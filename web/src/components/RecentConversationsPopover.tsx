import { History } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { callTool } from "../api/client";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import { parseToolResponse } from "../lib/tool-response";
import { toSlug } from "../lib/workspace-slug";

// Mirror of the fields this popover reads from the `conversations__list`
// result (server shape: ListResult / IndexEntry in
// src/bundles/conversations/src/index-cache.ts). The web package can't import
// server types, and only tool *inputs* are codegen'd, so the read shape is
// declared locally — the same approach the Conversations bundle UI takes.
interface RecentConversation {
  id: string;
  title: string | null;
  preview: string;
  updatedAt: string;
}
interface RecentListResult {
  conversations: RecentConversation[];
}

const RECENT_LIMIT = 10;

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const min = 60_000;
  const hr = 3_600_000;
  const day = 86_400_000;
  if (diff < min) return "now";
  if (diff < hr) return `${Math.floor(diff / min)}m`;
  if (diff < day) return `${Math.floor(diff / hr)}h`;
  if (diff < 2 * day) return "Yst";
  if (diff < 7 * day) return new Date(then).toLocaleDateString(undefined, { weekday: "short" });
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Header affordance that surfaces the most recent conversations without
 * leaving the chat panel. Mirrors {@link SkillsPopover}: a header icon that
 * opens a popover backed by a tool call (`conversations__list`). Clicking a
 * row reopens it in the same panel via the parent's `onOpen` (→
 * `loadConversation`). "View all" hands off to the full Conversations app for
 * search and older history.
 *
 * Reads on every open (cheap; one workspace-scoped list) so the popover
 * reflects the latest turn without subscribing to events.
 */
export function RecentConversationsPopover({
  activeConversationId,
  onOpen,
}: {
  activeConversationId: string | null;
  onOpen: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [conversations, setConversations] = useState<RecentConversation[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { activeWorkspace } = useWorkspaceContext();
  // Conversations are workspace-scoped; scope to the focused workspace and
  // point "View all" at that workspace's Conversations app.
  const allPath = activeWorkspace ? `/w/${toSlug(activeWorkspace.id)}/conversations` : "/";

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await callTool("conversations", "list", {
        limit: RECENT_LIMIT,
        sortBy: "updated",
        ...(activeWorkspace ? { workspaceId: activeWorkspace.id } : {}),
      });
      const data = parseToolResponse<RecentListResult>(res);
      setConversations(data.conversations);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load conversations.";
      setError(msg);
      setConversations(null);
    } finally {
      setLoading(false);
    }
  }, [activeWorkspace]);

  // Refresh on open and whenever the focused workspace changes.
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

  const handleOpen = useCallback(
    (id: string) => {
      setOpen(false);
      onOpen(id);
    },
    [onOpen],
  );

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        type="button"
        aria-label="Recent conversations"
        aria-expanded={open}
        title="Recent conversations"
        className={`p-1.5 rounded-sm transition-all ${
          open
            ? "bg-warm/10 text-warm"
            : "hover:bg-muted text-muted-foreground hover:text-foreground"
        }`}
      >
        <History style={{ width: 16, height: 16 }} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-80 rounded-sm border bg-popover text-popover-foreground shadow-md">
          <div className="px-3 py-2 border-b flex items-center justify-between">
            <div className="text-xs font-semibold">Recent</div>
            <Link
              to={allPath}
              className="text-2xs text-muted-foreground hover:text-foreground"
              onClick={() => setOpen(false)}
            >
              View all →
            </Link>
          </div>

          <div className="max-h-80 overflow-auto py-1">
            {loading && <div className="px-3 py-3 text-xs text-muted-foreground">Loading…</div>}
            {error && <div className="px-3 py-3 text-xs text-destructive">{error}</div>}
            {!loading && !error && conversations && conversations.length === 0 && (
              <div className="px-3 py-4 text-xs text-muted-foreground">
                No conversations yet. Start one and it'll show up here.
              </div>
            )}
            {!loading && !error && conversations && conversations.length > 0 && (
              <ul className="divide-y">
                {conversations.map((c) => {
                  const isActive = c.id === activeConversationId;
                  const title = c.title?.trim() || c.preview?.trim() || "Untitled";
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => handleOpen(c.id)}
                        className={`w-full text-left px-3 py-2 space-y-0.5 transition-colors ${
                          isActive ? "bg-muted" : "hover:bg-muted"
                        }`}
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-xs font-medium truncate flex items-center gap-1.5">
                            {isActive && (
                              <span
                                className="shrink-0 w-1.5 h-1.5 rounded-full bg-warm"
                                aria-hidden
                              />
                            )}
                            {title}
                          </span>
                          <span className="text-3xs text-muted-foreground tabular-nums shrink-0">
                            {relativeTime(c.updatedAt)}
                          </span>
                        </div>
                        {c.preview.trim() && c.preview.trim() !== title && (
                          <div className="text-3xs text-muted-foreground/80 truncate">
                            {c.preview.trim()}
                          </div>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
