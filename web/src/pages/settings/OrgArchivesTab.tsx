import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { callTool } from "../../api/client";
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

// ── Organization → Archives — `/org/archives` ────────────────────────
//
// Deleting a workspace archives its data under `archived/` rather than
// destroying it. This tab lists those archives and purges one at a time. It
// deliberately offers no restore, no download, and no automatic retention:
// a purge is a person's decision, made one archive at a time.

export interface Archive {
  name: string;
  workspaceId: string | null;
  workspaceName: string | null;
  sizeBytes: number;
  archivedAt: string;
}

export function formatArchiveSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function Unknown() {
  return <span className="text-muted-foreground italic">Unknown</span>;
}

function ArchiveRow({
  archive,
  purging,
  onPurge,
}: {
  archive: Archive;
  purging: boolean;
  onPurge: () => void;
}) {
  return (
    <TableRow>
      <TableCell className="font-medium">{archive.workspaceName ?? <Unknown />}</TableCell>
      <TableCell className="font-mono text-xs">{archive.workspaceId ?? <Unknown />}</TableCell>
      <TableCell className="font-mono text-xs">{archive.name}</TableCell>
      <TableCell>{formatArchiveSize(archive.sizeBytes)}</TableCell>
      <TableCell className="text-muted-foreground">{formatDate(archive.archivedAt)}</TableCell>
      <TableCell>
        <Button
          size="sm"
          variant="ghost"
          disabled={purging}
          title={`Purge ${archive.name}`}
          onClick={onPurge}
          className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </TableCell>
    </TableRow>
  );
}

export function OrgArchivesTab() {
  const [archives, setArchives] = useState<Archive[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [purging, setPurging] = useState<string | null>(null);

  const fetchArchives = useCallback(async () => {
    try {
      setError(null);
      const res = await callTool("nb", "manage_workspaces", { action: "list_archives" });
      const data = parseToolResult<{ archives: Archive[] }>(res);
      setArchives(data.archives ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load archives");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchArchives();
  }, [fetchArchives]);

  const handlePurge = useCallback(
    async (archive: Archive) => {
      const label = archive.workspaceName
        ? `"${archive.workspaceName}" (${archive.name})`
        : archive.name;
      const confirmed = window.confirm(
        `Permanently purge archive ${label}? This removes ${formatArchiveSize(archive.sizeBytes)} from disk and cannot be undone.`,
      );
      if (!confirmed) return;
      setPurging(archive.name);
      try {
        const res = await callTool("nb", "manage_workspaces", {
          action: "purge_archive",
          archive: archive.name,
        });
        parseToolResult(res);
        await fetchArchives();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to purge archive");
      } finally {
        setPurging(null);
      }
    },
    [fetchArchives],
  );

  return (
    <SettingsListPage
      title="Archives"
      description="Deleted workspaces are archived, not destroyed. Purging an archive removes its data from disk for good."
      loading={loading}
      loadingMessage="Loading archives..."
      loadError={error}
    >
      {archives.length === 0 ? (
        error ? null : (
          <EmptyState message="No archived workspaces." />
        )
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Workspace</TableHead>
              <TableHead>ID</TableHead>
              <TableHead>Archive</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Archived</TableHead>
              <TableHead className="w-[60px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {archives.map((archive) => (
              <ArchiveRow
                key={archive.name}
                archive={archive}
                purging={purging === archive.name}
                onPurge={() => handlePurge(archive)}
              />
            ))}
          </TableBody>
        </Table>
      )}
    </SettingsListPage>
  );
}
