import { Check, Copy, Package, Plus, Trash2, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { callTool } from "../../api/client";
import { parseToolResult } from "../../api/tool-result";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Label } from "../../components/ui/label";
import { RoleBadge } from "../../components/ui/role-badge";
import { Select } from "../../components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { useSession } from "../../context/SessionContext";
import { EmptyState, InlineError, Section, SettingsPageHeader } from "./components";

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

function CopyableWorkspaceId({ workspaceId }: { workspaceId: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(workspaceId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <Label className="text-xs text-muted-foreground">Workspace ID</Label>
          <code className="block text-sm font-mono mt-0.5 truncate">{workspaceId}</code>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCopy}
          className="h-8 w-8 p-0 shrink-0"
          aria-label="Copy workspace ID"
        >
          {copied ? (
            <Check className="h-4 w-4 text-success" />
          ) : (
            <Copy className="h-4 w-4 text-muted-foreground" />
          )}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Use this ID as the <code className="text-[11px]">X-Workspace-Id</code> header when
        connecting external MCP clients.
      </p>
    </div>
  );
}

/**
 * Org-admin "manage another workspace" page. Composite layout (back-nav +
 * three sections) so we don't jam it into a generic FormPage / ListPage —
 * built directly from `SettingsPageHeader` + `Section` instead.
 *
 * Route: /settings/org/workspaces/:slug
 */
export function WorkspaceDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const id = slug ? (slug.startsWith("ws_") ? slug : `ws_${slug}`) : undefined;
  const session = useSession();
  const isOrgAdmin = ADMIN_ROLES.has(session?.user?.orgRole ?? "");

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [userMap, setUserMap] = useState<Map<string, UserInfo>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [showAdd, setShowAdd] = useState(false);
  const [allUsers, setAllUsers] = useState<UserInfo[]>([]);
  const [addUserId, setAddUserId] = useState("");
  const [addRole, setAddRole] = useState<"member" | "admin">("member");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [removingId, setRemovingId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!id) return;
    try {
      setError(null);

      const [wsRes, membersRes, usersRes] = await Promise.all([
        callTool("nb", "manage_workspaces", { action: "list" }),
        callTool("nb", "manage_workspaces", { action: "list_members", workspaceId: id }),
        callTool("nb", "manage_users", { action: "list" }),
      ]);

      const wsData = parseToolResult<{ workspaces: Workspace[] }>(wsRes);
      const ws = wsData.workspaces?.find((w) => w.id === id);
      if (!ws) {
        setNotFound(true);
        return;
      }
      setWorkspace(ws);

      const membersData = parseToolResult<{ workspaceId: string; members: Member[] }>(membersRes);
      setMembers(membersData.members ?? []);

      const usersData = parseToolResult<{ users: UserInfo[] }>(usersRes);
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

  const currentUserId = session?.user?.id;
  const adminCount = members.filter((m) => m.role === "admin").length;
  const memberUserIds = new Set(members.map((m) => m.userId));
  const availableUsers = allUsers.filter((u) => !memberUserIds.has(u.id));

  const isWsAdmin =
    isOrgAdmin || members.some((m) => m.userId === currentUserId && m.role === "admin");

  // The org-scoped Workspaces list lives at /settings/org/workspaces (not
  // /settings/workspaces — that route doesn't exist). Fixing the back-nav
  // bug from the previous version.
  const backTo = "/settings/org/workspaces";

  // The page header (title + back-nav) renders across all states —
  // loading, notFound, error-without-data, and the loaded view — so the
  // user always knows which page they're on and has a path back.
  // WorkspaceDetailPage is a composite (back-nav + multiple sections) so
  // it doesn't compose through one of the page-kind templates; we render
  // the chrome manually here.
  const back = { to: backTo, label: "Back to workspaces" };

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <SettingsPageHeader title="Workspace" back={back} />
        <p className="text-sm text-muted-foreground">Loading workspace...</p>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <SettingsPageHeader title="Workspace not found" back={back} />
        <p className="text-sm text-destructive">
          This workspace doesn't exist or has been deleted.
        </p>
      </div>
    );
  }

  if (error && !workspace) {
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <SettingsPageHeader title="Workspace" back={back} />
        <InlineError message={error} />
        <div className="flex justify-center pt-2">
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
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <SettingsPageHeader
        title={workspace?.name ?? "Workspace"}
        description={`Created ${formatDate(workspace?.createdAt)}`}
        back={back}
      />

      {error ? <InlineError message={error} /> : null}

      <Section title="MCP Connection" flush>
        {id ? <CopyableWorkspaceId workspaceId={id} /> : null}
      </Section>

      <Section
        title="Members"
        icon={<Users className="h-4 w-4" />}
        action={
          isWsAdmin ? (
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
                  <Plus className="mr-1 h-4 w-4" />
                  Add Member
                </>
              )}
            </Button>
          ) : null
        }
      >
        <div className="space-y-4">
          {showAdd ? (
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
                      <Select
                        id="add-member-user"
                        value={addUserId}
                        onChange={(e) => setAddUserId(e.target.value)}
                      >
                        <option value="">Select a user...</option>
                        {availableUsers.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.displayName} ({u.email})
                          </option>
                        ))}
                      </Select>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="add-member-role">Role</Label>
                    <Select
                      id="add-member-role"
                      value={addRole}
                      onChange={(e) => setAddRole(e.target.value as "member" | "admin")}
                    >
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                    </Select>
                  </div>
                </div>
                {addError ? <InlineError message={addError} /> : null}
                <Button size="sm" onClick={handleAdd} disabled={adding || !addUserId}>
                  {adding ? "Adding..." : "Add Member"}
                </Button>
              </CardContent>
            </Card>
          ) : null}

          {members.length === 0 ? (
            <EmptyState message="No members in this workspace." />
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
                      <TableCell>{user?.email ?? "—"}</TableCell>
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
      </Section>

      {/*
        Workspace Instructions are intentionally NOT shown here. The
        instructions resource and write tool resolve the target workspace
        from the request context (active workspace), so editing here
        would silently affect the *active* workspace, not the slug-targeted
        one. To edit a workspace's instructions, switch into it via the
        header switcher and use Settings → This Workspace → General.
      */}
      <Section>
        <div className="rounded-md border border-dashed p-4">
          <p className="text-sm text-muted-foreground">
            To view or edit this workspace's custom instructions, switch into{" "}
            <span className="font-medium">{workspace?.name}</span> via the header workspace
            switcher, then go to{" "}
            <span className="font-medium">Settings → This Workspace → General</span>.
          </p>
        </div>
      </Section>

      <Section title="Installed Bundles" icon={<Package className="h-4 w-4" />}>
        {!workspace?.bundles || workspace.bundles.length === 0 ? (
          <EmptyState message="No bundles installed." />
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
      </Section>
    </div>
  );
}
