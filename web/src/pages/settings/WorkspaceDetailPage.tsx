import { ArrowLeft, Check, Copy, Package, Plus, Trash2, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { callTool } from "../../api/client";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
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

interface Member {
  userId: string;
  role: string;
}

interface UserInfo {
  id: string;
  email: string;
  displayName: string;
  orgRole: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

function parseToolResponse<T>(res: {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
}): T {
  if (res.structuredContent) return res.structuredContent as T;
  if (res.content?.[0]?.text) {
    return JSON.parse(res.content[0].text) as T;
  }
  throw new Error("Empty response");
}

const ADMIN_ROLES = new Set(["admin", "owner"]);

const ROLE_STYLES: Record<string, string> = {
  admin: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  member: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

function RoleBadge({ role }: { role: string }) {
  return (
    <Badge variant="outline" className={ROLE_STYLES[role] ?? ROLE_STYLES.member}>
      {role}
    </Badge>
  );
}

function formatDate(iso?: string): string {
  if (!iso) return "\u2014";
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

// ── Copyable Workspace ID ────────────────────────────────────────────

function CopyableWorkspaceId({ workspaceId }: { workspaceId: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(workspaceId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <Card>
      <CardContent className="py-3 px-4">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-xs text-muted-foreground">Workspace ID</Label>
            <code className="block text-sm font-mono mt-0.5">{workspaceId}</code>
          </div>
          <Button variant="ghost" size="sm" onClick={handleCopy} className="h-8 w-8 p-0">
            {copied ? (
              <Check className="h-4 w-4 text-green-500" />
            ) : (
              <Copy className="h-4 w-4 text-muted-foreground" />
            )}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-1.5">
          Use this ID as the <code className="text-[11px]">X-Workspace-Id</code> header when
          connecting external MCP clients.
        </p>
      </CardContent>
    </Card>
  );
}

// ── Component ────────────────────────────────────────────────────────

export function WorkspaceDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const id = slug ? (slug.startsWith("ws_") ? slug : `ws_${slug}`) : undefined;
  const navigate = useNavigate();
  const session = useSession();
  const isOrgAdmin = ADMIN_ROLES.has(session?.user?.orgRole ?? "");

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [userMap, setUserMap] = useState<Map<string, UserInfo>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Add member form state
  const [showAdd, setShowAdd] = useState(false);
  const [allUsers, setAllUsers] = useState<UserInfo[]>([]);
  const [addUserId, setAddUserId] = useState("");
  const [addRole, setAddRole] = useState<"member" | "admin">("member");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Remove in progress
  const [removingId, setRemovingId] = useState<string | null>(null);

  // ── Fetch data ──────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    if (!id) return;
    try {
      setError(null);

      // Fetch workspace list and members in parallel
      const [wsRes, membersRes, usersRes] = await Promise.all([
        callTool("nb", "manage_workspaces", { action: "list" }),
        callTool("nb", "manage_workspaces", { action: "list_members", workspaceId: id }),
        callTool("nb", "manage_users", { action: "list" }),
      ]);

      // Parse workspace list and find this workspace
      const wsData = parseToolResponse<{ workspaces: Workspace[] }>(wsRes);
      const ws = wsData.workspaces?.find((w) => w.id === id);
      if (!ws) {
        setNotFound(true);
        return;
      }
      setWorkspace(ws);

      // Parse members
      const membersData = parseToolResponse<{ workspaceId: string; members: Member[] }>(membersRes);
      setMembers(membersData.members ?? []);

      // Parse users into a lookup map
      const usersData = parseToolResponse<{ users: UserInfo[] }>(usersRes);
      const map = new Map<string, UserInfo>();
      for (const u of usersData.users ?? []) {
        map.set(u.id, u);
      }
      setUserMap(map);
      setAllUsers(usersData.users ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workspace");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ── Add member ────────────────────────────────────────────────

  const handleAdd = useCallback(async () => {
    if (!addUserId || !id) return;
    setAdding(true);
    setAddError(null);
    try {
      await callTool("nb", "manage_workspaces", {
        action: "add_member",
        workspaceId: id,
        userId: addUserId,
        role: addRole,
      });
      setAddUserId("");
      setAddRole("member");
      setShowAdd(false);
      await fetchData();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed to add member");
    } finally {
      setAdding(false);
    }
  }, [addUserId, addRole, id, fetchData]);

  // ── Remove member ─────────────────────────────────────────────

  const handleRemove = useCallback(
    async (userId: string) => {
      if (!id) return;
      const user = userMap.get(userId);
      const label = user?.displayName ?? userId;
      const confirmed = window.confirm(`Remove "${label}" from this workspace?`);
      if (!confirmed) return;
      setRemovingId(userId);
      try {
        await callTool("nb", "manage_workspaces", {
          action: "remove_member",
          workspaceId: id,
          userId,
        });
        await fetchData();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to remove member");
      } finally {
        setRemovingId(null);
      }
    },
    [id, userMap, fetchData],
  );

  // ── Derived state ─────────────────────────────────────────────

  const currentUserId = session?.user?.id;
  const adminCount = members.filter((m) => m.role === "admin").length;
  const memberUserIds = new Set(members.map((m) => m.userId));
  const availableUsers = allUsers.filter((u) => !memberUserIds.has(u.id));

  // Check if current user is a workspace admin (or org admin)
  const isWsAdmin =
    isOrgAdmin || members.some((m) => m.userId === currentUserId && m.role === "admin");

  // ── Back button ───────────────────────────────────────────────

  const goBack = () => navigate("/settings/workspaces");

  // ── Loading state ─────────────────────────────────────────────

  if (loading) {
    return <div className="text-muted-foreground text-sm">Loading workspace...</div>;
  }

  // ── Not found ─────────────────────────────────────────────────

  if (notFound) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-destructive">Workspace not found.</p>
        <Button variant="outline" size="sm" onClick={goBack}>
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          Back to Workspaces
        </Button>
      </div>
    );
  }

  // ── Error state ───────────────────────────────────────────────

  if (error && !workspace) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{error}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setLoading(true);
            fetchData();
          }}
        >
          Retry
        </Button>
      </div>
    );
  }

  // ── Main render ───────────────────────────────────────────────

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={goBack} className="h-8 w-8 p-0">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h3 className="text-lg font-semibold">{workspace?.name}</h3>
          <p className="text-sm text-muted-foreground">
            Created {formatDate(workspace?.createdAt)}
          </p>
        </div>
      </div>

      {/* Workspace ID — copyable for MCP client configuration */}
      {id && <CopyableWorkspaceId workspaceId={id} />}

      {/* Inline error banner */}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* ── Members Section ──────────────────────────────────────── */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            <h4 className="text-sm font-semibold">Members</h4>
          </div>
          {isWsAdmin && (
            <Button
              size="sm"
              variant={showAdd ? "outline" : "default"}
              onClick={() => {
                setShowAdd(!showAdd);
                setAddError(null);
              }}
            >
              {showAdd ? (
                "Cancel"
              ) : (
                <>
                  <Plus className="mr-1.5 h-4 w-4" />
                  Add Member
                </>
              )}
            </Button>
          )}
        </div>

        {/* Add member form */}
        {showAdd && (
          <Card>
            <CardContent className="py-4 space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="add-member-user">User</Label>
                  {availableUsers.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-2">
                      All users are already members of this workspace.
                    </p>
                  ) : (
                    <select
                      id="add-member-user"
                      value={addUserId}
                      onChange={(e) => setAddUserId(e.target.value)}
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <option value="">Select a user...</option>
                      {availableUsers.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.displayName} ({u.email})
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="add-member-role">Role</Label>
                  <select
                    id="add-member-role"
                    value={addRole}
                    onChange={(e) => setAddRole(e.target.value as "member" | "admin")}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
              </div>
              {addError && <p className="text-sm text-destructive">{addError}</p>}
              <Button size="sm" onClick={handleAdd} disabled={adding || !addUserId}>
                {adding ? "Adding..." : "Add Member"}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Members table */}
        {members.length === 0 ? (
          <div className="rounded-md border border-dashed p-8 text-center">
            <p className="text-sm text-muted-foreground">No members in this workspace.</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Display Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                {isWsAdmin && <TableHead className="w-[60px]" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => {
                const user = userMap.get(m.userId);
                const isLastAdmin = m.role === "admin" && adminCount <= 1;
                const isSelfLastAdmin = m.userId === currentUserId && isLastAdmin;
                const isRemoving = removingId === m.userId;

                return (
                  <TableRow key={m.userId}>
                    <TableCell className="font-medium">{user?.displayName ?? m.userId}</TableCell>
                    <TableCell>{user?.email ?? "\u2014"}</TableCell>
                    <TableCell>
                      <RoleBadge role={m.role} />
                    </TableCell>
                    {isWsAdmin && (
                      <TableCell>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={isSelfLastAdmin || isRemoving}
                          title={
                            isSelfLastAdmin
                              ? "Cannot remove the last admin"
                              : `Remove ${user?.displayName ?? m.userId}`
                          }
                          onClick={() => handleRemove(m.userId)}
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

      {/*
        Workspace Instructions are intentionally NOT shown on this admin
        "manage another workspace" page. The instructions resource and
        write tool resolve the target workspace from the request context
        (active workspace via `X-Workspace-Id`), so editing here would
        silently affect the *active* workspace, not the slug-targeted one.
        To edit a workspace's instructions, switch into it via the header
        switcher and use Settings → This Workspace → General.

        See the "How to edit instructions" affordance below.
      */}
      <div className="rounded-md border border-dashed p-4">
        <p className="text-sm text-muted-foreground">
          To view or edit this workspace's custom instructions, switch into{" "}
          <span className="font-medium">{workspace?.name}</span> via the header workspace switcher,
          then go to <span className="font-medium">Settings → This Workspace → General</span>.
        </p>
      </div>

      {/* ── Bundles Section ──────────────────────────────────────── */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Package className="h-4 w-4 text-muted-foreground" />
          <h4 className="text-sm font-semibold">Installed Bundles</h4>
        </div>
        {!workspace?.bundles || workspace.bundles.length === 0 ? (
          <div className="rounded-md border border-dashed p-8 text-center">
            <p className="text-sm text-muted-foreground">No bundles installed.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {workspace.bundles.map((b, i) => (
              <Card key={b.name ?? b.path ?? i}>
                <CardContent className="py-3 px-4">
                  <span className="text-sm font-medium">
                    {b.name ?? b.path ?? "Unknown bundle"}
                  </span>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
