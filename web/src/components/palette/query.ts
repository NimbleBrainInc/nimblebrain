// ---------------------------------------------------------------------------
// Palette query logic (pure) — prefix scoping + result grouping.
//
// Extracted from the CommandPalette component so the parsing/grouping contract
// is unit-testable without wiring up the eight React contexts the component
// consumes. The component owns rendering, selection, and keyboard handling;
// this owns "given a query string, which groups and items show".
// ---------------------------------------------------------------------------

import { appsGroupLabel } from "./sources/apps";
import type { CommandItem, CommandSource, CommandSourceContext, SourceId } from "./types";

export const PREFIX_TO_SOURCE: Record<string, SourceId> = {
  "@": "workspaces",
  "#": "apps",
  ">": "actions",
};

/** Human label for the active scope chip. */
export const SCOPE_LABEL: Record<SourceId, string> = {
  workspaces: "workspaces",
  apps: "apps",
  actions: "actions",
};

export interface ResultGroup {
  source: CommandSource;
  label: string;
  items: CommandItem[];
}

/** Split a leading prefix off the query. `@helix` → scope workspaces, term "helix". */
export function parseQuery(q: string): { scopeId: SourceId | null; term: string } {
  const first = q[0];
  if (first && first in PREFIX_TO_SOURCE) {
    return { scopeId: PREFIX_TO_SOURCE[first]!, term: q.slice(1) };
  }
  return { scopeId: null, term: q };
}

/**
 * Run the enabled sources against the query and return non-empty groups in
 * source order. A prefix narrows to a single source; otherwise all run. The
 * apps group label names the focused workspace.
 */
export function buildResultGroups(
  query: string,
  sources: CommandSource[],
  ctx: CommandSourceContext,
): ResultGroup[] {
  const { scopeId, term } = parseQuery(query);
  // Default view = no prefix + no term. Sources that opt out of the empty view
  // (actions) are skipped there so the palette opens content-first.
  const isDefaultView = !scopeId && term.trim() === "";
  const enabled = scopeId
    ? sources.filter((s) => s.id === scopeId)
    : sources.filter((s) => !isDefaultView || s.showOnEmptyQuery !== false);
  return enabled
    .map((source) => ({
      source,
      label: source.id === "apps" ? appsGroupLabel(ctx.activeWorkspaceName) : source.groupLabel,
      items: source.getItems(term, ctx),
    }))
    .filter((g) => g.items.length > 0);
}
