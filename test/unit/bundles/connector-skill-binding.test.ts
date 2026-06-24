import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import { BundleLifecycleManager } from "../../../src/bundles/lifecycle.ts";
import { CONNECTOR_SKILLS_SUBDIR } from "../../../src/skills/connector-skill-store.ts";
import { WorkspaceContext } from "../../../src/workspace/context.ts";

/**
 * Lifecycle binding hooks (P4): `syncBoundSkills` resolves + materializes a
 * curated overlay at install; `removeBoundSkills` cleans up at uninstall. The
 * resolver fetch is injected so these stay hermetic (no network).
 */

const OVERLAY = `---
name: gmail-usage
description: Gmail connector guidance
metadata:
  nimblebrain:
    loading-strategy: dynamic
    priority: 40
---

Confirm the recipient before calling gmail__send.
`;

const WS_ID = "ws_0000000000000001";

const dirs: string[] = [];
let savedEnabled: string | undefined;
beforeEach(() => {
  savedEnabled = process.env.CONNECTOR_SKILLS_ENABLED;
});
afterEach(() => {
  if (savedEnabled === undefined) delete process.env.CONNECTOR_SKILLS_ENABLED;
  else process.env.CONNECTOR_SKILLS_ENABLED = savedEnabled;
  for (const d of dirs.splice(0)) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
});

function workDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cskbind-"));
  dirs.push(d);
  return d;
}

function manager(routes: Record<string, { status: number; body?: string }>): BundleLifecycleManager {
  const m = new BundleLifecycleManager(new NoopEventSink(), undefined);
  m.setConnectorSkillFetch((async (url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url.toString();
    const r = routes[u];
    return r ? new Response(r.body ?? "", { status: r.status }) : new Response("", { status: 404 });
  }) as unknown as typeof fetch);
  return m;
}

const gmailUrl = "https://raw.githubusercontent.com/NimbleBrainInc/connector-skills/v0.1.0/composio/gmail/SKILL.md";

function connectorSkillsDir(wd: string): string {
  return new WorkspaceContext({ wsId: WS_ID, workDir: wd }).getDataPath(CONNECTOR_SKILLS_SUBDIR);
}

describe("BundleLifecycleManager.syncBoundSkills (P4)", () => {
  it("returns [] and materializes nothing when the feature is disabled", async () => {
    delete process.env.CONNECTOR_SKILLS_ENABLED;
    const wd = workDir();
    const m = manager({ [gmailUrl]: { status: 200, body: OVERLAY } });
    const lock = await m.syncBoundSkills("composio/gmail", "gmail", WS_ID, wd);
    expect(lock).toEqual([]);
    expect(existsSync(join(connectorSkillsDir(wd), "gmail"))).toBe(false);
  });

  it("resolves, materializes, and returns a lock entry when enabled", async () => {
    process.env.CONNECTOR_SKILLS_ENABLED = "true";
    const wd = workDir();
    const m = manager({ [gmailUrl]: { status: 200, body: OVERLAY } });

    const lock = await m.syncBoundSkills("composio/gmail", "gmail", WS_ID, wd);
    expect(lock).toHaveLength(1);
    expect(lock[0]!.identity).toBe("composio/gmail");
    expect(lock[0]!.version).toBe("v0.1.0");
    expect(lock[0]!.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(lock[0]!.path)).toBe(true);
  });

  it("is a no-op (returns []) when no overlay is curated (404)", async () => {
    process.env.CONNECTOR_SKILLS_ENABLED = "true";
    const wd = workDir();
    const m = manager({}); // every URL 404s
    const lock = await m.syncBoundSkills("composio/unknown", "unknown", WS_ID, wd);
    expect(lock).toEqual([]);
    expect(existsSync(join(connectorSkillsDir(wd), "unknown"))).toBe(false);
  });

  it("is non-fatal (returns []) when the fetch fails", async () => {
    process.env.CONNECTOR_SKILLS_ENABLED = "true";
    const wd = workDir();
    const m = new BundleLifecycleManager(new NoopEventSink(), undefined);
    m.setConnectorSkillFetch((() => {
      throw new Error("network down");
    }) as unknown as typeof fetch);
    const lock = await m.syncBoundSkills("composio/gmail", "gmail", WS_ID, wd);
    expect(lock).toEqual([]);
  });

  it("removeBoundSkills deletes the materialized overlays", async () => {
    process.env.CONNECTOR_SKILLS_ENABLED = "true";
    const wd = workDir();
    const m = manager({ [gmailUrl]: { status: 200, body: OVERLAY } });
    await m.syncBoundSkills("composio/gmail", "gmail", WS_ID, wd);
    expect(existsSync(join(connectorSkillsDir(wd), "gmail"))).toBe(true);

    m.removeBoundSkills("gmail", WS_ID, wd);
    expect(existsSync(join(connectorSkillsDir(wd), "gmail"))).toBe(false);
    // Idempotent.
    expect(() => m.removeBoundSkills("gmail", WS_ID, wd)).not.toThrow();
  });
});
