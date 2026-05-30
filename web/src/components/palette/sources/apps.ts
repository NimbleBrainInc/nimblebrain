// ---------------------------------------------------------------------------
// Apps source (#) — launch an app in the focused workspace.
//
// v1 is scoped to the FOCUSED workspace's placements. The shell holds one
// workspace's placements at a time and lags a switch (ShellContext), so the
// container passes an empty `apps` array until the shell catches up; this
// source treats empty as "nothing to show" rather than guessing. Cross-
// workspace app search is deferred (needs each workspace's placement set).
//
// The group label names the workspace so it's never ambiguous which
// workspace's apps are listed.
// ---------------------------------------------------------------------------

import { scoreItem } from "../match";
import type { CommandItem, CommandSource } from "../types";

export const appsSource: CommandSource = {
  id: "apps",
  prefix: "#",
  groupLabel: "Apps",
  getItems(query, ctx) {
    if (!ctx.activeWorkspaceSlug || ctx.apps.length === 0) return [];
    const slug = ctx.activeWorkspaceSlug;

    const scored: Array<{ item: CommandItem; score: number }> = [];
    for (const p of ctx.apps) {
      if (!p.route) continue;
      const label = p.label ?? p.route;
      const keywords = [p.route, p.serverName].filter(Boolean) as string[];
      const result = scoreItem(query, { title: label, keywords });
      if (!result.matched) continue;
      const letter = (label.trim()[0] ?? "#").toUpperCase();
      scored.push({
        score: result.score,
        item: {
          id: `app:${p.resourceUri}`,
          sourceId: "apps",
          title: label,
          subtitle: p.serverName,
          icon: { kind: "brand", url: ctx.iconForApp(p.serverName), fallbackLetter: letter },
          keywords,
          meta: "#app",
          run: (run) => {
            run.navigate(`/w/${slug}/app/${p.route}`);
            run.closePalette();
          },
        },
      });
    }

    return scored.sort((a, b) => b.score - a.score).map((s) => s.item);
  },
};

/**
 * The group label for the apps section, naming the focused workspace so it's
 * clear which workspace's apps are listed. Falls back to the static label when
 * no workspace is focused (the source returns no items in that case anyway).
 */
export function appsGroupLabel(activeWorkspaceName?: string): string {
  return activeWorkspaceName ? `Apps in ${activeWorkspaceName}` : "Apps";
}
