import { Link } from "react-router-dom";

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
