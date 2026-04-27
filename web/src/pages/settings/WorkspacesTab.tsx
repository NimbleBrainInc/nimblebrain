import { ChevronUp, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { callTool } from "../../api/client";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
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

// ── Types ────────────────────────────────────────────────────────────

interface Workspace {
  id: string;
  name: string;
  memberCount: number;
  bundles?: Array<{ name?: string; path?: string }>;
  createdAt?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

function parseToolResponse<T>(res: {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}): T {
  if (res.isError) {
    const msg = res.content?.[0]?.text ?? "Operation failed";
    throw new Error(msg);
  }
  if (res.structuredContent) return res.structuredContent as T;
  if (res.content?.[0]?.text) {
    try {
      return JSON.parse(res.content[0].text) as T;
    } catch {
      throw new Error(res.content[0].text);
    }
  }
  throw new Error("Empty response");
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

// ── Component ────────────────────────────────────────────────────────

export function WorkspacesTab() {
  const session = useSession();
  const navigate = useNavigate();
  const isAdmin = ADMIN_ROLES.has(session?.user?.orgRole ?? "");

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create form state
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Delete in progress
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // ── Fetch workspaces ─────────────────────────────────────────────

  const fetchWorkspaces = useCallback(async () => {
    try {
      setError(null);
      const res = await callTool("nb", "manage_workspaces", { action: "list" });
      const data = parseToolResponse<{ workspaces: Workspace[] }>(res);
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

  // ── Create workspace ─────────────────────────────────────────────

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

  // ── Delete workspace ─────────────────────────────────────────────

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

  // ── Loading state ────────────────────────────────────────────────

  if (loading) {
    return <div className="text-muted-foreground text-sm">Loading workspaces...</div>;
  }

  // ── Error state ──────────────────────────────────────────────────

  if (error && workspaces.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{error}</p>
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
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header + Create toggle */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Workspaces</h3>
          <p className="text-sm text-muted-foreground">Manage workspaces and their bundles.</p>
        </div>
        {isAdmin && (
          <Button
            size="sm"
            variant={showCreate ? "outline" : "default"}
            onClick={() => {
              setShowCreate(!showCreate);
              setCreateError(null);
            }}
          >
            {showCreate ? (
              <>
                <ChevronUp className="mr-1.5 h-4 w-4" />
                Cancel
              </>
            ) : (
              <>
                <Plus className="mr-1.5 h-4 w-4" />
                Create Workspace
              </>
            )}
          </Button>
        )}
      </div>

      {/* Inline error banner */}
      {error && workspaces.length > 0 && <p className="text-sm text-destructive">{error}</p>}

      {/* Create form */}
      {showCreate && (
        <Card>
          <CardContent className="py-4 space-y-4">
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
            {createError && <p className="text-sm text-destructive">{createError}</p>}
            <Button size="sm" onClick={handleCreate} disabled={creating || !createName.trim()}>
              {creating ? "Creating..." : "Create Workspace"}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Workspaces table */}
      {workspaces.length === 0 ? (
        <div className="rounded-md border border-dashed p-8 text-center">
          <p className="text-sm text-muted-foreground">
            {isAdmin ? "No workspaces yet." : "No workspaces available."}
          </p>
          {isAdmin && !showCreate && (
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={() => setShowCreate(true)}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              Create the first workspace
            </Button>
          )}
        </div>
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
    </div>
  );
}
