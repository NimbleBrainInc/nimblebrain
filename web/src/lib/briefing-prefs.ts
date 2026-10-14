/**
 * Per-browser view preferences for a workspace's summary panel: which rows the
 * member hid, and whether the panel is collapsed.
 *
 * Stored in `localStorage` because they are a viewer's convenience, not
 * workspace state: they are never sent to the server, differ per browser, and
 * losing them only shows the rows again.
 *
 * A hidden row stays hidden only while it is unchanged. Each entry records what
 * the row said when it was hidden (a facet's count, a connector's status), and
 * `isHidden` shows the row again as soon as it says something new, so hiding
 * "2 Tasks blocked" never hides the third.
 */

export interface BriefingPrefs {
  /** Row key → what the row said when it was hidden. */
  hidden: Record<string, string>;
  collapsed: boolean;
}

const EMPTY: BriefingPrefs = { hidden: {}, collapsed: false };

function key(workspaceId: string): string {
  return `nb:briefing:${workspaceId}`;
}

export function loadBriefingPrefs(workspaceId: string): BriefingPrefs {
  try {
    const raw = localStorage.getItem(key(workspaceId));
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return EMPTY;
    const { hidden, collapsed } = parsed as Partial<BriefingPrefs>;
    const clean: Record<string, string> = {};
    if (typeof hidden === "object" && hidden !== null) {
      for (const [k, v] of Object.entries(hidden)) if (typeof v === "string") clean[k] = v;
    }
    return { hidden: clean, collapsed: collapsed === true };
  } catch {
    // localStorage can throw in private-mode / sandboxed contexts, or hold junk.
    return EMPTY;
  }
}

export function saveBriefingPrefs(workspaceId: string, prefs: BriefingPrefs): void {
  try {
    if (Object.keys(prefs.hidden).length === 0 && !prefs.collapsed) {
      localStorage.removeItem(key(workspaceId));
    } else {
      localStorage.setItem(key(workspaceId), JSON.stringify(prefs));
    }
  } catch {
    // Best-effort: a preference that does not persist only shows the rows again.
  }
}

/**
 * Whether a row is hidden: it was hidden, and still says what it said then.
 *
 * `signature` is what the row says now. A facet's is `ok:<count>` or
 * `unavailable`, and a count at or below the hidden one stays hidden, so
 * progress does not bring a row back but new work does. A connector's is its
 * status, and any change brings it back.
 */
export function isHidden(prefs: BriefingPrefs, rowKey: string, signature: string): boolean {
  const was = prefs.hidden[rowKey];
  if (was === undefined) return false;
  if (was === signature) return true;
  const count = (s: string) => (s.startsWith("ok:") ? Number(s.slice(3)) : Number.NaN);
  return count(signature) <= count(was);
}
