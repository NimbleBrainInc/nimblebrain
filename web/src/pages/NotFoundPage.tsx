import { Link, useParams } from "react-router-dom";
import { toWsId } from "../lib/workspace-slug";

/**
 * Terminal route for a URL that matches no other route.
 *
 * `<Routes>` renders `null` when nothing matches, so without this the main area
 * is simply blank — a white screen indistinguishable from an app that failed to
 * render. The usual way to land here is an app URL whose placement is gone: the
 * bundle was uninstalled, or it is installed but not running, so the shell never
 * emitted a route for it.
 *
 * `settled` is false while the shell's placements still describe a different
 * workspace (the deliberate no-flash window on a workspace switch, where the old
 * placements stay visible until the new ones land). App routes are derived from
 * those placements, so a path that will match once they arrive must render as
 * pending, never as missing.
 */
export function NotFoundPage({ settled }: { settled: boolean }) {
  if (!settled) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Loading…
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-sm">
      <span className="text-foreground">This page isn’t available.</span>
      <span className="text-muted-foreground max-w-md text-center">
        The app may have been uninstalled, or it’s installed but not currently running. Check the
        workspace’s Connectors settings if you expected it here.
      </span>
      <Link
        to="/"
        className="px-4 py-2 bg-secondary text-secondary-foreground rounded-sm hover:bg-accent transition-colors"
      >
        Go home
      </Link>
    </div>
  );
}

/**
 * The workspace-scoped not-found, mounted at `/w/:slug/*`.
 *
 * Settledness is measured against the **route slug**, not the ambient
 * `activeWorkspace`. The slug is the stable truth — every other signal is a
 * lagging projection of it (`WorkspaceRouteGuard` sets the React-state workspace
 * in an effect, "a render later"; the shell's placements land later still). So
 * on the first commit after a cross-workspace navigation, `activeWorkspace` and
 * `shellWorkspaceId` both still name the *previous* workspace and compare equal
 * — which would report settled and paint "not available" for an app that is
 * installed in the workspace the URL actually names.
 *
 * Comparing the shell against the slug can't go wrong that way: they differ
 * until the shell has genuinely caught up. Same shape, and same reason, as
 * `WorkspaceOverviewPage`'s `appsReady` and `WorkspaceNav`'s `ready`.
 */
export function WorkspaceNotFoundPage({ shellWorkspaceId }: { shellWorkspaceId?: string }) {
  const { slug } = useParams<{ slug: string }>();
  return <NotFoundPage settled={!!slug && shellWorkspaceId === toWsId(slug)} />;
}
