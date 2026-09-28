/**
 * `home__activity` reports the caller's automation runs as the automation
 * store writes them.
 *
 * Runs are seeded through the real `appendRun`, so the test fails if the home
 * app reads any layout other than the one the store writes. Visibility matches
 * `automations__runs`: a caller sees the runs of the automations they own in the
 * bound workspace, never a peer's.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../../../src/adapters/noop-events.ts";
import type { ToolResult } from "../../../../src/engine/types.ts";
import { createHomeSource } from "../../../../src/platform/home/source.ts";
import { appendRun } from "../../../../src/platform/automations/store.ts";
import type { AutomationRun } from "../../../../src/platform/automations/types.ts";
import type { Runtime } from "../../../../src/runtime/runtime.ts";
import type { AutomationRunSummary } from "../../../../src/services/home-types.ts";
import type { McpSource } from "../../../../src/tools/mcp-source.ts";

const WS_ID = "ws_activity00000";
const OWNER_ID = "usr_owner";
const PEER_ID = "usr_peer";

let workDir: string;
let source: McpSource;

function makeRuntime(): Runtime {
  return {
    getCurrentIdentity: () => ({ id: OWNER_ID }),
    resolveRequestUserId: () => OWNER_ID,
    requireWorkspaceId: () => WS_ID,
    getWorkDir: () => workDir,
    getWorkspaceScopedDir: () => join(workDir, "workspaces", WS_ID),
    listConversations: async () => ({ conversations: [], nextCursor: null, totalCount: 0 }),
  } as unknown as Runtime;
}

function run(
  automationId: string,
  status: AutomationRun["status"],
  minutesAgo: number,
  error?: string,
): AutomationRun {
  return {
    id: `run_${automationId}_${minutesAgo}`,
    automationId,
    startedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    status,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    iterations: 1,
    ...(error ? { error } : {}),
  };
}

async function automations(): Promise<AutomationRunSummary | undefined> {
  const result: ToolResult = await source.execute("activity", {});
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected a text block");
  return (JSON.parse(first.text) as { automations?: AutomationRunSummary }).automations;
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "nb-home-activity-"));
  mkdirSync(join(workDir, "workspaces", WS_ID), { recursive: true });
  source = createHomeSource(makeRuntime(), new NoopEventSink());
  await source.start();
});

afterEach(async () => {
  await source.stop();
  rmSync(workDir, { recursive: true, force: true });
});

describe("home__activity automation runs", () => {
  test("counts runs the store wrote for the caller's automations", async () => {
    appendRun(workDir, WS_ID, OWNER_ID, "daily-digest", run("daily-digest", "success", 30));
    appendRun(workDir, WS_ID, OWNER_ID, "inbox-triage", run("inbox-triage", "failure", 20, "boom"));

    const summary = await automations();

    expect(summary?.total).toBe(2);
    expect(summary?.succeeded).toBe(1);
    expect(summary?.failed).toBe(1);
    expect(summary?.failures).toHaveLength(1);
    expect(summary?.failures[0]?.name).toBe("inbox-triage");
    expect(summary?.failures[0]?.error).toBe("boom");
  });

  test("reports a degraded run beside the failures, not as a success", async () => {
    appendRun(
      workDir,
      WS_ID,
      OWNER_ID,
      "crm-sync",
      run("crm-sync", "degraded", 10, "crm__update failed"),
    );

    const summary = await automations();

    expect(summary?.total).toBe(1);
    expect(summary?.succeeded).toBe(0);
    expect(summary?.failed).toBe(0);
    expect(summary?.degraded).toBe(1);
    expect(summary?.failures).toEqual([
      expect.objectContaining({ name: "crm-sync", status: "degraded", error: "crm__update failed" }),
    ]);
  });

  test("leaves out a peer's runs and runs outside the window", async () => {
    appendRun(workDir, WS_ID, PEER_ID, "peer-report", run("peer-report", "failure", 5, "peer"));
    appendRun(workDir, WS_ID, OWNER_ID, "daily-digest", run("daily-digest", "failure", 48 * 60));

    expect(await automations()).toBeUndefined();
  });
});
