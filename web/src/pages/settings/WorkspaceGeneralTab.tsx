import { useWorkspaceContext } from "../../context/WorkspaceContext";
import { useCanWriteActiveWorkspace } from "../../hooks/useScopedRole";
import {
  CopyableWorkspaceId,
  RequireActiveWorkspace,
  Section,
  SettingsFormPage,
  WorkspaceInstructions,
} from "./components";

/**
 * Workspace "General" tab — the MCP connection details and the workspace's
 * custom instructions.
 *
 * Route: /w/:slug/settings/general (the workspace is the URL slug).
 * Permission: any workspace member can read; only a workspace **admin member**
 * can edit. Org admins get no bypass — `write_instructions` at workspace scope
 * routes through `canWriteWorkspaceScoped`, which never consults `orgRole`. The
 * `WorkspaceInstructions` editor disables itself when `canEdit` is false; the
 * backend independently enforces.
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
  // The instructions editor writes workspace-owned state, gated server-side by
  // `canWriteWorkspaceScoped` — membership admin, no org bypass.
  const canEdit = useCanWriteActiveWorkspace();

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
