// Identity-app resource host: `/v1/apps/:name/resources/*` (handleResourceProxy).
//
// Kernel identity apps (conversations, …) are owned by the user and live
// OUTSIDE any workspace. Their iframe must load with NO workspace in scope —
// resolved from the identity source, not a workspace registry — while a
// workspace app must STILL require a workspace (fail closed, never a silent
// identity fallback). These tests pin that two-door split at the host.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResourceProxy } from "../../src/api/handlers.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nb-identity-resource-host-${Date.now()}`);
let runtime: Runtime;

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
  });
  // Provision a workspace so the "stale workspace id is ignored" case has a
  // real, membership-valid id to pass through.
  await provisionTestWorkspace(runtime);
});

afterAll(async () => {
  await runtime?.shutdown();
  rmSync(testDir, { recursive: true, force: true });
});

describe("identity-app resource host (/v1/apps/:name/resources/*)", () => {
  it("serves a kernel identity app (conversations) with NO workspace in scope", async () => {
    // `getIdentitySource("conversations")` resolves the app; the host reads
    // its `primary` resource from the identity source — no `ensureWorkspaceRegistry`.
    const res = await handleResourceProxy("conversations", "primary", runtime);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { contents: { uri: string; text?: string }[] };
    expect(body.contents.length).toBeGreaterThan(0);
    expect(body.contents[0]?.uri).toContain("ui://");
  });

  it("ignores a (stale) workspace id on an identity app — location is scope", async () => {
    // The shell may still carry the last-active `X-Workspace-Id`. The identity
    // branch must serve the same bytes regardless; it never authorizes against
    // the workspace.
    const res = await handleResourceProxy("conversations", "primary", runtime, TEST_WORKSPACE_ID);
    expect(res.status).toBe(200);
  });

  it("404s an unknown resource path on the identity app (not a 500)", async () => {
    const res = await handleResourceProxy("conversations", "no-such-resource", runtime);
    expect(res.status).toBe(404);
  });

  it("still requires a workspace for a workspace app — no silent identity fallback", async () => {
    // `nb` is a platform WORKSPACE source, not a kernel identity source.
    // Without a workspace it must fail closed (400), never get served through
    // the identity host. This is the fail-closed guarantee.
    const res = await handleResourceProxy("nb", "primary", runtime);
    expect(res.status).toBe(400);
  });
});
