import { RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { useReleaseCheck } from "../hooks/useReleaseCheck";
import { Button } from "./ui/button";

/**
 * Ambient, dismissible "a new version is available" prompt, pinned to the
 * bottom of the sidebar (the app's bottom-left utility rail).
 *
 * Self-contained: it runs the release check and owns its dismissed state, so
 * ShellLayout just drops it at the foot of the nav. Renders nothing until a
 * newer web build is detected (see {@link useReleaseCheck}) and the user
 * hasn't dismissed it.
 *
 * Never reloads on its own — the user may be mid-turn with unsaved input — so
 * the reload is an explicit action. Dismissal is per-tab and not persisted: it
 * reappears on the next detected version or after a manual reload.
 *
 * Two forms, matching the sidebar's two widths:
 * - expanded: a quiet muted card with a label + full-width Reload + dismiss.
 * - collapsed (icon rail): a single refresh icon with a status dot; click to
 *   reload, tooltip explains. (No dismiss affordance in icon mode — there's no
 *   room; expand the sidebar to dismiss.)
 */
export function ReleaseUpdateBanner({ collapsed = false }: { collapsed?: boolean }) {
  const { updateReady } = useReleaseCheck();
  const [dismissed, setDismissed] = useState(false);

  if (!updateReady || dismissed) return null;

  if (collapsed) {
    return (
      <div className="flex shrink-0 justify-center py-2">
        <Button
          size="icon-sm"
          variant="ghost"
          title="A new version is available — reload"
          aria-label="A new version is available — reload"
          onClick={() => window.location.reload()}
          className="relative text-sidebar-foreground"
        >
          <RefreshCw />
          <span className="absolute top-1 right-1 size-1.5 rounded-full bg-primary" />
        </Button>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="mx-2 mb-2 shrink-0 rounded-lg border border-sidebar-border bg-sidebar-accent/50 px-2.5 py-2 text-xs text-sidebar-foreground"
    >
      <div className="flex items-center justify-between gap-1">
        <span>New version available</span>
        <button
          type="button"
          aria-label="Dismiss update notice"
          onClick={() => setDismissed(true)}
          className="-mr-0.5 rounded p-0.5 text-sidebar-foreground/60 transition-colors hover:text-sidebar-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <Button size="sm" className="mt-1.5 w-full" onClick={() => window.location.reload()}>
        <RefreshCw />
        Reload
      </Button>
    </div>
  );
}
