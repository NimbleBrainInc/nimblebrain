import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Label } from "../../components/ui/label";
import { useWorkspaceContext } from "../../context/WorkspaceContext";
import { roleAtLeast, useScopedRole } from "../../hooks/useScopedRole";
import {
  RequireActiveWorkspace,
  Section,
  SettingsFormPage,
  WorkspaceInstructions,
} from "./components";

/**
 * Active-workspace "General" tab — name, MCP connection, and custom instructions.
 *
 * Route: /settings/workspace/general (active workspace, scoped via header switcher).
 * Permission: any workspace member can read; workspace admins (or org
 * admins/owners) can edit. The `WorkspaceInstructions` editor disables
 * itself when `canEdit` is false; the backend independently enforces.
 */
export function WorkspaceGeneralTab() {
  return (
    <RequireActiveWorkspace>
      <Inner />
    </RequireActiveWorkspace>
  );
}

function Inner() {
  const { activeWorkspace } = useWorkspaceContext();
  const role = useScopedRole();
  const canEdit = roleAtLeast(role, "ws_admin");

  // RequireActiveWorkspace guarantees activeWorkspace is non-null here.
  const ws = activeWorkspace!;

  return (
    <SettingsFormPage
      title={ws.name}
      description="Settings for the active workspace. Changes affect everyone in this workspace."
    >
      <Section title="MCP Connection" flush>
        <McpConnectionBody workspaceId={ws.id} />
      </Section>

      <Section
        title="Workspace Instructions"
        description="Custom instructions injected into every conversation in this workspace. Applies on top of organization-wide policies and is readable by anyone in the workspace."
      >
        <WorkspaceInstructions wsId={ws.id} canEdit={canEdit} />
      </Section>
    </SettingsFormPage>
  );
}

function McpConnectionBody({ workspaceId }: { workspaceId: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(workspaceId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
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
