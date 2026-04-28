import { Check, Copy } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { Label } from "../../../components/ui/label";
import { useFlashState } from "../../../hooks/useFlashState";

/**
 * Workspace ID + copy button + MCP-client helper text. Used by both
 * `WorkspaceGeneralTab` (active workspace) and `WorkspaceDetailPage`
 * (org-admin "manage another workspace") — same widget, same copy.
 *
 * The two call sites both render this inside a `<Section title="MCP
 * Connection">`, so this component does NOT render its own heading; the
 * Section above it owns that.
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
        // ID is visible above; the user can fall back to manual select.
      });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="space-y-1 min-w-0">
          <Label className="text-xs text-muted-foreground">Workspace ID</Label>
          <code className="block text-sm font-mono truncate">{workspaceId}</code>
        </div>
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
      <p className="text-xs text-muted-foreground">
        Use this ID as the <code className="text-[11px]">X-Workspace-Id</code> header when
        connecting external MCP clients to this workspace.
      </p>
    </div>
  );
}
