import { RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { useReleaseCheck } from "../hooks/useReleaseCheck";
import { Button } from "./ui/button";

/**
 * Ambient, dismissible "a new version is available" prompt.
 *
 * Self-contained: it runs the release check and owns its own dismissed state,
 * so it can be dropped once into the authenticated shell with no wiring.
 * Renders nothing until a newer web build is detected (see
 * {@link useReleaseCheck}) and the user hasn't dismissed it.
 *
 * Never reloads on its own — the user may be mid-turn with unsaved input — so
 * the reload is an explicit button. Dismissal is per-tab and not persisted: it
 * reappears on the next detected version or after a manual reload. Styled as
 * quiet, muted chrome (a corner pill), consistent with the app's ambient
 * convention rather than an interrupting modal.
 */
export function ReleaseUpdateBanner() {
  const { updateReady } = useReleaseCheck();
  const [dismissed, setDismissed] = useState(false);

  if (!updateReady || dismissed) return null;

  return (
    <div
      role="status"
      className="fixed right-4 bottom-4 z-40 flex items-center gap-2 rounded-lg border border-border bg-card/95 px-3 py-2 text-sm text-muted-foreground shadow-sm backdrop-blur"
    >
      <span>A new version is available.</span>
      <Button size="sm" onClick={() => window.location.reload()}>
        <RefreshCw />
        Reload
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Dismiss update notice"
        onClick={() => setDismissed(true)}
      >
        <X />
      </Button>
    </div>
  );
}
