import { ChevronUp, Trash2, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { callTool } from "../../api/client";
import { Badge } from "../../components/ui/badge";
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

interface User {
  id: string;
  email: string;
  displayName: string;
  orgRole: string;
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

const ROLE_STYLES: Record<string, string> = {
  owner: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
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

export function UsersTab() {
  const session = useSession();
  const currentUserId = session?.user?.id;

  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create form state
  const [showCreate, setShowCreate] = useState(false);
  const [createEmail, setCreateEmail] = useState("");
  const [createName, setCreateName] = useState("");
  const [createRole, setCreateRole] = useState<"member" | "admin">("member");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Delete in progress
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // ── Fetch users ──────────────────────────────────────────────────

  const fetchUsers = useCallback(async () => {
    try {
      setError(null);
      const res = await callTool("nb", "manage_users", { action: "list" });
      const data = parseToolResponse<{ users: User[] }>(res);
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

  // ── Create user ──────────────────────────────────────────────────

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
      // Reset form
      setCreateEmail("");
      setCreateName("");
      setCreateRole("member");
      // Refresh list
      await fetchUsers();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create user");
    } finally {
      setCreating(false);
    }
  }, [createEmail, createName, createRole, fetchUsers]);

  // ── Delete user ──────────────────────────────────────────────────

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

  // ── Loading state ────────────────────────────────────────────────

  if (loading) {
    return <div className="text-muted-foreground text-sm">Loading users...</div>;
  }

  // ── Error state ──────────────────────────────────────────────────

  if (error && users.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{error}</p>
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
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header + Create toggle */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Users</h3>
          <p className="text-sm text-muted-foreground">Manage workspace users and their roles.</p>
        </div>
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
              <UserPlus className="mr-1.5 h-4 w-4" />
              Create User
            </>
          )}
        </Button>
      </div>

      {/* Inline error banner */}
      {error && users.length > 0 && <p className="text-sm text-destructive">{error}</p>}

      {/* Create form */}
      {showCreate && (
        <Card>
          <CardContent className="py-4 space-y-4">
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
                <select
                  id="create-role"
                  value={createRole}
                  onChange={(e) => setCreateRole(e.target.value as "member" | "admin")}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
            </div>
            {createError && <p className="text-sm text-destructive">{createError}</p>}
            <Button
              size="sm"
              onClick={handleCreate}
              disabled={creating || !createEmail.trim() || !createName.trim()}
            >
              {creating ? "Creating..." : "Create User"}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Users table */}
      {users.length === 0 ? (
        <div className="rounded-md border border-dashed p-8 text-center">
          <p className="text-sm text-muted-foreground">No users yet.</p>
          {!showCreate && (
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={() => setShowCreate(true)}
            >
              <UserPlus className="mr-1.5 h-4 w-4" />
              Create the first user
            </Button>
          )}
        </div>
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
    </div>
  );
}
