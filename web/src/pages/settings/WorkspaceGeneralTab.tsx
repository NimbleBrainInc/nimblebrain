import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Label } from "../../components/ui/label";
import { useWorkspaceContext } from "../../context/WorkspaceContext";
import { roleAtLeast, useScopedRole } from "../../hooks/useScopedRole";
import { RequireActiveWorkspace } from "./components/RequireActiveWorkspace";
import { WorkspaceInstructions } from "./components/WorkspaceInstructions";

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
    <div className="space-y-8">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">{ws.name}</h2>
        <p className="text-sm text-muted-foreground">
          Settings for the active workspace. Changes affect everyone in this workspace.
        </p>
      </header>

      <McpConnectionCard workspaceId={ws.id} />

      <WorkspaceInstructions wsId={ws.id} canEdit={canEdit} />
    </div>
  );
}

/**
 * Workspace ID + copy button. Originally lived on the Profile tab, but
 * the workspace ID is intrinsically workspace-scoped (and changes with
 * the header switcher), so it belongs here.
 */
function McpConnectionCard({ workspaceId }: { workspaceId: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(workspaceId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>MCP Connection</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Workspace ID</Label>
            <code className="block text-sm font-mono">{workspaceId}</code>
          </div>
          <Button variant="ghost" size="sm" onClick={handleCopy} className="h-8 w-8 p-0">
            {copied ? (
              <Check className="h-4 w-4 text-green-500" />
            ) : (
              <Copy className="h-4 w-4 text-muted-foreground" />
            )}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Use this ID as the <code className="text-[11px]">X-Workspace-Id</code> header when
          connecting external MCP clients to this workspace.
        </p>
      </CardContent>
    </Card>
  );
}
