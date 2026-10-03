import { Check, Copy } from "lucide-react";
import { useWorkspaceContext } from "../../context/WorkspaceContext";
import { useFlashState } from "../../hooks/useFlashState";
import { useCanWriteActiveWorkspace } from "../../hooks/useScopedRole";
import {
  AutosaveStatus,
  RequireActiveWorkspace,
  Section,
  SettingsFormPage,
  useWorkspaceInstructions,
  WorkspaceInstructions,
} from "./components";

/**
 * Workspace "General" tab — the workspace's custom instructions, with the
 * workspace ID as quiet metadata in the header's top-right corner. Most members
 * never need the ID, so it gets no section of its own; it is here, not on the
 * MCP tab, because it identifies the workspace.
 *
 * Route: /w/:slug/settings/general (the workspace is the URL slug).
 * Permission: any workspace member can read; only a workspace **admin member**
 * can edit. Org admins get no bypass — `write_instructions`
 * routes through `canWriteWorkspaceScoped`, which never consults `orgRole`. The
 * `WorkspaceInstructions` editor disables itself when `canEdit` is false; the
 * backend independently enforces.
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
  return <Inner key={ws.id} wsId={ws.id} />;
}

function Inner({ wsId }: { wsId: string }) {
  // The instructions editor writes workspace-owned state, gated server-side by
  // `canWriteWorkspaceScoped` — membership admin, no org bypass.
  const canEdit = useCanWriteActiveWorkspace();
  const instructions = useWorkspaceInstructions(wsId);
  const ready = !instructions.loading && !instructions.loadError;

  return (
    <SettingsFormPage
      title="General"
      description="Changes here affect everyone in this workspace."
      action={
        <div className="flex flex-col items-end gap-1">
          {ready && canEdit ? <AutosaveStatus status={instructions.form.status} /> : null}
          <WorkspaceIdChip workspaceId={wsId} />
        </div>
      }
    >
      <Section
        flush
        title="Workspace instructions"
        description="Guidance the assistant follows in every conversation in this workspace, on top of your organization's. Everyone here can see it."
      >
        <WorkspaceInstructions wsId={wsId} canEdit={canEdit} instructions={instructions} />
      </Section>
    </SettingsFormPage>
  );
}

function WorkspaceIdChip({ workspaceId }: { workspaceId: string }) {
  const [copied, flashCopied] = useFlashState(1500);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard
          .writeText(workspaceId)
          .then(flashCopied)
          .catch(() => {});
      }}
      aria-label={`Copy workspace ID ${workspaceId}`}
      title={copied ? "Copied" : "Copy workspace ID"}
      data-testid="workspace-id-chip"
      className="mt-1 inline-flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground transition-colors"
    >
      <code className="font-mono">{workspaceId}</code>
      {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}
