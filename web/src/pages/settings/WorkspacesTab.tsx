import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { callToolWithoutWorkspace } from "../../api/client";
import { parseToolResult } from "../../api/tool-result";
import { useNotice } from "../../components/notices";
import { Button } from "../../components/ui/button";
import { ConfirmDialog } from "../../components/ui/confirm-dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { Tooltip } from "../../components/ui/tooltip";
import { useSession } from "../../context/SessionContext";
import { useWorkspaceContext } from "../../context/WorkspaceContext";
import { MAX_WORKSPACE_NAME_LENGTH } from "../../lib/workspace-name";
import { toSlug } from "../../lib/workspace-slug";
import { EmptyState, InlineError, SettingsListPage } from "./components";

interface Workspace {
  id: string;
  name: string;
  memberCount: number;
  connectors?: Array<{ serverName: string; name: string }>;
  createdAt?: string;
}

/** The org-admin page for one workspace. */
function workspaceDetailPath(workspaceId: string): string {
  return `/org/workspaces/${toSlug(workspaceId)}`;
}

function formatDate(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

/** Inline form for naming and submitting a new workspace. */
function CreateWorkspaceForm({
  name,
  onNameChange,
  onSubmit,
  creating,
  error,
}: {
  name: string;
  onNameChange: (value: string) => void;
  onSubmit: () => void;
  creating: boolean;
  error: string | null;
}) {
  return (
    <>
      <div className="space-y-1.5 max-w-sm">
        <Label htmlFor="create-ws-name">Name</Label>
        <Input
          id="create-ws-name"
          value={name}
          maxLength={MAX_WORKSPACE_NAME_LENGTH}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="e.g. Sales team"
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim()) onSubmit();
          }}
        />
      </div>
      {error ? <InlineError message={error} /> : null}
      <Button size="sm" onClick={onSubmit} disabled={creating || !name.trim()}>
        {creating ? "Creating..." : "Create workspace"}
      </Button>
    </>
  );
}

/** Empty-state message with an admin call-to-action to create the first workspace. */
function WorkspacesEmpty({
  isAdmin,
  showCreate,
  onStartCreate,
}: {
  isAdmin: boolean;
  showCreate: boolean;
  onStartCreate: () => void;
}) {
  return (
    <EmptyState
      message={isAdmin ? "No workspaces yet." : "No workspaces available."}
      action={
        isAdmin && !showCreate ? (
          <Button size="sm" variant="outline" onClick={onStartCreate}>
            Create the first workspace
          </Button>
        ) : null
      }
    />
  );
}

/** Retry control shown when the workspace list fails to load. */
function WorkspacesRetry({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex justify-center pt-2">
      <Button size="sm" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/**
 * Single workspace table row; (for admins) exposes a delete action.
 *
 * The name is a link, so the row is reachable and opens from the keyboard; the
 * row's click is a larger target for the pointer, and the link's own click
 * stops there so the page is not navigated twice.
 */
function WorkspaceRow({
  workspace,
  href,
  isAdmin,
  onOpen,
  onDelete,
}: {
  workspace: Workspace;
  href: string;
  isAdmin: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <TableRow className="cursor-pointer" onClick={onOpen}>
      <TableCell className="font-medium">
        <Link
          to={href}
          onClick={(e) => e.stopPropagation()}
          className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {workspace.name}
        </Link>
      </TableCell>
      <TableCell>{workspace.memberCount}</TableCell>
      <TableCell>{workspace.connectors?.length ?? 0}</TableCell>
      <TableCell className="text-muted-foreground">{formatDate(workspace.createdAt)}</TableCell>
      {isAdmin && (
        <TableCell>
          <Tooltip label="Delete">
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Delete ${workspace.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </Tooltip>
        </TableCell>
      )}
    </TableRow>
  );
}

/** Table listing all workspaces with member, connector, and created-date columns. */
function WorkspacesTable({
  workspaces,
  isAdmin,
  onOpen,
  onDelete,
}: {
  workspaces: Workspace[];
  isAdmin: boolean;
  onOpen: (workspaceId: string) => void;
  onDelete: (workspace: Workspace) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Members</TableHead>
          <TableHead>Connectors</TableHead>
          <TableHead>Created</TableHead>
          {isAdmin && <TableHead className="w-[60px]" />}
        </TableRow>
      </TableHeader>
      <TableBody>
        {workspaces.map((ws) => (
          <WorkspaceRow
            key={ws.id}
            workspace={ws}
            href={workspaceDetailPath(ws.id)}
            isAdmin={isAdmin}
            onOpen={() => onOpen(ws.id)}
            onDelete={() => onDelete(ws)}
          />
        ))}
      </TableBody>
    </Table>
  );
}

/** Chooses between empty-state, retry, and the populated table for the workspace list. */
function WorkspacesContent({
  workspaces,
  error,
  isAdmin,
  showCreate,
  onStartCreate,
  onRetry,
  onOpen,
  onDelete,
}: {
  workspaces: Workspace[];
  error: string | null;
  isAdmin: boolean;
  showCreate: boolean;
  onStartCreate: () => void;
  onRetry: () => void;
  onOpen: (workspaceId: string) => void;
  onDelete: (workspace: Workspace) => void;
}) {
  if (workspaces.length === 0) {
    if (error) return <WorkspacesRetry onRetry={onRetry} />;
    return (
      <WorkspacesEmpty isAdmin={isAdmin} showCreate={showCreate} onStartCreate={onStartCreate} />
    );
  }
  return (
    <WorkspacesTable
      workspaces={workspaces}
      isAdmin={isAdmin}
      onOpen={onOpen}
      onDelete={onDelete}
    />
  );
}

export function WorkspacesTab() {
  const session = useSession();
  const navigate = useNavigate();
  const { refreshWorkspaces } = useWorkspaceContext();
  const notify = useNotice();
  const isAdmin = session?.user?.orgRole === "admin";

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [deleting, setDeleting] = useState<Workspace | null>(null);

  const fetchWorkspaces = useCallback(async () => {
    try {
      setError(null);
      const res = await callToolWithoutWorkspace("nb", "manage_workspaces", { action: "list" });
      const data = parseToolResult<{ workspaces: Workspace[] }>(res);
      setWorkspaces(data.workspaces ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workspaces");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWorkspaces();
  }, [fetchWorkspaces]);

  const handleCreate = useCallback(async () => {
    if (!createName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      // A refusal (a name over the limit, a missing permission) comes back as a
      // result, not a throw; parseToolResult throws on it, so the form keeps the
      // name and shows the reason instead of closing as if it had worked.
      const res = await callToolWithoutWorkspace("nb", "manage_workspaces", {
        action: "create",
        name: createName.trim(),
      });
      parseToolResult(res);
      setCreateName("");
      setShowCreate(false);
      await Promise.all([fetchWorkspaces(), refreshWorkspaces()]);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create workspace");
    } finally {
      setCreating(false);
    }
  }, [createName, fetchWorkspaces, refreshWorkspaces]);

  // Throwing keeps the dialog open with the refusal shown (ConfirmDialog), and
  // parseToolResult throws on a refusal, which `callTool` returns as a result.
  // On success the dialog is ours to close, and it closes before the re-read, so
  // a failed refresh never reports inside a dialog whose delete already landed.
  const deleteWorkspace = useCallback(
    async (workspace: Workspace) => {
      const res = await callToolWithoutWorkspace("nb", "manage_workspaces", {
        action: "delete",
        workspaceId: workspace.id,
      });
      parseToolResult(res);
      notify({ level: "success", title: `${workspace.name} was deleted` });
      setDeleting(null);
      await Promise.all([fetchWorkspaces(), refreshWorkspaces()]);
    },
    [notify, fetchWorkspaces, refreshWorkspaces],
  );

  return (
    <SettingsListPage
      title="Workspaces"
      description="Manage workspaces and their connectors."
      loading={loading}
      loadingMessage="Loading workspaces..."
      loadError={error}
      create={
        isAdmin
          ? {
              label: "New workspace",
              showing: showCreate,
              canCreate: true,
              onToggle: () => {
                setShowCreate((s) => !s);
                setCreateError(null);
              },
              form: (
                <CreateWorkspaceForm
                  name={createName}
                  onNameChange={setCreateName}
                  onSubmit={handleCreate}
                  creating={creating}
                  error={createError}
                />
              ),
            }
          : undefined
      }
    >
      <WorkspacesContent
        workspaces={workspaces}
        error={error}
        isAdmin={isAdmin}
        showCreate={showCreate}
        onStartCreate={() => setShowCreate(true)}
        onRetry={() => {
          setLoading(true);
          fetchWorkspaces();
        }}
        onOpen={(id) => navigate(workspaceDetailPath(id))}
        onDelete={setDeleting}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete ${deleting?.name ?? ""}?`}
        description="It disappears for everyone in it, and its connectors are disconnected. That can't be undone."
        confirmLabel="Delete workspace"
        pendingLabel="Deleting…"
        destructive
        onConfirm={async () => {
          if (deleting) await deleteWorkspace(deleting);
        }}
      >
        <p className="text-sm text-muted-foreground">
          Its conversations and files are kept in Organization → Archives until an admin purges
          them.
        </p>
      </ConfirmDialog>
    </SettingsListPage>
  );
}
