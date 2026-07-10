// ---------------------------------------------------------------------------
// Command palette — core types
//
// The palette is a registry of CommandSources. Each source (workspaces, apps,
// actions) implements one `getItems` method over a read-only context and
// returns ordered CommandItems. The container runs the enabled sources, scores
// their items against the query (see match.ts), and renders grouped results
// with a single flat selection index across groups.
//
// Two contexts keep the sources free of React hook wiring (so they're pure and
// unit-testable):
//   - CommandSourceContext: the read-only data a source needs to build items.
//   - CommandRunContext:     the imperative handles an item needs to act on
//                            Enter. Assembled once by the container from the
//                            hooks it consumes.
// ---------------------------------------------------------------------------

import type { WorkspaceInfo } from "../../context/WorkspaceContext";
import type { PlacementEntry } from "../../types";

export type SourceId = "workspaces" | "apps" | "actions";

/**
 * How a row's leading glyph is drawn. `letter` is a colored avatar (workspaces),
 * `lucide` names an icon (actions), `brand` is an app's brand icon URL with a
 * letter fallback (apps).
 */
export type CommandIcon =
  | { kind: "letter"; letter: string; color: string }
  | { kind: "lucide"; name: string }
  | { kind: "brand"; url?: string; fallbackLetter: string };

export interface CommandItem {
  /** Stable, unique within a single render. */
  id: string;
  sourceId: SourceId;
  /** Primary line. The match corpus (with `keywords`). */
  title: string;
  /** Mono sub-line, e.g. "clinician · 3 apps". */
  subtitle?: string;
  icon?: CommandIcon;
  /** Extra match terms beyond the title (e.g. server name, route). */
  keywords?: string[];
  /** Right-aligned tag, e.g. "@workspace", "#app", ">". */
  meta?: string;
  /** What Enter does. Receives the imperative context. */
  run: (ctx: CommandRunContext) => void;
}

/**
 * Imperative handles a result needs to act. Built once by the palette
 * container from the hooks it consumes, so individual sources never touch
 * React context directly.
 */
export interface CommandRunContext {
  navigate: (to: string) => void;
  setActiveWorkspace: (ws: WorkspaceInfo) => void;
  toggleChat: () => void;
  toggleSidebar: () => void;
  toggleTheme: () => void;
  openKeyboardShortcuts: () => void;
  logout: () => void;
  /** Close the palette. Most `run`s call this last. */
  closePalette: () => void;
}

/**
 * Read-only data a source needs to build its items. Assembled by the container
 * from the data contexts. Sources must not fetch — everything they need is
 * here, already loaded.
 */
export interface CommandSourceContext {
  workspaces: WorkspaceInfo[];
  activeWorkspaceId?: string;
  activeWorkspaceName?: string;
  /** URL slug for the focused workspace (toSlug(id)), when one is focused. */
  activeWorkspaceSlug?: string;
  /**
   * The focused workspace's app placements (already filtered via
   * `workspaceApps`), or an empty array when the shell hasn't caught up to a
   * workspace switch yet. The apps source treats empty as "no apps to show"
   * rather than guessing — see sources/apps.ts.
   */
  apps: PlacementEntry[];
  /** Brand icon URL for an app's server name, or undefined for letter fallback. */
  iconForApp: (serverName: string) => string | undefined;
  /** Signed-in user's org role, for gating org-admin-only actions. */
  orgRole?: string;
  /**
   * True when the current route is a workspace route (`/w/:slug`). Chat lives
   * only inside a workspace, so the chat action gates on this — NOT on
   * `activeWorkspaceSlug`, which is set (to the personal workspace) even on the
   * home / profile surfaces.
   */
  isWorkspaceRoute?: boolean;
}

export interface CommandSource {
  id: SourceId;
  /** Leading char that scopes the query to this source. Omit for always-on. */
  prefix?: string;
  /** Section header in the results list. */
  groupLabel: string;
  /**
   * Whether this source contributes to the default (empty-query, no-prefix)
   * view. Content sources (workspaces, apps) default to `true` so the palette
   * opens content-first. Actions set this `false` so the empty palette doesn't
   * read as a command menu — they surface once the user types a matching term
   * or scopes with `>`. Defaults to `true` when omitted.
   */
  showOnEmptyQuery?: boolean;
  getItems: (query: string, ctx: CommandSourceContext) => CommandItem[];
}
