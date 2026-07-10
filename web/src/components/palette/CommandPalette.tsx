// ---------------------------------------------------------------------------
// CommandPalette — the ⌘P overlay.
//
// Mounts once at shell level (sibling of ChatChrome) so it's reachable from any
// route. Runs the enabled CommandSources against the query, renders grouped
// results, and maintains a single flat selection index across groups so ↑↓
// crosses group boundaries.
//
// Constraints honored:
//   - Shell component: consumes ChatPanelContext (stable), NEVER ChatContext
//     (streaming) — see AGENTS.md. The palette only ever toggles the panel.
//   - REST/in-memory data only (WorkspaceContext, ShellContext) — no bridge.
//   - Escape is handled capture-phase so it beats other Escape handlers (chat).
//
// A leading @ / # / > scopes the query to one source and is stripped from the
// matched term; the active scope shows as a chip in the input.
// ---------------------------------------------------------------------------

import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { useChatPanelContext } from "../../context/ChatPanelContext";
import { usePalette } from "../../context/PaletteContext";
import { useSession } from "../../context/SessionContext";
import { useShellContext } from "../../context/ShellContext";
import { useSidebar } from "../../context/SidebarContext";
import { useTheme } from "../../context/ThemeContext";
import { useWorkspaceAppIcons } from "../../context/WorkspaceAppIconsContext";
import { useWorkspaceContext } from "../../context/WorkspaceContext";
import { workspaceApps } from "../../lib/workspace-apps";
import { toSlug } from "../../lib/workspace-slug";
import { KeyboardShortcutsModal } from "../KeyboardShortcutsModal";
import { CommandRow } from "./CommandRow";
import { buildResultGroups, parseQuery, SCOPE_LABEL } from "./query";
import { actionsSource } from "./sources/actions";
import { appsSource } from "./sources/apps";
import { workspacesSource } from "./sources/workspaces";
import type { CommandItem, CommandRunContext, CommandSource, CommandSourceContext } from "./types";

// Source order is the render order of result groups.
const SOURCES: CommandSource[] = [workspacesSource, appsSource, actionsSource];

export function CommandPalette({ onLogout }: { onLogout: () => void }) {
  const { open, query, setQuery, closePalette } = usePalette();
  const wsCtx = useWorkspaceContext();
  const shell = useShellContext();
  const { iconFor } = useWorkspaceAppIcons();
  const session = useSession();
  const navigate = useNavigate();
  const isWorkspaceRoute = useLocation().pathname.startsWith("/w/");
  const chatPanel = useChatPanelContext();
  const sidebar = useSidebar();
  const theme = useTheme();

  const [selected, setSelected] = useState(0);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  // Read-only data the sources build from. Apps are gated on shell-readiness:
  // the shell holds one workspace's placements and lags a switch, so until it
  // catches up we pass [] rather than the previous workspace's apps.
  const sourceCtx = useMemo<CommandSourceContext>(() => {
    const activeId = wsCtx.activeWorkspace?.id;
    const ready = shell != null && shell.shellWorkspaceId === activeId;
    const apps = ready && shell ? workspaceApps(shell.forSlot("sidebar")) : [];
    return {
      workspaces: wsCtx.workspaces,
      activeWorkspaceId: activeId,
      activeWorkspaceName: wsCtx.activeWorkspace?.name,
      activeWorkspaceSlug: wsCtx.activeWorkspace ? toSlug(wsCtx.activeWorkspace.id) : undefined,
      apps,
      iconForApp: iconFor,
      orgRole: session?.user?.orgRole,
      isWorkspaceRoute,
    };
  }, [wsCtx.workspaces, wsCtx.activeWorkspace, shell, iconFor, session, isWorkspaceRoute]);

  // Imperative handles, assembled once. setShowShortcuts is stable, so this is
  // memoized cheaply.
  const runCtx = useMemo<CommandRunContext>(
    () => ({
      navigate,
      setActiveWorkspace: wsCtx.setActiveWorkspace,
      toggleChat: chatPanel.togglePanel,
      toggleSidebar: sidebar.toggle,
      toggleTheme: theme.toggle,
      openKeyboardShortcuts: () => setShowShortcuts(true),
      logout: onLogout,
      closePalette,
    }),
    [
      navigate,
      wsCtx.setActiveWorkspace,
      chatPanel.togglePanel,
      sidebar.toggle,
      theme.toggle,
      onLogout,
      closePalette,
    ],
  );

  const groups = useMemo(() => buildResultGroups(query, SOURCES, sourceCtx), [query, sourceCtx]);

  const flat = useMemo<CommandItem[]>(() => groups.flatMap((g) => g.items), [groups]);
  const { scopeId } = parseQuery(query);

  // Keep selection in range as results change.
  useEffect(() => {
    setSelected((s) => (flat.length === 0 ? 0 : Math.min(s, flat.length - 1)));
  }, [flat.length]);

  // Focus the input on open; restore focus to the prior element on close.
  useEffect(() => {
    if (open) {
      prevFocusRef.current = document.activeElement as HTMLElement | null;
      setSelected(0);
      // Defer to after portal mount.
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    prevFocusRef.current?.focus?.();
  }, [open]);

  // Escape closes, capture-phase so it preempts the chat panel's Escape.
  useEffect(() => {
    if (!open) return;
    function onKeyDownCapture(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        closePalette();
      }
    }
    document.addEventListener("keydown", onKeyDownCapture, { capture: true });
    return () => document.removeEventListener("keydown", onKeyDownCapture, { capture: true });
  }, [open, closePalette]);

  // Scroll the selected row into view.
  useEffect(() => {
    const item = flat[selected];
    if (!item) return;
    rowRefs.current.get(item.id)?.scrollIntoView({ block: "nearest" });
  }, [selected, flat]);

  const runItem = useCallback(
    (item: CommandItem) => {
      item.run(runCtx);
    },
    [runCtx],
  );

  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((s) => (flat.length === 0 ? 0 : (s + 1) % flat.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((s) => (flat.length === 0 ? 0 : (s - 1 + flat.length) % flat.length));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = flat[selected];
        if (item) runItem(item);
      } else if (e.key === "Tab") {
        // Focus trap: only the input is focusable; keep focus here.
        e.preventDefault();
      }
    },
    [flat, selected, runItem],
  );

  if (!open) {
    // Still render the shortcuts modal slot so an action that opened it before
    // closing the palette keeps it visible. (Palette closes immediately on the
    // action; the modal owns its own dismissal.)
    return showShortcuts ? (
      <KeyboardShortcutsModal isOpen={true} onClose={() => setShowShortcuts(false)} />
    ) : null;
  }

  const activeItemId = flat[selected]?.id;

  return createPortal(
    <>
      <div className="fixed inset-0 z-50 flex items-start justify-center">
        {/* Backdrop */}
        <button
          type="button"
          aria-label="Close command palette"
          tabIndex={-1}
          onClick={closePalette}
          className="absolute inset-0 bg-black/40 backdrop-blur-sm cursor-default"
        />

        {/* Palette */}
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          data-testid="command-palette"
          className="relative mt-[12vh] w-[min(580px,calc(100vw-2rem))] bg-card border border-border rounded-md shadow-2xl overflow-hidden animate-in"
        >
          {/* Input */}
          <div className="flex items-center gap-3 px-4 py-3.5 border-b border-border">
            <Search
              aria-hidden="true"
              className="text-muted-foreground"
              style={{ width: 18, height: 18 }}
            />
            <input
              ref={inputRef}
              // biome-ignore lint/a11y/noAutofocus: palette is a modal opened on demand
              autoFocus
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-listbox"
              aria-activedescendant={activeItemId ? `palette-opt-${activeItemId}` : undefined}
              value={query}
              placeholder="Search workspaces, apps, or run a command…"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onInputKeyDown}
              className="flex-1 bg-transparent border-0 outline-none text-base text-foreground placeholder:text-muted-foreground"
            />
            {scopeId && (
              <span
                data-testid="palette-scope"
                className="shrink-0 text-3xs font-mono px-1.5 py-0.5 rounded bg-accent text-accent-foreground border border-border"
              >
                {SCOPE_LABEL[scopeId]}
              </span>
            )}
          </div>

          {/* Results */}
          <div
            id="palette-listbox"
            role="listbox"
            aria-label="Results"
            className="max-h-[min(460px,55vh)] overflow-y-auto p-2"
          >
            {flat.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-muted-foreground">No results</div>
            ) : (
              groups.map((group) => (
                <div key={group.source.id} className="pb-1.5">
                  <div className="px-2.5 pt-2 pb-1 text-3xs font-mono uppercase tracking-[0.12em] text-muted-foreground">
                    {group.label}
                  </div>
                  {group.items.map((item) => {
                    const index = flat.indexOf(item);
                    return (
                      <div
                        key={item.id}
                        ref={(el) => {
                          if (el) {
                            const btn = el.querySelector("button");
                            if (btn) rowRefs.current.set(item.id, btn as HTMLButtonElement);
                          } else {
                            rowRefs.current.delete(item.id);
                          }
                        }}
                      >
                        <CommandRow
                          item={item}
                          selected={index === selected}
                          onSelect={() => runItem(item)}
                          onHover={() => setSelected(index)}
                        />
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center gap-3.5 px-3.5 py-2.5 border-t border-border bg-muted/50 text-3xs font-mono text-muted-foreground">
            <span>
              <Kbd>↑↓</Kbd> navigate
            </span>
            <span>
              <Kbd>↵</Kbd> select
            </span>
            <span className="ml-auto">
              <Kbd>esc</Kbd> close
            </span>
          </div>
        </div>
      </div>

      {showShortcuts && (
        <KeyboardShortcutsModal isOpen={true} onClose={() => setShowShortcuts(false)} />
      )}
    </>,
    document.body,
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="bg-card border border-border px-1.5 py-0.5 rounded text-foreground">
      {children}
    </kbd>
  );
}
