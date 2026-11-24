import { useEffect, useRef } from "react";
import { Link, useParams } from "react-router-dom";
import { browsePluginPath, browsePluginsPath, pluginsPath } from "../lib/plugins";
import { ConnectorDirectory } from "./settings/ConnectorBrowsePage";

/**
 * Browse plugins — the plugin directory, at `/w/:slug/plugins/browse`, and one
 * entry's page before install, at `/w/:slug/plugins/browse/<catalog id>`. An
 * install asks whom it is for where the plugin can hold a person's own
 * account: the viewer alone (granted here in the same act) or everyone in the
 * workspace (`ConnectorDirectory`'s `offerPersonal`).
 *
 * Both are one route, so the directory instance (its listing, search, and
 * installs made this visit) survives moving between the list and an entry.
 * The scroll column does too, so it returns to the top on each move.
 *
 * One column, because this renders in the main area beside the docked chat
 * (`web/DESIGN.md`); the directory's grid steps on its own container.
 */
export function PluginsBrowsePage() {
  const { slug = "", "*": splat = "" } = useParams<{ slug: string; "*": string }>();
  const entryId = splat || undefined;
  const scrollRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the move between list and entry is the trigger.
  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: 0 });
  }, [entryId]);

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-(--page-gutter) py-6 space-y-5">
        {/* A block, not inline: the column's spacing is a margin on each child. */}
        <Link
          to={entryId ? browsePluginsPath(slug) : pluginsPath(slug)}
          className="block w-fit py-1 text-xs text-muted-foreground hover:underline"
          data-testid="browse-back"
        >
          {entryId ? "← Browse plugins" : "← Plugins"}
        </Link>
        {!entryId && <h1 className="text-xl font-semibold tracking-tight">Browse plugins</h1>}
        <ConnectorDirectory
          offerPersonal
          entryId={entryId}
          entryPath={(entry) => browsePluginPath(slug, entry.id)}
        />
      </div>
    </div>
  );
}
