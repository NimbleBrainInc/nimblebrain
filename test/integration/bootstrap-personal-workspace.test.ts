/**
 * /v1/bootstrap surfaces the personal workspace identity:
 *   - workspaces[].isPersonal flag per entry
 *   - top-level personalWorkspaceId
 *
 * Runs handleBootstrap directly against a real Runtime — no HTTP server
 * needed since the handler accepts (Request, Runtime, identity) and
 * returns a Response.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleBootstrap } from "../../src/api/handlers.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { ensureUserWorkspace } from "../../src/workspace/provisioning.ts";

interface BootstrapResponse {
  user: { id: string };
  workspaces: Array<{
    id: string;
    name: string;
    role: "admin" | "member";
    memberCount: number;
    bundleCount: number;
    isPersonal: boolean;
  }>;
  personalWorkspaceId: string | null;
  activeWorkspace: string | null;
}

let workDir: string;
let runtime: Runtime;

beforeEach(async () => {
  workDir = join(tmpdir(), `nb-bootstrap-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(workDir, { recursive: true });
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir,
  });
});

afterEach(async () => {
  await runtime.shutdown();
  rmSync(workDir, { recursive: true, force: true });
});

async function bootstrapFor(userId: string): Promise<BootstrapResponse> {
  const res = await handleBootstrap(new Request("http://_/v1/bootstrap"), runtime, {
    id: userId,
    email: `${userId}@example.test`,
    displayName: userId,
    orgRole: "member",
    preferences: {},
  });
  expect(res.status).toBe(200);
  return (await res.json()) as BootstrapResponse;
}

describe("bootstrap — personal workspace surfaces", () => {
  test("user with a fresh personal workspace gets personalWorkspaceId + isPersonal=true", async () => {
    await ensureUserWorkspace(runtime.getWorkspaceStore(), { id: "user_alice" });

    const body = await bootstrapFor("user_alice");

    expect(body.personalWorkspaceId).toBe("ws_user_user_alice");
    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0]).toMatchObject({
      id: "ws_user_user_alice",
      isPersonal: true,
      role: "admin",
    });
  });

  test("user with both personal + shared workspaces gets the right personalWorkspaceId", async () => {
    const store = runtime.getWorkspaceStore();
    await ensureUserWorkspace(store, { id: "user_alice" });
    const shared = await store.create("Team Alpha", "team_alpha");
    await store.addMember(shared.id, "user_alice", "member");

    const body = await bootstrapFor("user_alice");

    expect(body.personalWorkspaceId).toBe("ws_user_user_alice");
    expect(body.workspaces).toHaveLength(2);
    const personal = body.workspaces.find((w) => w.id === "ws_user_user_alice")!;
    const sharedEntry = body.workspaces.find((w) => w.id === shared.id)!;
    expect(personal.isPersonal).toBe(true);
    expect(sharedEntry.isPersonal).toBe(false);
  });

  test("user with no personal workspace (pre-migration) returns personalWorkspaceId: null", async () => {
    const store = runtime.getWorkspaceStore();
    // Create only a shared workspace; do NOT call ensureUserWorkspace.
    const shared = await store.create("Shared Only", "shared_only");
    await store.addMember(shared.id, "user_bob", "member");

    const body = await bootstrapFor("user_bob");

    expect(body.personalWorkspaceId).toBeNull();
    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0]?.isPersonal).toBe(false);
  });

  test("non-personal workspaces report isPersonal: false even when ownerUserId is unset", async () => {
    const store = runtime.getWorkspaceStore();
    const shared = await store.create("Org-Wide", "org_wide");
    await store.addMember(shared.id, "user_carol", "admin");

    const body = await bootstrapFor("user_carol");

    expect(body.workspaces[0]?.isPersonal).toBe(false);
    expect(body.personalWorkspaceId).toBeNull();
  });
});
