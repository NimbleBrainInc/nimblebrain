import { Pencil, RotateCcw, Trash2, UserPlus } from "lucide-react";
import { Fragment, useCallback, useEffect, useState } from "react";
import { callToolWithoutWorkspace } from "../../api/client";
import { parseToolResult } from "../../api/tool-result";
import { Button } from "../../components/ui/button";
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
import { useSession } from "../../context/SessionContext";
import { EmptyState, InlineError, SettingsListPage } from "./components";
import { UserEditor } from "./UserEditor";
import type { OrgRole } from "./user-edit-patch";

interface User {
  id: string;
  email: string;
  displayName: string;
  orgRole: OrgRole;
  createdAt?: string;
  /** Set when the user is deactivated (soft-deleted). Such users keep their record but cannot sign in. */
  deletedAt?: string;
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

/**
 * Row actions: restores a deactivated user, otherwise edits or deactivates an
 * active one. A deactivated user has no Edit: the server refuses to edit them
 * until they are restored.
 */
function UserRowAction({
  user,
  isSelf,
  isBusy,
  isDeactivated,
  isEditing,
  onEdit,
  onDelete,
  onRestore,
}: {
  user: User;
  isSelf: boolean;
  isBusy: boolean;
  isDeactivated: boolean;
  isEditing: boolean;
  onEdit: (userId: string) => void;
  onDelete: (userId: string, displayName: string) => void;
  onRestore: (userId: string) => void;
}) {
  if (isDeactivated) {
    return (
      <Button
        size="sm"
        variant="ghost"
        disabled={isBusy}
        title={`Restore ${user.displayName}`}
        onClick={() => onRestore(user.id)}
        className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
      >
        <RotateCcw className="h-4 w-4" />
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <Button
        size="sm"
        variant="ghost"
        title={isEditing ? `Close editor for ${user.displayName}` : `Edit ${user.displayName}`}
        aria-expanded={isEditing}
        onClick={() => onEdit(user.id)}
        className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
      >
        <Pencil className="h-4 w-4" />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={isSelf || isBusy}
        title={isSelf ? "Cannot deactivate yourself" : `Deactivate ${user.displayName}`}
        onClick={() => onDelete(user.id, user.displayName)}
        className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

/** One users-table row: identity columns plus the edit, deactivate and restore actions. */
function UserRow({
  user,
  isSelf,
  isBusy,
  isEditing,
  onEdit,
  onDelete,
  onRestore,
}: {
  user: User;
  isSelf: boolean;
  isBusy: boolean;
  isEditing: boolean;
  onEdit: (userId: string) => void;
  onDelete: (userId: string, displayName: string) => void;
  onRestore: (userId: string) => void;
}) {
  const isDeactivated = Boolean(user.deletedAt);
  return (
    <TableRow className={isDeactivated ? "opacity-60" : undefined}>
      <TableCell className="font-medium">
        {user.displayName}
        {isDeactivated ? (
          <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
            Deactivated
          </span>
        ) : null}
      </TableCell>
      <TableCell>{user.email}</TableCell>
      <TableCell>
        <RoleBadge role={user.orgRole} />
      </TableCell>
      <TableCell className="text-muted-foreground">{formatDate(user.createdAt)}</TableCell>
      <TableCell>
        <UserRowAction
          user={user}
          isSelf={isSelf}
          isBusy={isBusy}
          isDeactivated={isDeactivated}
          isEditing={isEditing}
          onEdit={onEdit}
          onDelete={onDelete}
          onRestore={onRestore}
        />
      </TableCell>
    </TableRow>
  );
}

/**
 * The users table: a column header plus one {@link UserRow} per user, and the
 * open user's {@link UserEditor} in a full-width row beneath theirs.
 */
function UsersTable({
  users,
  currentUserId,
  busyId,
  editingId,
  providerOwnedFields,
  onEdit,
  onSaved,
  onDelete,
  onRestore,
}: {
  users: User[];
  currentUserId?: string;
  busyId: string | null;
  editingId: string | null;
  providerOwnedFields: readonly string[];
  onEdit: (userId: string) => void;
  onSaved: () => void;
  onDelete: (userId: string, displayName: string) => void;
  onRestore: (userId: string) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Display name</TableHead>
          <TableHead>Email</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Created</TableHead>
          <TableHead className="w-[84px]" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.map((u) => {
          const isEditing = editingId === u.id && !u.deletedAt;
          return (
            <Fragment key={u.id}>
              <UserRow
                user={u}
                isSelf={u.id === currentUserId}
                isBusy={busyId === u.id}
                isEditing={isEditing}
                onEdit={onEdit}
                onDelete={onDelete}
                onRestore={onRestore}
              />
              {isEditing ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={5} className="whitespace-normal">
                    <UserEditor
                      user={u}
                      isSelf={u.id === currentUserId}
                      providerOwnedFields={providerOwnedFields}
                      onSaved={onSaved}
                    />
                  </TableCell>
                </TableRow>
              ) : null}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function UsersTab() {
  const session = useSession();
  const currentUserId = session?.user?.id;

  const [users, setUsers] = useState<User[]>([]);
  const [providerOwnedFields, setProviderOwnedFields] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [createEmail, setCreateEmail] = useState("");
  const [createName, setCreateName] = useState("");
  const [createRole, setCreateRole] = useState<"member" | "admin">("member");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchUsers = useCallback(async () => {
    try {
      setError(null);
      const res = await callToolWithoutWorkspace("nb", "manage_users", { action: "list" });
      const data = parseToolResult<{ users: User[]; providerOwnedFields?: string[] }>(res);
      setUsers(data.users ?? []);
      setProviderOwnedFields(data.providerOwnedFields ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load users");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  // A saved edit re-reads the list, so the row shows it.
  const refreshAfterEdit = useCallback(() => {
    void fetchUsers();
  }, [fetchUsers]);

  const toggleEdit = useCallback((userId: string) => {
    setEditingId((open) => (open === userId ? null : userId));
  }, []);

  const handleCreate = useCallback(async () => {
    if (!createEmail.trim() || !createName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      // A refusal comes back as a result, not a throw; parseToolResult throws on
      // it, so each handler below reports it instead of carrying on as if done.
      const res = await callToolWithoutWorkspace("nb", "manage_users", {
        action: "create",
        email: createEmail.trim(),
        displayName: createName.trim(),
        orgRole: createRole,
      });
      parseToolResult(res);
      setCreateEmail("");
      setCreateName("");
      setCreateRole("member");
      setShowCreate(false);
      await fetchUsers();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create user");
    } finally {
      setCreating(false);
    }
  }, [createEmail, createName, createRole, fetchUsers]);

  const handleDelete = useCallback(
    async (userId: string, displayName: string) => {
      const confirmed = window.confirm(
        `Deactivate user "${displayName}"? They will immediately lose access. You can restore them later.`,
      );
      if (!confirmed) return;
      setBusyId(userId);
      try {
        parseToolResult(
          await callToolWithoutWorkspace("nb", "manage_users", { action: "delete", userId }),
        );
        await fetchUsers();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to deactivate user");
      } finally {
        setBusyId(null);
      }
    },
    [fetchUsers],
  );

  const handleRestore = useCallback(
    async (userId: string) => {
      setBusyId(userId);
      try {
        parseToolResult(
          await callToolWithoutWorkspace("nb", "manage_users", { action: "restore", userId }),
        );
        await fetchUsers();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to restore user");
      } finally {
        setBusyId(null);
      }
    },
    [fetchUsers],
  );

  // Loading and load-error states route through the template so the page
  // header stays put across loading → loaded → error transitions.
  return (
    <SettingsListPage
      title="Users"
      description="Manage organization users and their roles."
      loading={loading}
      loadingMessage="Loading users..."
      loadError={error}
      create={{
        label: "Create user",
        icon: <UserPlus className="mr-1 h-4 w-4" />,
        showing: showCreate,
        onToggle: () => {
          setShowCreate((s) => !s);
          setCreateError(null);
        },
        form: (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="create-email">Email</Label>
                <Input
                  id="create-email"
                  type="email"
                  value={createEmail}
                  onChange={(e) => setCreateEmail(e.target.value)}
                  placeholder="user@example.com"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="create-name">Display name</Label>
                <Input
                  id="create-name"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="Jane Doe"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="create-role">Role</Label>
                <Select
                  id="create-role"
                  value={createRole}
                  onChange={(e) => setCreateRole(e.target.value as "member" | "admin")}
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </Select>
              </div>
            </div>
            {createError ? <InlineError message={createError} /> : null}
            <Button
              size="sm"
              onClick={handleCreate}
              disabled={creating || !createEmail.trim() || !createName.trim()}
            >
              {creating ? "Creating..." : "Create user"}
            </Button>
          </>
        ),
      }}
    >
      {users.length === 0 && !error ? (
        // Genuine "load succeeded but list is empty" — invite the user to
        // create the first item. Hidden when `error` is set so the
        // failure banner above isn't contradicted by a "No users yet"
        // message implying an empty (but loaded) list.
        <EmptyState
          message="No users yet."
          action={
            !showCreate ? (
              <Button size="sm" variant="outline" onClick={() => setShowCreate(true)}>
                <UserPlus className="mr-1 h-4 w-4" />
                Create the first user
              </Button>
            ) : null
          }
        />
      ) : users.length === 0 && error ? (
        // Load failed and we have nothing to show — surface a Retry button
        // beneath the error banner. The page owns retry semantics
        // (knows how to refetch).
        <div className="flex justify-center pt-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setLoading(true);
              fetchUsers();
            }}
          >
            Retry
          </Button>
        </div>
      ) : (
        <UsersTable
          users={users}
          currentUserId={currentUserId}
          busyId={busyId}
          editingId={editingId}
          providerOwnedFields={providerOwnedFields}
          onEdit={toggleEdit}
          onSaved={refreshAfterEdit}
          onDelete={handleDelete}
          onRestore={handleRestore}
        />
      )}
    </SettingsListPage>
  );
}
