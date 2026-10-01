/**
 * Pinned workspaces: the ones a viewer keeps at the top of the sidebar and the
 * home grid.
 *
 * Stored in `localStorage` because a pin is a viewer's convenience, not
 * workspace state: it is never sent to the server, differs per browser, and
 * losing it only puts the workspace back in alphabetical order. Ids that no
 * longer name one of the viewer's workspaces are harmless; ordering ignores
 * them.
 *
 * One store backs every surface, so pinning in the sidebar reorders the home
 * grid at once, and a `storage` event carries a pin to the viewer's other tabs.
 */

import { useCallback, useSyncExternalStore } from "react";

const KEY = "nb:pinned-workspaces";
const EMPTY: ReadonlySet<string> = new Set();

const listeners = new Set<() => void>();
// useSyncExternalStore needs a stable snapshot between changes, so the parsed
// set is cached and replaced only when the stored value changes.
let cache: { raw: string | null; set: ReadonlySet<string> } | null = null;

function readRaw(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    // localStorage can throw in private-mode / sandboxed contexts.
    return null;
  }
}

function parse(raw: string | null): ReadonlySet<string> {
  if (!raw) return EMPTY;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY;
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return EMPTY;
  }
}

export function getPinnedWorkspaces(): ReadonlySet<string> {
  const raw = readRaw();
  if (cache?.raw !== raw) cache = { raw, set: parse(raw) };
  return cache.set;
}

export function togglePinnedWorkspace(workspaceId: string): void {
  const next = new Set(getPinnedWorkspaces());
  if (next.has(workspaceId)) next.delete(workspaceId);
  else next.add(workspaceId);
  try {
    if (next.size === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify([...next]));
  } catch {
    // Best-effort: a pin that does not persist only leaves the order alphabetical.
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY || e.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function usePinnedWorkspaces(): {
  pinned: ReadonlySet<string>;
  toggle: (workspaceId: string) => void;
} {
  const pinned = useSyncExternalStore(subscribe, getPinnedWorkspaces, () => EMPTY);
  const toggle = useCallback((workspaceId: string) => togglePinnedWorkspace(workspaceId), []);
  return { pinned, toggle };
}
