import { useCallback, useEffect, useState } from "react";
import { callTool } from "../../api/client";
import { parseToolResult } from "../../api/tool-result";
import { Button } from "../../components/ui/button";
import { RoleBadge } from "../../components/ui/role-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { useWorkspaceContext } from "../../context/WorkspaceContext";
import { EmptyState, RequireActiveWorkspace, SettingsListPage } from "./components";

/**
 * Active-workspace "Members" tab — list view.
 *
 * Edit affordances (add/remove/role-change) live on the admin path
 * (`/settings/org/workspaces/:slug` → `WorkspaceDetailPage`). This page is
 * intentionally read-only because the active-workspace surface is for
 * everyone, not just admins.
 */
export function WorkspaceMembersTab() {
  return (
    <RequireActiveWorkspace>
      <Inner />
    </RequireActiveWorkspace>
  );
}

interface Member {
  userId: string;
  role: string;
}

interface UserInfo {
  id: string;
  email: string;
  displayName: string;
}

function Inner() {
  const { activeWorkspace } = useWorkspaceContext();
  const ws = activeWorkspace!;

  const [members, setMembers] = useState<Member[]>([]);
  const [userMap, setUserMap] = useState<Map<string, UserInfo>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const [membersRes, usersRes] = await Promise.all([
        callTool("nb", "manage_workspaces", { action: "list_members", workspaceId: ws.id }),
        callTool("nb", "manage_users", { action: "list" }),
      ]);
      const membersData = parseToolResult<{ workspaceId: string; members: Member[] }>(membersRes);
      setMembers(membersData.members ?? []);
      const usersData = parseToolResult<{ users: UserInfo[] }>(usersRes);
      const map = new Map<string, UserInfo>();
      for (const u of usersData.users ?? []) map.set(u.id, u);
      setUserMap(map);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load members");
    } finally {
      setLoading(false);
    }
  }, [ws.id]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return (
    <SettingsListPage
      title="Members"
      description="Workspace admins manage membership from the organization Workspaces view."
      loading={loading}
      loadingMessage="Loading members…"
      loadError={error}
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
              void fetchData();
            }}
          >
            Retry
          </Button>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Display Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((m) => {
              const user = userMap.get(m.userId);
              return (
                <TableRow key={m.userId}>
                  <TableCell className="font-medium">{user?.displayName ?? m.userId}</TableCell>
                  <TableCell>{user?.email ?? "—"}</TableCell>
                  <TableCell>
                    <RoleBadge role={m.role} />
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
