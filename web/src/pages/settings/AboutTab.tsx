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
import { roleAtLeast, useScopedRole } from "../../hooks/useScopedRole";
import { InlineError, Section, SettingsDashboardPage } from "./components";

interface AppInfo {
  name: string;
  bundleName: string;
  version: string;
  status: string;
  type: string;
  toolCount: number;
  installSource?: "registry" | "local" | "remote";
}

interface UpdateInfo {
  name: string;
  current: string;
  latest: string;
}

function mpakUrl(bundleName: string): string | null {
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
  const role = useScopedRole();
  const canUpgrade = roleAtLeast(role, "org_admin");

  const [apps, setApps] = useState<AppInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [bundlesError, setBundlesError] = useState<string | null>(null);
  const [updates, setUpdates] = useState<Map<string, string>>(new Map());
  const [updatesChecked, setUpdatesChecked] = useState(false);
  const [upgrading, setUpgrading] = useState<Set<string>>(new Set());
  const [upgradeErrors, setUpgradeErrors] = useState<Map<string, string>>(new Map());

  const fetchApps = useCallback(async () => {
    try {
      setBundlesError(null);
      const [appsResult, updatesResult] = await Promise.all([
        callTool("nb", "list_apps", {}),
        callTool("nb", "check_updates", {}).catch(() => null),
      ]);
      const data = parseToolResult<{ apps?: AppInfo[] }>(appsResult);
      if (Array.isArray(data.apps)) {
        setApps(data.apps);
      }
      if (updatesResult) {
        const map = new Map<string, string>();
        try {
          const updateData = parseToolResult<{ updates?: UpdateInfo[] }>(updatesResult);
          if (Array.isArray(updateData.updates)) {
            for (const u of updateData.updates) {
              map.set(u.name, u.latest);
            }
          }
        } catch {
          // No structured update data — all bundles up to date
        }
        setUpdates(map);
        setUpdatesChecked(true);
      }
    } catch (err) {
      setBundlesError(err instanceof Error ? err.message : "Failed to load installed bundles.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchApps();
  }, [fetchApps]);

  const handleUpgrade = useCallback(
    async (bundleName: string) => {
      setUpgrading((prev) => new Set(prev).add(bundleName));
      setUpgradeErrors((prev) => {
        const next = new Map(prev);
        next.delete(bundleName);
        return next;
      });
      try {
        const result = await callTool("nb", "manage_app", {
          action: "upgrade",
          name: bundleName,
        });
        if (result.isError) {
          const msg =
            result.content
              ?.filter((c) => c.type === "text")
              .map((c) => c.text ?? "")
              .join("") || "Upgrade failed";
          setUpgradeErrors((prev) => {
            const next = new Map(prev);
            next.set(bundleName, msg);
            return next;
          });
          return;
        }
        await fetchApps();
      } catch (err) {
        setUpgradeErrors((prev) => {
          const next = new Map(prev);
          next.set(bundleName, err instanceof Error ? err.message : "Upgrade failed");
          return next;
        });
      } finally {
        setUpgrading((prev) => {
          const next = new Set(prev);
          next.delete(bundleName);
          return next;
        });
      }
    },
    [fetchApps],
  );

  const hasRegistryBundles = apps.some((a) => a.installSource === "registry");
  const showUpdateColumn = updatesChecked && hasRegistryBundles;

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
        ) : apps.length === 0 ? null : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Tools</TableHead>
                {showUpdateColumn && <TableHead className="text-right">Update</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.map((app) => {
                const href = mpakUrl(app.bundleName);
                const latestVersion = updates.get(app.bundleName);
                const isUpgrading = upgrading.has(app.bundleName);
                const upgradeError = upgradeErrors.get(app.bundleName);
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
                      <Badge
                        variant={isUpgrading ? "secondary" : statusColor(app.status)}
                        className="text-xs"
                      >
                        {isUpgrading ? "updating" : app.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{app.toolCount}</TableCell>
                    {showUpdateColumn && (
                      <TableCell className="text-right">
                        {app.installSource !== "registry" ? null : latestVersion ? (
                          <div className="flex items-center justify-end gap-2">
                            <span className="text-xs text-muted-foreground">
                              {app.version} → {latestVersion}
                            </span>
                            {canUpgrade && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={isUpgrading}
                                onClick={() => handleUpgrade(app.bundleName)}
                              >
                                {isUpgrading ? "Updating…" : "Update"}
                              </Button>
                            )}
                            {upgradeError && (
                              <span className="text-xs text-destructive">{upgradeError}</span>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">Up to date</span>
                        )}
                      </TableCell>
                    )}
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
