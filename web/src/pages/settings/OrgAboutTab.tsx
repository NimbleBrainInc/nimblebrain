import { useCallback, useEffect, useState } from "react";
import {
  type AppUpdate,
  checkAppUpdates,
  getPlatformVersion,
  listApps,
  type OrgApp,
  upgradeApp,
} from "../../api/client";
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
import { EmptyState, InlineError, Section, SettingsDashboardPage } from "./components";

function mpakUrl(bundleName: string): string | null {
  if (bundleName.startsWith("@")) return `https://mpak.dev/packages/${bundleName}`;
  return null;
}

type AppRowProps = {
  app: OrgApp;
  latest: string | undefined;
  isUpgrading: boolean;
  upgradeError: string | undefined;
  onUpgrade: (bundleName: string) => void;
};

// Bundle-name cell: links to the mpak package page for scoped bundles, plain text otherwise.
function AppNameCell({ bundleName }: { bundleName: string }) {
  const href = mpakUrl(bundleName);
  if (!href) {
    return <>{bundleName}</>;
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline-offset-4 hover:underline"
    >
      {bundleName}
    </a>
  );
}

// Update cell: shows "Up to date", or the version delta with an Update button and any upgrade error.
function AppUpdateCell({ app, latest, isUpgrading, upgradeError, onUpgrade }: AppRowProps) {
  if (!latest) {
    return <span className="text-xs text-muted-foreground">Up to date</span>;
  }
  return (
    <div className="flex items-center justify-end gap-2">
      <span className="text-xs text-muted-foreground">
        {app.version} → {latest}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={isUpgrading}
        onClick={() => onUpgrade(app.bundleName)}
      >
        {isUpgrading ? "Updating…" : "Update"}
      </Button>
      {upgradeError && <span className="text-xs text-destructive">{upgradeError}</span>}
    </div>
  );
}

// One installed-app row: name, version, workspace count, and update controls.
function AppRow({ app, latest, isUpgrading, upgradeError, onUpgrade }: AppRowProps) {
  return (
    <TableRow>
      <TableCell className="font-mono text-xs">
        <AppNameCell bundleName={app.bundleName} />
      </TableCell>
      <TableCell className="font-mono text-xs">{app.version || "—"}</TableCell>
      <TableCell className="text-right text-xs text-muted-foreground">
        {app.workspaceCount}
      </TableCell>
      <TableCell className="text-right">
        <AppUpdateCell
          app={app}
          latest={latest}
          isUpgrading={isUpgrading}
          upgradeError={upgradeError}
          onUpgrade={onUpgrade}
        />
      </TableCell>
    </TableRow>
  );
}

/**
 * Org → About — platform info plus org-wide management of installed registry
 * apps.
 *
 * App *version* is an org-global concern: the mpak cache is keyed by bundle
 * name only (no version) and shared across every workspace, so upgrading an app
 * changes the version everywhere. That's why version management lives here
 * (org-admin), not on the per-workspace Connectors page. Upgrading re-spawns
 * the app in every workspace that has it.
 *
 * The platform-version block is role-exempt (any signed-in user can read it).
 * The apps section is org-admin only — `manage_apps` gates every action, and
 * org-wide inventory (including workspaces a viewer may not belong to) is
 * org-admin information.
 */
export function OrgAboutTab() {
  const { version, buildSha } = getPlatformVersion();
  const role = useScopedRole();
  const isOrgAdmin = roleAtLeast(role, "org_admin");

  const [apps, setApps] = useState<OrgApp[]>([]);
  const [updates, setUpdates] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [appsError, setAppsError] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState<Set<string>>(new Set());
  const [upgradeErrors, setUpgradeErrors] = useState<Map<string, string>>(new Map());

  const fetchApps = useCallback(async () => {
    if (!isOrgAdmin) {
      setLoading(false);
      return;
    }
    try {
      setAppsError(null);
      // `list` is cheap (in-memory); `check_updates` polls the registry, so it
      // degrades to "no updates" on a registry hiccup rather than failing the
      // whole page.
      const [appList, updateList] = await Promise.all([
        listApps(),
        checkAppUpdates().catch(() => ({ updates: [] as AppUpdate[] })),
      ]);
      setApps(appList.apps ?? []);
      setUpdates(new Map((updateList.updates ?? []).map((u) => [u.bundleName, u.latest])));
    } catch (err) {
      setAppsError(err instanceof Error ? err.message : "Failed to load installed apps.");
    } finally {
      setLoading(false);
    }
  }, [isOrgAdmin]);

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
        const result = await upgradeApp(bundleName);
        if (!result.ok) {
          const failed = result.workspaces.filter((w) => !w.ok);
          setUpgradeErrors((prev) =>
            new Map(prev).set(
              bundleName,
              failed[0]?.error ?? "Upgrade failed in one or more workspaces.",
            ),
          );
        }
        await fetchApps();
      } catch (err) {
        setUpgradeErrors((prev) =>
          new Map(prev).set(bundleName, err instanceof Error ? err.message : "Upgrade failed."),
        );
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

  return (
    <SettingsDashboardPage
      title="About"
      description="Platform version and the apps installed across this organization."
    >
      <Section title="Platform" flush>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Version</dt>
          <dd className="font-mono">{version ?? "unknown"}</dd>
          <dt className="text-muted-foreground">Build</dt>
          <dd className="font-mono">{buildSha ?? "dev"}</dd>
        </dl>
      </Section>

      <Section title="Installed Apps">
        <p className="text-xs text-muted-foreground mb-3">
          Registry apps installed across the organization. App versions are shared platform-wide;
          upgrading updates every workspace that has the app.
        </p>
        {!isOrgAdmin ? (
          <EmptyState message="App management requires an organization admin." />
        ) : loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : appsError ? (
          <InlineError
            message={appsError}
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
          <EmptyState message="No registry apps installed." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Version</TableHead>
                <TableHead className="text-right">Workspaces</TableHead>
                <TableHead className="text-right">Update</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.map((app) => (
                <AppRow
                  key={app.bundleName}
                  app={app}
                  latest={updates.get(app.bundleName)}
                  isUpgrading={upgrading.has(app.bundleName)}
                  upgradeError={upgradeErrors.get(app.bundleName)}
                  onUpgrade={handleUpgrade}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </SettingsDashboardPage>
  );
}
