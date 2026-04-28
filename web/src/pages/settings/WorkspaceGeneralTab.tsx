import { useWorkspaceContext } from "../../context/WorkspaceContext";
import { roleAtLeast, useScopedRole } from "../../hooks/useScopedRole";
import {
  CopyableWorkspaceId,
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
        <CopyableWorkspaceId workspaceId={ws.id} />
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
