/**
 * /v1/bootstrap surfaces the personal workspace identity via the
 * `workspaces[].isPersonal` flag on each entry.
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
  test("a fresh personal workspace reports isPersonal=true", async () => {
    await ensureUserWorkspace(runtime.getWorkspaceStore(), { id: "user_alice" });

    const body = await bootstrapFor("user_alice");

    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0]).toMatchObject({
      id: "ws_user_user_alice",
      isPersonal: true,
      role: "admin",
    });
  });

  test("with both personal + shared workspaces, only the personal one is flagged", async () => {
    const store = runtime.getWorkspaceStore();
    await ensureUserWorkspace(store, { id: "user_alice" });
    const shared = await store.create("Team Alpha", "team_alpha");
    await store.addMember(shared.id, "user_alice", "member");

    const body = await bootstrapFor("user_alice");

    expect(body.workspaces).toHaveLength(2);
    const personal = body.workspaces.find((w) => w.id === "ws_user_user_alice")!;
    const sharedEntry = body.workspaces.find((w) => w.id === shared.id)!;
    expect(personal.isPersonal).toBe(true);
    expect(sharedEntry.isPersonal).toBe(false);
  });

  test("a pre-migration user with no personal workspace has none flagged", async () => {
    const store = runtime.getWorkspaceStore();
    // Create only a shared workspace; do NOT call ensureUserWorkspace.
    const shared = await store.create("Shared Only", "shared_only");
    await store.addMember(shared.id, "user_bob", "member");

    const body = await bootstrapFor("user_bob");

    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0]?.isPersonal).toBe(false);
    // With no personal candidate, the default focus falls through to the first
    // membership — the only assertion in the suite that pins that branch.
    expect(body.activeWorkspace).toBe(shared.id);
  });

  test("non-personal workspaces report isPersonal: false even when ownerUserId is unset", async () => {
    const store = runtime.getWorkspaceStore();
    const shared = await store.create("Org-Wide", "org_wide");
    await store.addMember(shared.id, "user_carol", "admin");

    const body = await bootstrapFor("user_carol");

    expect(body.workspaces[0]?.isPersonal).toBe(false);
  });
});
