import { getPlatformVersion } from "../../api/client";
import { Section, SettingsDashboardPage } from "./components";

export function AboutTab() {
  const { version, buildSha } = getPlatformVersion();

  return (
    <SettingsDashboardPage title="About" description="Platform version and build information.">
      <Section title="Platform" flush>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Version</dt>
          <dd className="font-mono">{version ?? "unknown"}</dd>
          <dt className="text-muted-foreground">Build</dt>
          <dd className="font-mono">{buildSha ?? "dev"}</dd>
        </dl>
      </Section>

      <Section title="Connectors">
        <p className="text-sm text-muted-foreground">
          Installed connectors and bundles are managed in{" "}
          <a
            href="/settings/workspace/connectors"
            className="text-primary underline-offset-4 hover:underline"
          >
            Settings → Workspace → Connectors
          </a>
          .
        </p>
      </Section>
    </SettingsDashboardPage>
  );
}
