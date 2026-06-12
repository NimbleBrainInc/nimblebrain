import { describe, expect, test } from "bun:test";
import { readStaticServers } from "../../src/registries/static-source.ts";
import { selectDcrEntries } from "../../scripts/check-catalog-dcr.ts";
import { CONNECTOR_FIXTURE_DIR } from "../helpers/connector-fixtures.ts";

/**
 * Offline coverage for the DCR rot-detector's entry selection. The
 * network probe itself can't run in `verify` (it's network-dependent by
 * design), but this keeps the script exercised by CI: importing it
 * proves its imports still resolve against the platform source, and
 * running `selectDcrEntries` over the fixture catches behavioral drift
 * in the catalog read / meta accessor it depends on. Without this the
 * tool would be an in-repo orphan — nothing else invokes it until the
 * deploy-repo gate (deployments#33) lands.
 */
describe("check-catalog-dcr selectDcrEntries", () => {
  test("picks dcr entries and skips static-auth + composio", () => {
    const servers = readStaticServers(CONNECTOR_FIXTURE_DIR);
    const names = selectDcrEntries(servers).map((s) => s.name);
    // Fixture: Notion (dcr), Dropbox (static), Asana (composio).
    expect(names).toContain("com.notion/mcp");
    expect(names).not.toContain("com.dropbox/mcp");
    expect(names).not.toContain("io.asana/mcp");
  });

  test("excludes dcr entries that have no remote to reach", () => {
    const noRemote = selectDcrEntries([
      {
        name: "com.example/mcp",
        description: "dcr but no remote",
        version: "1.0.0",
        _meta: { "ai.nimblebrain/connector": { auth: "dcr" } },
      },
    ]);
    expect(noRemote).toHaveLength(0);
  });
});
