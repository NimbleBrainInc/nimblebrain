import { useCallback, useEffect, useState } from "react";
import { callTool, getPlatformVersion } from "../../api/client";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";

// ── Types ───────────────────────────────────────────────────────

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

// ── Helpers ─────────────────────────────────────────────────────

function parseResult(res: {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}): Record<string, unknown> {
  if (res.structuredContent) return res.structuredContent;
  if (res.content?.[0]?.text) {
    try {
      return JSON.parse(res.content[0].text) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
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

// ── Component ───────────────────────────────────────────────────

export function AboutTab() {
  const { version, buildSha } = getPlatformVersion();
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchApps = useCallback(async () => {
    try {
      const result = await callTool("nb", "list_apps", {});
      const data = parseResult(result);
      if (Array.isArray(data.apps)) {
        setApps(data.apps as AppInfo[]);
      }
    } catch {
      // Non-critical — show empty state
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchApps();
  }, [fetchApps]);

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      {/* Platform info */}
      <Card>
        <CardHeader>
          <CardTitle>Platform</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Version</dt>
            <dd className="font-mono">{version ?? "unknown"}</dd>
            <dt className="text-muted-foreground">Build</dt>
            <dd className="font-mono">{buildSha ?? "dev"}</dd>
          </dl>
        </CardContent>
      </Card>

      {/* Installed bundles */}
      <Card>
        <CardHeader>
          <CardTitle>Installed Bundles</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : apps.length === 0 ? (
            <p className="text-sm text-muted-foreground">No bundles installed.</p>
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
        </CardContent>
      </Card>
    </div>
  );
}
