import { Check, Copy } from "lucide-react";
import { useCallback } from "react";
import { callTool } from "../../api/client";
import { Input } from "../../components/ui/input";
import { Tooltip } from "../../components/ui/tooltip";
import { useSession } from "../../context/SessionContext";
import { useWorkspaceContext, type WorkspaceInfo } from "../../context/WorkspaceContext";
import { useAutosaveForm } from "../../hooks/useAutosaveForm";
import { useFlashState } from "../../hooks/useFlashState";
import { canManageWorkspaceMembers } from "../../hooks/useScopedRole";
import { MAX_WORKSPACE_NAME_LENGTH } from "../../lib/workspace-name";
import { AutosaveField, RequireActiveWorkspace, Section, SettingsFormPage } from "./components";

/**
 * Workspace "General" tab — the workspace's name, saving as it changes, with
 * the workspace ID as quiet metadata in the header's top-right corner. Most members never need the ID, so it gets no
 * section of its own; it is here, not on the MCP tab, because it identifies
 * the workspace.
 *
 * Route: /w/:slug/settings/general (the workspace is the URL slug).
 * Permission: any workspace member can read. The name is governance
 * (`canRenameWorkspace`): a workspace admin member or an org admin may rename,
 * so the web gate is `canManageWorkspaceMembers`. The field disables itself
 * when the gate is false; the backend re-checks.
 */
export function WorkspaceGeneralTab() {
  return (
    <RequireActiveWorkspace>
      <ForActiveWorkspace />
    </RequireActiveWorkspace>
  );
}

/**
 * Keyed by the workspace, so a switch starts a fresh form: the route keeps this
 * element mounted across `/w/:slug` changes, and one workspace's draft must
 * never stand in for another's.
 */
function ForActiveWorkspace() {
  const { activeWorkspace } = useWorkspaceContext();
  // RequireActiveWorkspace guarantees activeWorkspace is non-null here.
  const ws = activeWorkspace!;
  return <Inner key={ws.id} wsId={ws.id} name={ws.name} userRole={ws.userRole} />;
}

function Inner({
  wsId,
  name,
  userRole,
}: {
  wsId: string;
  name: string;
  userRole: WorkspaceInfo["userRole"];
}) {
  const session = useSession();
  const canRename = canManageWorkspaceMembers(session?.user?.orgRole, userRole);
  const nameForm = useWorkspaceName(wsId, name);

  return (
    <SettingsFormPage
      title="General"
      description="Changes here affect everyone in this workspace."
      action={<WorkspaceIdChip workspaceId={wsId} />}
    >
      <Section flush>
        <AutosaveField
          id={`workspace-name-${wsId}`}
          label="Name"
          {...nameForm.fieldState("name")}
          hint={canRename ? undefined : "Only workspace admins can rename this workspace."}
        >
          <Input
            id={`workspace-name-${wsId}`}
            disabled={!canRename}
            maxLength={MAX_WORKSPACE_NAME_LENGTH}
            {...nameForm.inputProps("name")}
          />
        </AutosaveField>
      </Section>
    </SettingsFormPage>
  );
}

/**
 * The workspace name as a form that saves on blur or Enter (`useAutosaveForm`).
 * It starts from the name the workspace list already holds, so there is nothing
 * to load. A save names `wsId`, so it lands in this workspace even if the reader
 * has moved on, then refreshes the workspace list, so the sidebar and switcher
 * show the new name at once.
 */
function useWorkspaceName(wsId: string, initialName: string) {
  const { refreshWorkspaces } = useWorkspaceContext();

  const save = useCallback(
    async (_field: "name", value: string) => {
      const trimmed = value.trim();
      if (!trimmed) throw new Error("A workspace needs a name.");
      const res = await callTool(
        "nb",
        "manage_workspaces",
        { action: "update", workspaceId: wsId, name: trimmed },
        { workspaceId: wsId },
      );
      if (res.isError) {
        throw new Error(res.content?.[0]?.text ?? "The workspace was not renamed.");
      }
      // Refresh in the background: the rename has landed whether or not the
      // list re-reads, and a failed re-read only leaves the old name showing.
      refreshWorkspaces().catch(() => {});
    },
    [wsId, refreshWorkspaces],
  );

  return useAutosaveForm(
    { name: initialName },
    {
      save,
      labels: { name: "Workspace name" },
      notices: { name: { undo: true } },
    },
  );
}

function WorkspaceIdChip({ workspaceId }: { workspaceId: string }) {
  const [copied, flashCopied] = useFlashState(1500);
  return (
    <Tooltip label={copied ? "Copied" : "Copy workspace ID"}>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard
            .writeText(workspaceId)
            .then(flashCopied)
            .catch(() => {});
        }}
        aria-label={`Copy workspace ID ${workspaceId}`}
        data-testid="workspace-id-chip"
        className="mt-1 inline-flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground transition-colors"
      >
        <code className="font-mono">{workspaceId}</code>
        {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </Tooltip>
  );
}
