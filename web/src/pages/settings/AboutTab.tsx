import { useCallback, useEffect, useState } from "react";
import { callTool, getPlatformVersion } from "../../api/client";
import { parseToolResult } from "../../api/tool-result";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { EmptyState, InlineError, Section, SettingsDashboardPage } from "./components";

interface AppInfo {
  name: string;
  bundleName: string;
  version: string;
  status: string;
  type: string;
  toolCount: number;
}

function mpakUrl(bundleName: string): string | null {
  // Scoped names like @nimblebraininc/echo → mpak.dev/packages/@nimblebraininc/echo
  if (bundleName.startsWith("@")) return `https://mpak.dev/packages/${bundleName}`;
  return null;
}

function statusColor(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "running":
      return "default";
    case "starting":
      return "secondary";
    case "crashed":
    case "dead":
      return "destructive";
    default:
      return "outline";
  }
}

export function AboutTab() {
  const { version, buildSha } = getPlatformVersion();
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [bundlesError, setBundlesError] = useState<string | null>(null);

  const fetchApps = useCallback(async () => {
    try {
      setBundlesError(null);
      const result = await callTool("nb", "list_apps", {});
      const data = parseToolResult<{ apps?: AppInfo[] }>(result);
      if (Array.isArray(data.apps)) {
        setApps(data.apps);
      }
    } catch (err) {
      // Surface the failure rather than silently degrading to "no bundles
      // installed" — the empty state would otherwise read as authoritative
      // ("there are no bundles") when really the call failed and we don't
      // know. The platform-version section is independent (read from
      // bootstrap), so the page still renders useful content above.
      setBundlesError(err instanceof Error ? err.message : "Failed to load installed bundles.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchApps();
  }, [fetchApps]);

  return (
    <SettingsDashboardPage
      title="About"
      description="Platform version and the bundles installed on this instance."
    >
      <Section title="Platform" flush>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Version</dt>
          <dd className="font-mono">{version ?? "unknown"}</dd>
          <dt className="text-muted-foreground">Build</dt>
          <dd className="font-mono">{buildSha ?? "dev"}</dd>
        </dl>
      </Section>

      <Section title="Installed Bundles">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : bundlesError ? (
          <InlineError
            message={bundlesError}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setLoading(true);
                  fetchApps();
                }}
              >
                Retry
              </Button>
            }
          />
        ) : apps.length === 0 ? (
          <EmptyState message="No bundles installed." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Tools</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.map((app) => {
                const href = mpakUrl(app.bundleName);
                return (
                  <TableRow key={app.bundleName}>
                    <TableCell className="font-mono text-xs">
                      {href ? (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary underline-offset-4 hover:underline"
                        >
                          {app.bundleName}
                        </a>
                      ) : (
                        app.bundleName
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{app.version || "—"}</TableCell>
                    <TableCell>
                      <Badge variant={statusColor(app.status)} className="text-xs">
                        {app.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{app.toolCount}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Section>
    </SettingsDashboardPage>
  );
}
