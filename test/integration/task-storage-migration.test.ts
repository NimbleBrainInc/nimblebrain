/**
 * Boot moves task storage written under `workspaces/<ws>/automations/` to
 * `workspaces/<ws>/tasks/` before the scheduler loads, so a task saved before
 * the rename is listed, and armed, after it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_IDENTITY, DevIdentityProvider } from "../../src/identity/providers/dev.ts";
import type { Automation } from "../../src/platform/tasks/types.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

let workDir: string;
let runtime: Runtime;

async function boot(): Promise<Runtime> {
  return Runtime.start({
    identityProvider: ({ workDir: dir, userStore }) => new DevIdentityProvider(dir, userStore),
    model: { provider: "custom", adapter: createEchoModel() },
    logging: { disabled: true },
    workDir,
  });
}

const LEGACY: Automation = {
  id: "weekly-digest",
  name: "Weekly digest",
  prompt: "Summarize the week.",
  enabled: true,
  source: "user",
  workspaceId: TEST_WORKSPACE_ID,
  ownerId: DEV_IDENTITY.id,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  runCount: 0,
  consecutiveErrors: 0,
  cumulativeInputTokens: 0,
  cumulativeOutputTokens: 0,
};

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-task-storage-migration-"));
  // A workspace that existed before the rename, with a task in the old place.
  const first = await boot();
  await provisionTestWorkspace(first);
  await first.shutdown();
  const legacyOwner = join(
    workDir,
    "workspaces",
    TEST_WORKSPACE_ID,
    "automations",
    DEV_IDENTITY.id,
  );
  mkdirSync(legacyOwner, { recursive: true });
  writeFileSync(join(legacyOwner, `${LEGACY.id}.json`), JSON.stringify(LEGACY));

  runtime = await boot();
});

afterAll(async () => {
  await runtime.shutdown();
  rmSync(workDir, { recursive: true, force: true });
});

describe("task storage at boot", () => {
  it("moves automations/ to tasks/ and lists the moved task", async () => {
    const wsDir = join(workDir, "workspaces", TEST_WORKSPACE_ID);
    expect(existsSync(join(wsDir, "automations"))).toBe(false);
    expect(existsSync(join(wsDir, "tasks", DEV_IDENTITY.id, `${LEGACY.id}.json`))).toBe(true);

    const source = runtime.getIdentitySource("tasks");
    const result = await runWithRequestContext(
      { identity: DEV_IDENTITY, workspaceId: TEST_WORKSPACE_ID },
      () => source?.execute("list", {}) ?? Promise.reject(new Error("no tasks source")),
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("weekly-digest");
  });
});
