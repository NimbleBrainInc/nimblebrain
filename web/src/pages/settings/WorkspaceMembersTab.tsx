import { Trash2, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { callTool } from "../../api/client";
import { parseToolResult } from "../../api/tool-result";
import { useNotice } from "../../components/notices";
import { Button } from "../../components/ui/button";
import { ConfirmDialog } from "../../components/ui/confirm-dialog";
import { Input } from "../../components/ui/input";
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
import { useWorkspaceContext, type WorkspaceInfo } from "../../context/WorkspaceContext";
import { canManageWorkspaceMembers } from "../../hooks/useScopedRole";
import { EmptyState, InlineError, RequireActiveWorkspace, SettingsListPage } from "./components";

/**
 * Workspace "Members" tab — who is in the workspace, and, for those who may
 * manage it, adding people, changing roles, and removing them.
 *
 * Route: /w/:slug/settings/members (the workspace is the URL slug).
 * Permission: any member reads the roster (`canReadWorkspaceMembers`).
 * Managing it is `canManageWorkspaceMembers`: a workspace admin member or an
 * org admin, the one workspace gate with an org-admin bypass (web/AGENTS.md).
 *
 * A person is added by email, so a workspace admin who cannot list the
 * organization's users can still add someone in it. A role change saves as it
 * changes, with Undo in its notice; a removal asks first, since it takes away
 * access.
 */
export function WorkspaceMembersTab() {
  return (
    <RequireActiveWorkspace>
      <ForActiveWorkspace />
    </RequireActiveWorkspace>
  );
}

/** Keyed by the workspace, so a switch never shows one workspace's roster under another. */
function ForActiveWorkspace() {
  const { activeWorkspace } = useWorkspaceContext();
  // RequireActiveWorkspace guarantees activeWorkspace is non-null here.
  const ws = activeWorkspace!;
  return <Inner key={ws.id} ws={ws} />;
}

type Role = "admin" | "member";

interface Member {
  userId: string;
  role: Role;
  displayName: string;
  email: string;
  /** Set when the member's user account is deactivated (soft-deleted). */
  deletedAt?: string;
}

function Inner({ ws }: { ws: WorkspaceInfo }) {
  const session = useSession();
  const notify = useNotice();
  const navigate = useNavigate();
  const { refreshWorkspaces } = useWorkspaceContext();
  const currentUserId = session?.user?.id;
  const canManage = canManageWorkspaceMembers(session?.user?.orgRole, ws.userRole);

  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // `?add` opens the add form on arrival: the overview's "Invite people" lands here.
  const [searchParams] = useSearchParams();
  const [showAdd, setShowAdd] = useState(() => searchParams.has("add"));
  const [removing, setRemoving] = useState<Member | null>(null);

  // Every call names this workspace, so one finishing after a switch still
  // lands where it was made.
  const call = useCallback(
    (args: Record<string, unknown>) =>
      callTool("nb", "manage_workspaces", { workspaceId: ws.id, ...args }, { workspaceId: ws.id }),
    [ws.id],
  );

  const fetchMembers = useCallback(async (): Promise<Member[]> => {
    try {
      setError(null);
      const res = await call({ action: "list_members" });
      const next = parseToolResult<{ members: Member[] }>(res).members ?? [];
      setMembers(next);
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load members");
      return [];
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => {
    void fetchMembers();
  }, [fetchMembers]);

  // A change to your own seat changes what you may do here (or whether you are
  // here at all), so the workspace list, which carries your role, re-reads.
  const afterOwnChange = useCallback(() => {
    refreshWorkspaces().catch(() => {});
  }, [refreshWorkspaces]);

  const setRole = useCallback(
    async (member: Member, role: Role, opts: { undo: boolean }) => {
      const previous = member.role;
      try {
        parseToolResult(await call({ action: "update_member", userId: member.userId, role }));
      } catch (err) {
        notify({
          level: "error",
          title: `${member.displayName}'s role was not changed`,
          description: err instanceof Error ? err.message : undefined,
        });
        return;
      }
      await fetchMembers();
      if (member.userId === currentUserId) afterOwnChange();
      if (!opts.undo) return;
      notify({
        level: "success",
        title: `${member.displayName} is now ${role === "admin" ? "an admin" : "a member"}`,
        // The Undo's own change raises no notice, so it never offers Undo of the Undo.
        action: {
          label: "Undo",
          onClick: () => void setRole({ ...member, role }, previous, { undo: false }),
        },
      });
    },
    [call, notify, fetchMembers, currentUserId, afterOwnChange],
  );

  const remove = useCallback(
    async (member: Member) => {
      // Throwing keeps the dialog open with the refusal shown (ConfirmDialog).
      // On success the dialog is ours to close, before the re-read, so it doesn't
      // hold on "Removing…" for a roster round-trip after the removal landed.
      parseToolResult(await call({ action: "remove_member", userId: member.userId }));
      notify({ level: "success", title: `${member.displayName} was removed from ${ws.name}` });
      setRemoving(null);
      if (member.userId === currentUserId) {
        // You are no longer in this workspace: leave it before its guard does.
        afterOwnChange();
        navigate("/");
        return;
      }
      await fetchMembers();
    },
    [call, notify, ws.name, currentUserId, afterOwnChange, navigate, fetchMembers],
  );

  const activeAdmins = members.filter((m) => m.role === "admin" && !m.deletedAt).length;

  return (
    <SettingsListPage
      title="Members"
      description="Everyone who can use this workspace."
      loading={loading}
      loadingMessage="Loading members…"
      loadError={error}
      create={{
        label: "Add member",
        icon: <UserPlus className="mr-1 h-4 w-4" />,
        showing: showAdd,
        canCreate: canManage,
        onToggle: () => setShowAdd((s) => !s),
        form: (
          <AddMemberForm
            onAdd={async (email, role) => {
              const res = await call({ action: "add_member", email, role });
              const { added } = parseToolResult<{ added: { userId: string } }>(res);
              setShowAdd(false);
              const roster = await fetchMembers();
              const name = roster.find((m) => m.userId === added.userId)?.displayName ?? email;
              notify({ level: "success", title: `${name} was added to ${ws.name}` });
            }}
          />
        ),
      }}
    >
      {members.length === 0 && !error ? (
        <EmptyState message="No members in this workspace." />
      ) : members.length === 0 && error ? (
        // Load failed — empty-state would imply the workspace has no
        // members when really we couldn't fetch. Offer Retry instead.
        <div className="flex justify-center pt-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setLoading(true);
              void fetchMembers();
            }}
          >
            Retry
          </Button>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead className="w-[140px]">Role</TableHead>
              {canManage && <TableHead className="w-[52px]" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((m) => (
              <MemberRow
                key={m.userId}
                member={m}
                isYou={m.userId === currentUserId}
                // The server refuses to demote or remove the last active admin;
                // the controls say so up front rather than after a round-trip.
                isLastAdmin={m.role === "admin" && !m.deletedAt && activeAdmins <= 1}
                canManage={canManage}
                onRoleChange={(role) => void setRole(m, role, { undo: true })}
                onRemove={() => setRemoving(m)}
              />
            ))}
          </TableBody>
        </Table>
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={
          removing?.userId === currentUserId
            ? `Leave ${ws.name}?`
            : `Remove ${removing?.displayName ?? ""}?`
        }
        description={
          removing?.userId === currentUserId
            ? "You'll lose access to its conversations, files, and apps until an admin adds you back."
            : "They'll lose access to this workspace's conversations, files, and apps. You can add them back later."
        }
        confirmLabel={removing?.userId === currentUserId ? "Leave" : "Remove"}
        pendingLabel="Removing…"
        destructive
        onConfirm={async () => {
          if (removing) await remove(removing);
        }}
      />
    </SettingsListPage>
  );
}

function MemberRow({
  member: m,
  isYou,
  isLastAdmin,
  canManage,
  onRoleChange,
  onRemove,
}: {
  member: Member;
  isYou: boolean;
  isLastAdmin: boolean;
  canManage: boolean;
  onRoleChange: (role: Role) => void;
  onRemove: () => void;
}) {
  const isDeactivated = Boolean(m.deletedAt);
  return (
    <TableRow className={isDeactivated ? "opacity-60" : undefined}>
      <TableCell className="font-medium">
        {m.displayName}
        {isYou ? <span className="ml-2 text-xs font-normal text-muted-foreground">You</span> : null}
        {isDeactivated ? (
          <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
            Deactivated
          </span>
        ) : null}
      </TableCell>
      <TableCell>{m.email || "—"}</TableCell>
      <TableCell>
        {canManage ? (
          <Select
            aria-label={`Role for ${m.displayName}`}
            value={m.role}
            disabled={isLastAdmin}
            onChange={(e) => onRoleChange(e.target.value as Role)}
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </Select>
        ) : (
          <RoleBadge role={m.role} />
        )}
      </TableCell>
      {canManage && (
        <TableCell>
          <Tooltip label={isLastAdmin ? "The last admin can't be removed" : "Remove"}>
            <Button
              size="sm"
              variant="ghost"
              // aria-disabled, not disabled: a disabled button takes no pointer
              // events, so its tooltip could not explain why.
              aria-disabled={isLastAdmin}
              aria-label={`Remove ${m.displayName}`}
              onClick={() => {
                if (!isLastAdmin) onRemove();
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
}

/**
 * Add someone by the email they sign in with. Explicit Add, not autosave: it
 * creates a membership, and the email and role go together.
 */
function AddMemberForm({ onAdd }: { onAdd: (email: string, role: Role) => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [role, setRoleValue] = useState<Role>("member");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = email.trim().includes("@");

  const submit = async () => {
    if (!valid || adding) return;
    setAdding(true);
    setError(null);
    try {
      await onAdd(email.trim(), role);
    } catch (err) {
      setError(err instanceof Error ? err.message : "They were not added.");
    } finally {
      setAdding(false);
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5 min-w-0 flex-1 basis-64">
          <Label htmlFor="add-member-email">Email</Label>
          <Input
            id="add-member-email"
            type="email"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@company.com"
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
        </div>
        <div className="space-y-1.5 w-36">
          <Label htmlFor="add-member-role">Role</Label>
          <Select
            id="add-member-role"
            value={role}
            onChange={(e) => setRoleValue(e.target.value as Role)}
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </Select>
        </div>
        <Button size="sm" className="h-8" onClick={() => void submit()} disabled={!valid || adding}>
          {adding ? "Adding…" : "Add"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        They need an account in your organization already.
      </p>
      {error ? <InlineError message={error} /> : null}
    </>
  );
}
