import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import { ConnectorLifecycleManager } from "../../../src/connectors/runtime/lifecycle.ts";
import { defaultWorkDir } from "../../../src/connectors/runtime/paths.ts";
import {
  CONNECTOR_SKILLS_SUBDIR,
  materializeConnectorSkill,
} from "../../../src/skills/connector-skill-store.ts";
import type { ToolRegistry } from "../../../src/tools/registry.ts";
import { WorkspaceContext } from "../../../src/workspace/context.ts";
import { stub } from "../../helpers/stub.ts";
import { seedWorkspaceRoot } from "../../helpers/test-workspace.ts";

/**
 * Uninstall's connector-skill cleanup: `removeBoundSkills` removes every skill
 * materialized for a connection in its owner's `connector-skills/` store.
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

const WS_ID = "ws_0000000000000001";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
});

function workDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cskbind-"));
  dirs.push(d);
  // Materializing a skill writes into `workspaces/<wsId>/connector-skills/`,
  // which exists only inside a live workspace root.
  seedWorkspaceRoot(d, WS_ID);
  return d;
}

function connectorSkillsDir(wd: string): string {
  return new WorkspaceContext({ wsId: WS_ID, workDir: wd }).getDataPath(CONNECTOR_SKILLS_SUBDIR);
}

/** The gmail connection's skill, as a plugin install materializes it. */
function materialize(wd: string): void {
  materializeConnectorSkill({
    connectorSkillsDir: connectorSkillsDir(wd),
    serverName: "gmail",
    overlayBody: OVERLAY,
    source: "plugin:gmail@nimblebrain:gmail-usage",
    now: new Date().toISOString(),
  });
}

describe("ConnectorLifecycleManager connector-skill cleanup", () => {
  it("removeBoundSkills deletes the materialized overlays", async () => {
    const wd = workDir();
    const m = new ConnectorLifecycleManager(new NoopEventSink());
    materialize(wd);
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

    const m = new ConnectorLifecycleManager(new NoopEventSink());
    m.setWorkDir(wd);
    materialize(wd);
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
