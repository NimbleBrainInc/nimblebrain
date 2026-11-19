import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import { ConnectorLifecycleManager } from "../../../src/connectors/runtime/lifecycle.ts";
import { defaultWorkDir } from "../../../src/connectors/runtime/paths.ts";
import { CONNECTOR_SKILLS_SUBDIR } from "../../../src/skills/connector-skill-store.ts";
import type { ToolRegistry } from "../../../src/tools/registry.ts";
import { WorkspaceContext } from "../../../src/workspace/context.ts";
import { fakeFetch } from "../../helpers/fake-fetch.ts";
import { buildCatalog, type FixtureCatalog } from "../../helpers/plugin-catalog.ts";
import { stub } from "../../helpers/stub.ts";
import { seedWorkspaceRoot } from "../../helpers/test-workspace.ts";

/**
 * Lifecycle binding hooks: `syncBoundSkills` resolves + materializes the skill
 * a catalog plugin binds to a connector's server at install;
 * `removeBoundSkills` cleans up at uninstall. The catalog is a fixture served
 * by an injected fetch, so these stay hermetic (no network).
 */

const OVERLAY = `---
name: gmail-usage
description: Gmail connector guidance
metadata:
  nimblebrain:
    loading-strategy: dynamic
    priority: 40
    server: gmail
---

Confirm the recipient before calling gmail__send.
`;

const GMAIL_SERVER = "com.google/gmail";

const WS_ID = "ws_0000000000000001";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
});

function workDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cskbind-"));
  dirs.push(d);
  // Materializing an overlay writes into `workspaces/<wsId>/connector-skills/`,
  // which is created on first bind but only inside a live workspace root.
  seedWorkspaceRoot(d, WS_ID);
  return d;
}

function gmailCatalog(): FixtureCatalog {
  return buildCatalog([
    { name: "gmail", servers: { gmail: GMAIL_SERVER }, skills: { "gmail-usage": OVERLAY } },
    { name: "close", servers: { close: "com.close/mcp" } },
  ]);
}

/** A manager reading `catalog`, pinned to it through the env the runtime reads. */
function manager(catalog: FixtureCatalog): ConnectorLifecycleManager {
  process.env.NB_PLUGIN_CATALOG_URL = "https://catalog.test";
  process.env.NB_PLUGIN_CATALOG_SHA256 = catalog.pin;
  const m = new ConnectorLifecycleManager(new NoopEventSink());
  m.setConnectorSkillFetch(catalog.fetch);
  return m;
}

afterEach(() => {
  delete process.env.NB_PLUGIN_CATALOG_URL;
  delete process.env.NB_PLUGIN_CATALOG_SHA256;
});

function connectorSkillsDir(wd: string): string {
  return new WorkspaceContext({ wsId: WS_ID, workDir: wd }).getDataPath(CONNECTOR_SKILLS_SUBDIR);
}

describe("ConnectorLifecycleManager.syncBoundSkills", () => {
  it("binds the plugin's skill by the server it names, and locks it to the pin and digests", async () => {
    const wd = workDir();
    const catalog = gmailCatalog();
    const m = manager(catalog);

    const lock = await m.syncBoundSkills(GMAIL_SERVER, "com-google-gmail", WS_ID, wd);
    expect(lock).toEqual([
      {
        plugin: "gmail@nimblebrain",
        server: GMAIL_SERVER,
        skill: "gmail-usage",
        version: catalog.pin,
        digest: catalog.digests.gmail!,
        sha: lock[0]!.sha,
      },
    ]);
    expect(lock[0]!.sha).toMatch(/^[0-9a-f]{64}$/);

    // Materialized under this install's namespace, with the binding consumed:
    // the copy is bound by tool-affinity and records where it came from.
    const file = join(connectorSkillsDir(wd), "com-google-gmail", "gmail-usage.md");
    const text = readFileSync(file, "utf8");
    expect(text).not.toMatch(/^\s*server:/m);
    expect(text).toContain("com-google-gmail__*");
    expect(text).toContain("plugin:gmail@nimblebrain:gmail-usage");
  });

  it("is a no-op (returns []) for a connector with no catalog plugin", async () => {
    const wd = workDir();
    const m = manager(gmailCatalog());
    const lock = await m.syncBoundSkills("com.unknown/mcp", "unknown", WS_ID, wd);
    expect(lock).toEqual([]);
    expect(existsSync(join(connectorSkillsDir(wd), "unknown"))).toBe(false);
  });

  it("is a no-op (returns []) for a plugin that binds no skill to its server", async () => {
    const wd = workDir();
    const m = manager(gmailCatalog());
    expect(await m.syncBoundSkills("com.close/mcp", "close", WS_ID, wd)).toEqual([]);
  });

  it("is non-fatal (returns []) when the fetch fails", async () => {
    const wd = workDir();
    const m = manager(gmailCatalog());
    m.setConnectorSkillFetch(
      fakeFetch(() => {
        throw new Error("network down");
      }),
    );
    const lock = await m.syncBoundSkills(GMAIL_SERVER, "gmail", WS_ID, wd);
    expect(lock).toEqual([]);
  });

  it("removeBoundSkills deletes the materialized overlays", async () => {
    const wd = workDir();
    const m = manager(gmailCatalog());
    await m.syncBoundSkills(GMAIL_SERVER, "gmail", WS_ID, wd);
    expect(existsSync(join(connectorSkillsDir(wd), "gmail"))).toBe(true);

    m.removeBoundSkills("gmail", WS_ID, wd);
    expect(existsSync(join(connectorSkillsDir(wd), "gmail"))).toBe(false);
    // Idempotent.
    expect(() => m.removeBoundSkills("gmail", WS_ID, wd)).not.toThrow();
  });

  it("uninstall cleans up overlays under the wired workDir, not defaultWorkDir()", async () => {
    // Regression: `uninstall` step-4d resolved the connector-skills dir from
    // `defaultWorkDir()` while install/load use the runtime's resolved workDir.
    // Under an operator `workDir` in nimblebrain.json (NB_WORK_DIR unset) the
    // two diverge and uninstall removed nothing. The Runtime wires the resolved
    // workDir via `setWorkDir`; this drives the REAL uninstall path with a
    // workDir that is provably ≠ defaultWorkDir().
    const wd = workDir();
    expect(wd).not.toBe(defaultWorkDir()); // the divergence the bug needed

    const m = manager(gmailCatalog());
    m.setWorkDir(wd);
    await m.syncBoundSkills(GMAIL_SERVER, "gmail", WS_ID, wd);
    expect(existsSync(join(connectorSkillsDir(wd), "gmail"))).toBe(true);

    // Real uninstall path (no instance/config/registry source needed — step 4d
    // runs regardless and uses the wired workDir).
    const registry = stub<ToolRegistry>({
      hasSource: () => false,
      hasEstablishedSource: () => false,
    });
    await m.uninstall("gmail", registry, WS_ID);

    expect(existsSync(join(connectorSkillsDir(wd), "gmail"))).toBe(false);
  });
});
