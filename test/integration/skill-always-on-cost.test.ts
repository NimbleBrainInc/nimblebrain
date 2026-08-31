/**
 * `nb__status scope:skills` reports what the always-on channel costs, per tier.
 *
 * Every skill in that channel is paid on every turn. Until this existed the
 * only way to learn the number was to read conversation logs off the disk —
 * which is how a workspace came to carry ~13k tokens of one operator's
 * personal doctrine without anyone noticing. User-tier skills follow their
 * author into every workspace BY DESIGN, so a skill authored at the wrong tier
 * is not wrong, just invisible; it quietly bills every turn, everywhere.
 *
 * Splitting the report by tier is the whole fix: a workspace whose own
 * contribution is a fraction of its always-on cost is the signal that a skill
 * belongs at a different scope.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractText } from "../../src/engine/content-helpers.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nimblebrain-alwayson-cost-${Date.now()}`);
let runtime: Runtime;

async function callTool(name: string, input: Record<string, unknown>) {
  const registry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
  const res = await runWithRequestContext(
    { identity: DEV_IDENTITY, workspaceId: TEST_WORKSPACE_ID },
    () => registry.execute({ id: `t-${Math.random()}`, name, input }),
  );
  return { content: extractText(res.content), isError: res.isError ?? false };
}

async function createAlwaysOn(scope: string, name: string, body: string) {
  const res = await callTool("skills__create", {
    scope,
    manifest: { name, description: `${scope} rule`, loadingStrategy: "always", priority: 50 },
    body,
  });
  expect(res.isError).toBe(false);
}

beforeAll(async () => {
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
    telemetry: { enabled: false },
  });
  await provisionTestWorkspace(runtime);
});

afterAll(async () => {
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe("always-on cost by tier", () => {
  it("reports each tier separately, so a lopsided workspace is visible", async () => {
    // The shape that motivated this: a lot of user-tier doctrine, very little
    // belonging to the workspace itself.
    await createAlwaysOn("user", "personal-voice", "PERSONAL ".repeat(200));
    await createAlwaysOn("workspace", "campaign-rule", "CAMPAIGN brief.");

    const status = await callTool("nb__status", { scope: "skills" });
    expect(status.isError).toBe(false);
    expect(status.content).toContain("Always-On Cost");
    // Both tiers named, so the split is legible rather than one lump sum.
    expect(status.content).toMatch(/- user: 1 skill\(s\), ~\d/);
    expect(status.content).toMatch(/- workspace: 1 skill\(s\), ~\d/);
    expect(status.content).toContain("Total ~");
  });

  it("the user tier's cost dominates when a skill is authored at the wrong scope", async () => {
    // Not an assertion about correctness — about legibility. The operator can
    // now see which tier is spending their context.
    const status = await callTool("nb__status", { scope: "skills" });
    const user = /- user: \d+ skill\(s\), ~([\d,]+) tokens/.exec(status.content);
    const wksp = /- workspace: \d+ skill\(s\), ~([\d,]+) tokens/.exec(status.content);
    expect(user).not.toBeNull();
    expect(wksp).not.toBeNull();
    const n = (m: RegExpExecArray | null) => Number((m?.[1] ?? "0").replace(/,/g, ""));
    expect(n(user)).toBeGreaterThan(n(wksp));
  });
});
