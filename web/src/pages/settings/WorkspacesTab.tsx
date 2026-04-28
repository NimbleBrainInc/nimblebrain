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

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading workspaces...</p>;
  }

  if (error && workspaces.length === 0) {
    return (
      <div className="max-w-5xl mx-auto space-y-3">
        <InlineError
          message={error}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setLoading(true);
                fetchWorkspaces();
              }}
            >
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <SettingsListPage
      title="Workspaces"
      description="Manage workspaces and their bundles."
      loadError={error && workspaces.length > 0 ? error : null}
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
                <>
                  <div className="space-y-1.5 max-w-sm">
                    <Label htmlFor="create-ws-name">Workspace Name</Label>
                    <Input
                      id="create-ws-name"
                      value={createName}
                      onChange={(e) => setCreateName(e.target.value)}
                      placeholder="My Workspace"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && createName.trim()) handleCreate();
                      }}
                    />
                  </div>
                  {createError ? <InlineError message={createError} /> : null}
                  <Button
                    size="sm"
                    onClick={handleCreate}
                    disabled={creating || !createName.trim()}
                  >
                    {creating ? "Creating..." : "Create Workspace"}
                  </Button>
                </>
              ),
            }
          : undefined
      }
    >
      {workspaces.length === 0 ? (
        <EmptyState
          message={isAdmin ? "No workspaces yet." : "No workspaces available."}
          action={
            isAdmin && !showCreate ? (
              <Button size="sm" variant="outline" onClick={() => setShowCreate(true)}>
                Create the first workspace
              </Button>
            ) : null
          }
        />
      ) : (
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
            {workspaces.map((ws) => {
              const isDeleting = deletingId === ws.id;
              return (
                <TableRow
                  key={ws.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/settings/org/workspaces/${ws.id.replace(/^ws_/, "")}`)}
                >
                  <TableCell className="font-medium">{ws.name}</TableCell>
                  <TableCell>{ws.memberCount}</TableCell>
                  <TableCell>{ws.bundles?.length ?? 0}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(ws.createdAt)}
                  </TableCell>
                  {isAdmin && (
                    <TableCell>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={isDeleting}
                        title={`Delete ${ws.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(ws.id, ws.name);
                        }}
                        className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </SettingsListPage>
  );
}
