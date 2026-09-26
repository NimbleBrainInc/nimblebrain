// Identity-app resource host: `/v1/workspaces/:wsId/apps/:name/resources/*`
// (handleResourceProxy).
//
// Kernel identity apps (conversations, …) are owned by the user and live
// OUTSIDE any workspace. The web shell renders every app inside a workspace, so
// the route always names one, but an identity app is resolved from the identity
// source and the workspace in the URL decides nothing for it. A workspace app is
// resolved in the workspace in the URL and nowhere else (fail closed, never a
// silent identity fallback). These tests pin that two-door split at the host.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResourceProxy } from "../../src/api/handlers.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nb-identity-resource-host-${Date.now()}`);
const OTHER_WORKSPACE_ID = "ws_other";
let runtime: Runtime;

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    logging: { disabled: true },
    workDir: testDir,
  });
  // Two workspaces, so the identity app can be shown to be the same in each.
  await provisionTestWorkspace(runtime);
  await provisionTestWorkspace(runtime, OTHER_WORKSPACE_ID, "Other Workspace");
});

afterAll(async () => {
  await runtime?.shutdown();
  rmSync(testDir, { recursive: true, force: true });
});

describe("identity-app resource host (/v1/workspaces/:wsId/apps/:name/resources/*)", () => {
  it("serves a kernel identity app (conversations) from the identity source", async () => {
    // `getIdentitySource("conversations")` resolves the app; the host reads
    // its `primary` resource from the identity source — not the workspace registry.
    const res = await handleResourceProxy("conversations", "primary", runtime, TEST_WORKSPACE_ID);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { contents: { uri: string; text?: string }[] };
    expect(body.contents.length).toBeGreaterThan(0);
    expect(body.contents[0]?.uri).toContain("ui://");
  });

  it("serves the same identity app whichever workspace the URL names", async () => {
    // The identity branch never authorizes against the workspace in the URL,
    // so every workspace serves the same bytes.
    const a = await handleResourceProxy("conversations", "primary", runtime, TEST_WORKSPACE_ID);
    const b = await handleResourceProxy("conversations", "primary", runtime, OTHER_WORKSPACE_ID);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual(await a.json());
  });

  it("404s an unknown resource path on the identity app (not a 500)", async () => {
    const res = await handleResourceProxy(
      "conversations",
      "no-such-resource",
      runtime,
      TEST_WORKSPACE_ID,
    );
    expect(res.status).toBe(404);
  });

  it("resolves a workspace app only in the workspace in the URL — no silent identity fallback", async () => {
    // An app absent from the workspace in the URL fails closed (403); it is
    // never served through the identity host.
    const res = await handleResourceProxy("no_such_app", "primary", runtime, TEST_WORKSPACE_ID);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("workspace_access_denied");
  });
});
