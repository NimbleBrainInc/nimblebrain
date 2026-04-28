import { Trash2, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { callTool } from "../../api/client";
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

interface User {
  id: string;
  email: string;
  displayName: string;
  orgRole: string;
  createdAt?: string;
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

export function UsersTab() {
  const session = useSession();
  const currentUserId = session?.user?.id;

  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [createEmail, setCreateEmail] = useState("");
  const [createName, setCreateName] = useState("");
  const [createRole, setCreateRole] = useState<"member" | "admin">("member");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchUsers = useCallback(async () => {
    try {
      setError(null);
      const res = await callTool("nb", "manage_users", { action: "list" });
      const data = parseToolResult<{ users: User[] }>(res);
      setUsers(data.users ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load users");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleCreate = useCallback(async () => {
    if (!createEmail.trim() || !createName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      await callTool("nb", "manage_users", {
        action: "create",
        email: createEmail.trim(),
        displayName: createName.trim(),
        orgRole: createRole,
      });
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
        `Delete user "${displayName}"? This action cannot be undone.`,
      );
      if (!confirmed) return;
      setDeletingId(userId);
      try {
        await callTool("nb", "manage_users", { action: "delete", userId });
        await fetchUsers();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete user");
      } finally {
        setDeletingId(null);
      }
    },
    [fetchUsers],
  );

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading users...</p>;
  }

  if (error && users.length === 0) {
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
                fetchUsers();
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
      title="Users"
      description="Manage organization users and their roles."
      loadError={error && users.length > 0 ? error : null}
      create={{
        label: "Create User",
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
                <Label htmlFor="create-name">Display Name</Label>
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
              {creating ? "Creating..." : "Create User"}
            </Button>
          </>
        ),
      }}
    >
      {users.length === 0 ? (
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
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Display Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-[60px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => {
              const isSelf = u.id === currentUserId;
              const isDeleting = deletingId === u.id;
              return (
                <TableRow key={u.id}>
                  <TableCell className="font-medium">{u.displayName}</TableCell>
                  <TableCell>{u.email}</TableCell>
                  <TableCell>
                    <RoleBadge role={u.orgRole} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(u.createdAt)}</TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={isSelf || isDeleting}
                      title={isSelf ? "Cannot delete yourself" : `Delete ${u.displayName}`}
                      onClick={() => handleDelete(u.id, u.displayName)}
                      className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </SettingsListPage>
  );
}
