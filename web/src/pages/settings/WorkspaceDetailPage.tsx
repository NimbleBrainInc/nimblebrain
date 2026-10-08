import { Package, Plus, Trash2, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { callToolWithoutWorkspace } from "../../api/client";
import { parseToolResult } from "../../api/tool-result";
import { ConnectorIcon } from "../../components/connectors/ConnectorIcon";
import { useNotice } from "../../components/notices";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { ConfirmDialog } from "../../components/ui/confirm-dialog";
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
import { Tooltip } from "../../components/ui/tooltip";
import { useSession } from "../../context/SessionContext";
import { canManageWorkspaceMembers } from "../../hooks/useScopedRole";
import {
  CopyableWorkspaceId,
  EmptyState,
  InlineError,
  Section,
  SettingsPageHeader,
} from "./components";

/** One installed connector as `manage_workspaces list` names it. */
interface WorkspaceConnector {
  serverName: string;
  name: string;
  iconUrl?: string;
}

interface Workspace {
  id: string;
  name: string;
  memberCount: number;
  connectors?: WorkspaceConnector[];
  createdAt?: string;
}

interface Member {
  userId: string;
  /** The server's membership roles — the same union `canWriteWorkspace` reads. */
  role: "admin" | "member";
}

/**
 * The signed-in user's membership role in the workspace this page is showing,
 * or `undefined` when they aren't a member of it.
 *
 * Exported so the gate's *argument* is testable, not just the rule it feeds.
 * The rule (`canManageWorkspaceMembers`) is pinned in `useScopedRole.test.ts`; pinning
 * it doesn't pin this lookup, which is where this page could go wrong.
 *
 * The `userId` guard is load-bearing: `currentUserId` is `session?.user?.id`
 * and can be undefined while the session loads. Without it, `find` would match
 * any member record whose `userId` were also undefined.
 */
export function memberRoleFor(members: Member[], userId: string | undefined) {
  return userId ? members.find((m) => m.userId === userId)?.role : undefined;
}

interface UserInfo {
  id: string;
  email: string;
  displayName: string;
  orgRole: string;
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

/** Resolves a route slug to a workspace id, tolerating a missing "ws_" prefix. */
function resolveWorkspaceId(slug: string | undefined): string | undefined {
  if (!slug) return undefined;
  return slug.startsWith("ws_") ? slug : `ws_${slug}`;
}

/**
 * Org-admin "manage another workspace" page. Composite layout (back-nav +
 * three sections) so we don't jam it into a generic FormPage / ListPage —
 * built directly from `SettingsPageHeader` + `Section` instead.
 *
 * Route: /org/workspaces/:slug
 */
export function WorkspaceDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const id = resolveWorkspaceId(slug);
  const session = useSession();
  const notify = useNotice();

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

  const [removing, setRemoving] = useState<Member | null>(null);

  const fetchData = useCallback(async () => {
    if (!id) return;
    try {
      setError(null);

      const [wsRes, membersRes, usersRes] = await Promise.all([
        callToolWithoutWorkspace("nb", "manage_workspaces", { action: "list" }),
        callToolWithoutWorkspace("nb", "manage_workspaces", {
          action: "list_members",
          workspaceId: id,
        }),
        callToolWithoutWorkspace("nb", "manage_users", { action: "list" }),
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

  const memberName = useCallback(
    (userId: string) => userMap.get(userId)?.displayName ?? userId,
    [userMap],
  );

  const handleAdd = useCallback(async () => {
    if (!addUserId || !id) return;
    setAdding(true);
    setAddError(null);
    try {
      // A refusal comes back as a result, not a throw; parseToolResult throws on
      // it, so the form keeps its values and shows the reason.
      const res = await callToolWithoutWorkspace("nb", "manage_workspaces", {
        action: "add_member",
        workspaceId: id,
        userId: addUserId,
        role: addRole,
      });
      parseToolResult(res);
      notify({
        level: "success",
        title: `${memberName(addUserId)} was added to ${workspace?.name ?? "the workspace"}`,
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
  }, [addUserId, addRole, id, fetchData, notify, memberName, workspace?.name]);

  // Throwing keeps the dialog open with the refusal shown (ConfirmDialog), and
  // parseToolResult throws on a refusal, which the tool returns as a result.
  // On success the dialog is ours to close, before the re-read, so a failed
  // refresh never reports inside a dialog whose removal already landed.
  const removeMember = useCallback(
    async (member: Member) => {
      if (!id) return;
      const res = await callToolWithoutWorkspace("nb", "manage_workspaces", {
        action: "remove_member",
        workspaceId: id,
        userId: member.userId,
      });
      parseToolResult(res);
      notify({
        level: "success",
        title: `${memberName(member.userId)} was removed from ${workspace?.name ?? "the workspace"}`,
      });
      setRemoving(null);
      await fetchData();
    },
    [id, notify, memberName, workspace?.name, fetchData],
  );

  const currentUserId = session?.user?.id;
  const adminCount = members.filter((m) => m.role === "admin").length;
  const memberUserIds = new Set(members.map((m) => m.userId));
  const availableUsers = allUsers.filter((u) => !memberUserIds.has(u.id));

  // Same rule as the server's `canManageWorkspaceMembers`: an org admin,
  // or an admin member of this workspace. A gate that disagrees with the server
  // renders controls it refuses, and `handleAdd` doesn't inspect the result,
  // so the refusal would be silent (#749). This page addresses a workspace by
  // id, so it passes that workspace's membership role rather than using the
  // active-workspace hook (which would answer for the viewer's focused
  // workspace, not this one).
  const canManageMembers = canManageWorkspaceMembers(
    session?.user?.orgRole,
    memberRoleFor(members, currentUserId),
  );

  // The org-scoped Workspaces list lives at /org/workspaces.
  const backTo = "/org/workspaces";

  // The page header (title + back-nav) renders across all states —
  // loading, notFound, error-without-data, and the loaded view — so the
  // user always knows which page they're on and has a path back.
  // WorkspaceDetailPage is a composite (back-nav + multiple sections) so
  // it doesn't compose through one of the page-kind templates; we render
  // the chrome manually here.
  const back = { to: backTo, label: "Back to workspaces" };

  if (loading) {
    return (
      <div className="space-y-6">
        <SettingsPageHeader title="Workspace" back={back} />
        <p className="text-sm text-muted-foreground">Loading workspace...</p>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="space-y-6">
        <SettingsPageHeader title="Workspace not found" back={back} />
        <p className="text-sm text-destructive">
          This workspace doesn't exist or has been deleted.
        </p>
      </div>
    );
  }

  if (error && !workspace) {
    return (
      <div className="space-y-6">
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
    <div className="space-y-6">
      <SettingsPageHeader
        title={workspace?.name ?? "Workspace"}
        description={`Created ${formatDate(workspace?.createdAt)}`}
        back={back}
      />

      {error ? <InlineError message={error} /> : null}

      <Section title="Workspace ID" flush>
        {id ? <CopyableWorkspaceId workspaceId={id} /> : null}
      </Section>

      <Section
        title="Members"
        icon={<Users className="h-4 w-4" />}
        action={
          canManageMembers ? (
            <AddMemberButton
              showAdd={showAdd}
              onToggle={() => {
                setShowAdd(!showAdd);
                setAddError(null);
              }}
            />
          ) : null
        }
      >
        <div className="space-y-4">
          {showAdd ? (
            <AddMemberForm
              availableUsers={availableUsers}
              addUserId={addUserId}
              setAddUserId={setAddUserId}
              addRole={addRole}
              setAddRole={setAddRole}
              addError={addError}
              adding={adding}
              onAdd={handleAdd}
            />
          ) : null}

          {members.length === 0 ? (
            <EmptyState message="No members in this workspace." />
          ) : (
            <MembersTable
              members={members}
              userMap={userMap}
              canManageMembers={canManageMembers}
              adminCount={adminCount}
              currentUserId={currentUserId}
              onRemove={setRemoving}
            />
          )}
        </div>

        <ConfirmDialog
          open={removing !== null}
          onOpenChange={(open) => {
            if (!open) setRemoving(null);
          }}
          title={`Remove ${removing ? memberName(removing.userId) : ""}?`}
          description="They'll lose access to this workspace's conversations, files, and apps. You can add them back later."
          confirmLabel="Remove"
          pendingLabel="Removing…"
          destructive
          onConfirm={async () => {
            if (removing) await removeMember(removing);
          }}
        />
      </Section>

      {/*
        Workspace Instructions are intentionally NOT shown here. The
        instructions resource and write tool resolve the target workspace
        from the request context (active workspace), so editing here
        would silently affect the *active* workspace, not the slug-targeted
        one. To edit a workspace's instructions, switch into it with the
        sidebar's workspace switcher and open its settings → General.
      */}
      <Section title="Installed connectors" icon={<Package className="h-4 w-4" />}>
        <ConnectorsList connectors={workspace?.connectors} />
      </Section>
    </div>
  );
}

/** Toggle button in the Members section header for opening the add-member form. */
function AddMemberButton({ showAdd, onToggle }: { showAdd: boolean; onToggle: () => void }) {
  return (
    <Button size="sm" variant={showAdd ? "outline" : "default"} onClick={onToggle}>
      {showAdd ? (
        "Cancel"
      ) : (
        <>
          <Plus className="mr-1 h-4 w-4" />
          Add member
        </>
      )}
    </Button>
  );
}

/** Card form for adding a user to the workspace with a chosen role. */
function AddMemberForm({
  availableUsers,
  addUserId,
  setAddUserId,
  addRole,
  setAddRole,
  addError,
  adding,
  onAdd,
}: {
  availableUsers: UserInfo[];
  addUserId: string;
  setAddUserId: (value: string) => void;
  addRole: "member" | "admin";
  setAddRole: (value: "member" | "admin") => void;
  addError: string | null;
  adding: boolean;
  onAdd: () => void;
}) {
  return (
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
        <Button size="sm" onClick={onAdd} disabled={adding || !addUserId}>
          {adding ? "Adding..." : "Add member"}
        </Button>
      </CardContent>
    </Card>
  );
}

/** Table of workspace members with per-row remove controls for admins. */
function MembersTable({
  members,
  userMap,
  canManageMembers,
  adminCount,
  currentUserId,
  onRemove,
}: {
  members: Member[];
  userMap: Map<string, UserInfo>;
  canManageMembers: boolean;
  adminCount: number;
  currentUserId: string | undefined;
  onRemove: (member: Member) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Email</TableHead>
          <TableHead>Role</TableHead>
          {canManageMembers && <TableHead className="w-[60px]" />}
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.map((m) => {
          const user = userMap.get(m.userId);
          const isLastAdmin = m.role === "admin" && adminCount <= 1;
          const isSelfLastAdmin = m.userId === currentUserId && isLastAdmin;
          const name = user?.displayName ?? m.userId;

          return (
            <TableRow key={m.userId}>
              <TableCell className="font-medium">{user?.displayName ?? m.userId}</TableCell>
              <TableCell>{user?.email ?? "—"}</TableCell>
              <TableCell>
                <RoleBadge role={m.role} />
              </TableCell>
              {canManageMembers && (
                <TableCell>
                  <Tooltip label={isSelfLastAdmin ? "The last admin can't be removed" : "Remove"}>
                    <Button
                      size="sm"
                      variant="ghost"
                      // aria-disabled, not disabled: a disabled button takes no
                      // pointer events, so its tooltip could not explain why.
                      aria-disabled={isSelfLastAdmin}
                      aria-label={`Remove ${name}`}
                      onClick={() => {
                        if (!isSelfLastAdmin) onRemove(m);
                      }}
                      className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive aria-disabled:opacity-40 aria-disabled:hover:text-muted-foreground"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </Tooltip>
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/**
 * Renders the installed connectors as one compact list, icon and name per row,
 * with the same icon and density as the Connectors page. Empty state when none.
 */
function ConnectorsList({ connectors }: { connectors?: WorkspaceConnector[] }) {
  if (!connectors || connectors.length === 0) {
    return <EmptyState message="No connectors installed." />;
  }
  return (
    <ul className="rounded-md border border-border divide-y divide-border">
      {connectors.map((c) => (
        <li key={c.serverName} className="flex items-center gap-3 px-3 py-2">
          <ConnectorIcon name={c.name} iconUrl={c.iconUrl} className="h-7 w-7 rounded text-xs" />
          <span className="text-sm font-medium truncate">{c.name}</span>
        </li>
      ))}
    </ul>
  );
}
