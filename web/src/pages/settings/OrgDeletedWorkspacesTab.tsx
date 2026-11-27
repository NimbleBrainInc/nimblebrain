import { RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { callToolWithoutWorkspace } from "../../api/client";
import { parseToolResult } from "../../api/tool-result";
import { Button } from "../../components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { EmptyState, SettingsListPage } from "./components";

// ── Organization → Deleted workspaces — `/org/deleted` ───────────────
//
// A deleted workspace is kept, unusable, until its purge time, and can be
// restored as it was until then. This tab lists them with their purge time,
// restores one, or purges one now.

export interface DeletedWorkspace {
  workspaceId: string;
  workspaceName: string | null;
  memberCount: number;
  deletedAt: string;
  deletedBy: string | null;
  purgeAt: string;
  restorable: boolean;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function DeletedRow({
  row,
  busy,
  onRestore,
  onPurge,
}: {
  row: DeletedWorkspace;
  busy: boolean;
  onRestore: () => void;
  onPurge: () => void;
}) {
  return (
    <TableRow>
      <TableCell className="font-medium">
        {row.workspaceName ?? <span className="text-muted-foreground italic">Unknown</span>}
      </TableCell>
      <TableCell className="font-mono text-xs">{row.workspaceId}</TableCell>
      <TableCell className="text-muted-foreground">{formatDate(row.deletedAt)}</TableCell>
      <TableCell className="text-muted-foreground">
        {row.restorable ? formatDate(row.purgeAt) : "Purging"}
      </TableCell>
      <TableCell>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !row.restorable}
            title={`Restore ${row.workspaceId}`}
            onClick={onRestore}
            className="h-8 w-8 p-0 text-muted-foreground"
          >
            <RotateCcw className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            title={`Purge ${row.workspaceId}`}
            onClick={onPurge}
            className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

export function OrgDeletedWorkspacesTab() {
  const [rows, setRows] = useState<DeletedWorkspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const fetchRows = useCallback(async () => {
    try {
      setError(null);
      const res = await callToolWithoutWorkspace("nb", "manage_workspaces", {
        action: "list_deleted",
      });
      setRows(parseToolResult<{ deleted: DeletedWorkspace[] }>(res).deleted ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load deleted workspaces");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  const act = useCallback(
    async (row: DeletedWorkspace, action: "restore" | "purge") => {
      if (action === "purge") {
        const label = row.workspaceName
          ? `"${row.workspaceName}" (${row.workspaceId})`
          : row.workspaceId;
        const confirmed = window.confirm(
          `Purge ${label} now? Its conversations, tasks, files and connections are removed for good. This cannot be undone.`,
        );
        if (!confirmed) return;
      }
      setBusy(row.workspaceId);
      try {
        const res = await callToolWithoutWorkspace("nb", "manage_workspaces", {
          action,
          workspaceId: row.workspaceId,
        });
        parseToolResult(res);
        await fetchRows();
      } catch (err) {
        setError(err instanceof Error ? err.message : `Failed to ${action} workspace`);
      } finally {
        setBusy(null);
      }
    },
    [fetchRows],
  );

  return (
    <SettingsListPage
      title="Deleted workspaces"
      description="A deleted workspace can be restored as it was until its purge time. Then it is removed for good."
      loading={loading}
      loadingMessage="Loading deleted workspaces..."
      loadError={error}
    >
      {rows.length === 0 ? (
        error ? null : (
          <EmptyState message="No deleted workspaces." />
        )
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Workspace</TableHead>
              <TableHead>ID</TableHead>
              <TableHead>Deleted</TableHead>
              <TableHead>Purged</TableHead>
              <TableHead className="w-[90px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <DeletedRow
                key={row.workspaceId}
                row={row}
                busy={busy === row.workspaceId}
                onRestore={() => act(row, "restore")}
                onPurge={() => act(row, "purge")}
              />
            ))}
          </TableBody>
        </Table>
      )}
    </SettingsListPage>
  );
}
