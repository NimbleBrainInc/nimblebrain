import { Check, Copy } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { useFlashState } from "../../../hooks/useFlashState";

/**
 * Workspace ID + copy button, for `WorkspaceDetailPage` (org-admin "manage
 * another workspace"). The call site renders it inside a `<Section
 * title="Workspace ID">`, so this component renders no heading or label of
 * its own; the Section above it owns that.
 *
 * Design notes:
 *
 *   - The ID is always visible in a `<code>` block, so if the clipboard
 *     write fails (Safari over plain HTTP, sandboxed iframes, denied
 *     permission) the user can still select-and-copy manually. We catch
 *     the rejection silently — surfacing a toast for an unreliable
 *     convenience action would be more disruptive than the failure.
 *   - The "Copied" confirmation uses `useFlashState` so re-clicking
 *     within the 1.5s window doesn't stack timers, and unmounting
 *     mid-flash doesn't leak a pending setState.
 */
export function CopyableWorkspaceId({ workspaceId }: { workspaceId: string }) {
  const [copied, flashCopied] = useFlashState(1500);

  const handleCopy = () => {
    navigator.clipboard
      .writeText(workspaceId)
      .then(flashCopied)
      .catch(() => {
        // The ID is visible beside the button; the user can select it by hand.
      });
  };

  return (
    <div className="flex items-center justify-between gap-2">
      <code className="block min-w-0 text-sm font-mono truncate">{workspaceId}</code>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleCopy}
        className="h-8 w-8 p-0 shrink-0"
        aria-label="Copy workspace ID"
      >
        {copied ? (
          <Check className="h-4 w-4 text-success" />
        ) : (
          <Copy className="h-4 w-4 text-muted-foreground" />
        )}
      </Button>
    </div>
  );
}
