import { getPlatformVersion } from "../../api/client";
import { Section, SettingsDashboardPage } from "./components";

/**
 * Org → About — platform version and build.
 *
 * Role-exempt: any signed-in user can read it. Connectors are managed
 * per-workspace on the Connectors page; there is no org-wide app inventory,
 * because the runtime installs no code and so has nothing org-global to
 * version.
 */
export function OrgAboutTab() {
  const { version, buildSha } = getPlatformVersion();

  return (
    <SettingsDashboardPage title="About" description="Platform version and build.">
      <Section title="Platform" flush>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Version</dt>
          <dd className="font-mono">{version ?? "unknown"}</dd>
          <dt className="text-muted-foreground">Build</dt>
          <dd className="font-mono">{buildSha ?? "dev"}</dd>
        </dl>
      </Section>
    </SettingsDashboardPage>
  );
}
