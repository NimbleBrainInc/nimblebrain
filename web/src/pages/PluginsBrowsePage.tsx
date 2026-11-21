import { Link, useParams } from "react-router-dom";
import { pluginsPath } from "../lib/plugins";
import { ConnectorDirectory } from "./settings/ConnectorBrowsePage";

/**
 * Browse plugins — the plugin directory, at `/w/:slug/plugins/browse`. An
 * install asks whom it is for where the plugin can hold a person's own
 * account: the viewer alone (granted here in the same act) or everyone in the
 * workspace (`ConnectorDirectory`'s `offerPersonal`).
 *
 * One column, because this renders in the main area beside the docked chat
 * (`web/DESIGN.md`); the directory's grid steps on its own container.
 */
export function PluginsBrowsePage() {
  const { slug = "" } = useParams<{ slug: string }>();
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-(--page-gutter) py-6 space-y-5">
        {/* A block, not inline: the column's spacing is a margin on each child. */}
        <Link
          to={pluginsPath(slug)}
          className="block w-fit py-1 text-xs text-muted-foreground hover:underline"
          data-testid="browse-back"
        >
          ← Plugins
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">Browse plugins</h1>
        <ConnectorDirectory offerPersonal />
      </div>
    </div>
  );
}
