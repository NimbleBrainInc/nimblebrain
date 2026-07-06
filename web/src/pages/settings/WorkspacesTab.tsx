import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { callTool } from "../../api/client";
import { parseToolResult } from "../../api/tool-result";
import { Button } from "../../components/ui/button";
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
import { useSession } from "../../context/SessionContext";
import { EmptyState, InlineError, SettingsListPage } from "./components";

interface Workspace {
  id: string;
  name: string;
  memberCount: number;
  bundles?: Array<{ name?: string; path?: string }>;
  createdAt?: string;
}

const ADMIN_ROLES = new Set(["admin", "owner"]);

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
        <Label htmlFor="create-ws-name">Workspace Name</Label>
        <Input
          id="create-ws-name"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="My Workspace"
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim()) onSubmit();
          }}
        />
      </div>
      {error ? <InlineError message={error} /> : null}
      <Button size="sm" onClick={onSubmit} disabled={creating || !name.trim()}>
        {creating ? "Creating..." : "Create Workspace"}
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

/** Single workspace table row; opens on click and (for admins) exposes a delete action. */
function WorkspaceRow({
  workspace,
  isAdmin,
  isDeleting,
  onOpen,
  onDelete,
}: {
  workspace: Workspace;
  isAdmin: boolean;
  isDeleting: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <TableRow className="cursor-pointer" onClick={onOpen}>
      <TableCell className="font-medium">{workspace.name}</TableCell>
      <TableCell>{workspace.memberCount}</TableCell>
      <TableCell>{workspace.bundles?.length ?? 0}</TableCell>
      <TableCell className="text-muted-foreground">{formatDate(workspace.createdAt)}</TableCell>
      {isAdmin && (
        <TableCell>
          <Button
            size="sm"
            variant="ghost"
            disabled={isDeleting}
            title={`Delete ${workspace.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </TableCell>
      )}
    </TableRow>
  );
}

/** Table listing all workspaces with member, bundle, and created-date columns. */
function WorkspacesTable({
  workspaces,
  isAdmin,
  deletingId,
  onOpen,
  onDelete,
}: {
  workspaces: Workspace[];
  isAdmin: boolean;
  deletingId: string | null;
  onOpen: (workspaceId: string) => void;
  onDelete: (workspaceId: string, name: string) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Members</TableHead>
          <TableHead>Bundles</TableHead>
          <TableHead>Created</TableHead>
          {isAdmin && <TableHead className="w-[60px]" />}
        </TableRow>
      </TableHeader>
      <TableBody>
        {workspaces.map((ws) => (
          <WorkspaceRow
            key={ws.id}
            workspace={ws}
            isAdmin={isAdmin}
            isDeleting={deletingId === ws.id}
            onOpen={() => onOpen(ws.id)}
            onDelete={() => onDelete(ws.id, ws.name)}
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
  deletingId,
  onStartCreate,
  onRetry,
  onOpen,
  onDelete,
}: {
  workspaces: Workspace[];
  error: string | null;
  isAdmin: boolean;
  showCreate: boolean;
  deletingId: string | null;
  onStartCreate: () => void;
  onRetry: () => void;
  onOpen: (workspaceId: string) => void;
  onDelete: (workspaceId: string, name: string) => void;
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
      deletingId={deletingId}
      onOpen={onOpen}
      onDelete={onDelete}
    />
  );
}

export function WorkspacesTab() {
  const session = useSession();
  const navigate = useNavigate();
  const isAdmin = ADMIN_ROLES.has(session?.user?.orgRole ?? "");

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchWorkspaces = useCallback(async () => {
    try {
      setError(null);
      const res = await callTool("nb", "manage_workspaces", { action: "list" });
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
      await callTool("nb", "manage_workspaces", {
        action: "create",
        name: createName.trim(),
      });
      setCreateName("");
      setShowCreate(false);
      await fetchWorkspaces();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create workspace");
    } finally {
      setCreating(false);
    }
  }, [createName, fetchWorkspaces]);

  const handleDelete = useCallback(
    async (workspaceId: string, name: string) => {
      const confirmed = window.confirm(`Delete workspace "${name}"? This action cannot be undone.`);
      if (!confirmed) return;
      setDeletingId(workspaceId);
      try {
        await callTool("nb", "manage_workspaces", { action: "delete", workspaceId });
        await fetchWorkspaces();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete workspace");
      } finally {
        setDeletingId(null);
      }
    },
    [fetchWorkspaces],
  );

  return (
    <SettingsListPage
      title="Workspaces"
      description="Manage workspaces and their bundles."
      loading={loading}
      loadingMessage="Loading workspaces..."
      loadError={error}
      create={
        isAdmin
          ? {
              label: "Create Workspace",
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
        deletingId={deletingId}
        onStartCreate={() => setShowCreate(true)}
        onRetry={() => {
          setLoading(true);
          fetchWorkspaces();
        }}
        onOpen={(id) => navigate(`/org/workspaces/${id.replace(/^ws_/, "")}`)}
        onDelete={handleDelete}
      />
    </SettingsListPage>
  );
}
