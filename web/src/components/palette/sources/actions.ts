// ---------------------------------------------------------------------------
// Actions source (>) — projects the actions registry into CommandItems.
//
// Filters by availability (role, focused workspace), scores against the query,
// and closes the source-context into each item's run so workspace-scoped
// routes resolve. Empty query shows all available actions (curated set is
// small).
// ---------------------------------------------------------------------------

import { ACTIONS } from "../actions";
import { scoreItem } from "../match";
import type { CommandItem, CommandSource } from "../types";

export const actionsSource: CommandSource = {
  id: "actions",
  prefix: ">",
  groupLabel: "Actions",
  // Actions are a command mode, not the default view: they appear once the
  // user types a matching term or scopes with ">", so the empty palette stays
  // content-first (workspaces, apps) rather than reading as a command menu.
  showOnEmptyQuery: false,
  getItems(query, ctx) {
    const scored: Array<{ item: CommandItem; score: number }> = [];
    for (const action of ACTIONS) {
      if (action.available && !action.available(ctx)) continue;
      const result = scoreItem(query, { title: action.title, keywords: action.keywords });
      if (!result.matched) continue;
      scored.push({
        score: result.score,
        item: {
          id: `action:${action.id}`,
          sourceId: "actions",
          title: action.title,
          icon: { kind: "lucide", name: action.icon },
          keywords: action.keywords,
          meta: ">",
          run: (run) => action.run(run, ctx),
        },
      });
    }
    return scored.sort((a, b) => b.score - a.score).map((s) => s.item);
  },
};
