import type { BootstrapResponse } from "../../src/api/schemas/responses.ts";
import { readJson } from "../helpers/http.ts";
/**
 * /v1/bootstrap provisions a workspace for a user who belongs to none and
 * picks the default focus (`activeWorkspace`) from the user's
 * `preferences.defaultWorkspaceId`, falling back to the earliest membership.
 *
 * Runs handleBootstrap directly against a real Runtime — no HTTP server
 * needed since the handler accepts (Runtime, identity) and returns a
 * Response.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleBootstrap } from "../../src/api/handlers.ts";
import { resolveFeatures } from "../../src/config/features.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";

const OPAQUE_ID = /^ws_[0-9a-f]{16}$/;

/**
 * Create workspaces in a known `createdAt` order. `list()` sorts by the
 * millisecond timestamp and breaks ties on the (random) id, so two creates in
 * one millisecond would order by chance.
 */
async function createInOrder(
  names: string[],
  userId: string,
  role: "admin" | "member" = "admin",
): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) {
    const ws = await runtime.getWorkspaceStore().create(name, {
      members: [{ userId, role }],
    });
    ids.push(ws.id);
    await Bun.sleep(2);
  }
  return ids;
}

let workDir: string;
let runtime: Runtime;

beforeEach(async () => {
  workDir = join(
    tmpdir(),
    `nb-bootstrap-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(workDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: devProvider,
    model: { provider: "custom", adapter: createEchoModel() },
    logging: { disabled: true },
    workDir,
  });
});

afterEach(async () => {
  await runtime.shutdown();
  rmSync(workDir, { recursive: true, force: true });
});

/** A user with a local profile, so provisioning can record their default. */
async function createUser(id: string, displayName: string): Promise<void> {
  await runtime.getUserStore().create({ id, email: `${id}@example.test`, displayName });
}

async function bootstrapFor(userId: string, displayName = userId): Promise<BootstrapResponse> {
  const profile = await runtime.getUserStore().get(userId);
  const res = await handleBootstrap(runtime, {
    id: userId,
    email: `${userId}@example.test`,
    displayName,
    orgRole: "member",
    preferences: profile?.preferences ?? {},
  });
  expect(res.status).toBe(200);
  return await readJson<BootstrapResponse>(res);
}

describe("bootstrap — a user with no workspace gets one", () => {
  test("provisions an ordinary workspace named for the user, as their default", async () => {
    await createUser("user_mat", "Mat Goldsborough");

    const body = await bootstrapFor("user_mat", "Mat Goldsborough");

    expect(body.workspaces).toHaveLength(1);
    const ws = body.workspaces[0]!;
    expect(ws.id).toMatch(OPAQUE_ID);
    expect(ws.name).toBe("Mat's workspace");
    expect(ws.role).toBe("admin");
    expect(body.activeWorkspace).toBe(ws.id);

    const profile = await runtime.getUserStore().get("user_mat");
    expect(profile?.preferences.defaultWorkspaceId).toBe(ws.id);
  });

  test("a second bootstrap does not create another workspace", async () => {
    await createUser("user_mat", "Mat Goldsborough");

    const first = await bootstrapFor("user_mat", "Mat Goldsborough");
    const second = await bootstrapFor("user_mat", "Mat Goldsborough");

    expect(second.workspaces).toHaveLength(1);
    expect(second.workspaces[0]?.id).toBe(first.workspaces[0]!.id);
    expect(await runtime.getWorkspaceStore().getWorkspacesForUser("user_mat")).toHaveLength(1);
  });

  test("concurrent bootstraps for a new user create exactly one workspace", async () => {
    await createUser("user_mat", "Mat Goldsborough");

    const bodies = await Promise.all(
      Array.from({ length: 5 }, () => bootstrapFor("user_mat", "Mat Goldsborough")),
    );

    const ids = new Set(bodies.map((b) => b.activeWorkspace));
    expect(ids.size).toBe(1);
    expect(await runtime.getWorkspaceStore().getWorkspacesForUser("user_mat")).toHaveLength(1);
  });

  test("the provisioned workspace accepts new members", async () => {
    await createUser("user_mat", "Mat Goldsborough");
    const body = await bootstrapFor("user_mat", "Mat Goldsborough");
    const wsId = body.workspaces[0]!.id;

    const updated = await runtime.getWorkspaceStore().addMember(wsId, "user_teammate", "member");

    expect(updated.members.map((m) => m.userId).sort()).toEqual(["user_mat", "user_teammate"]);
    const teammate = await bootstrapFor("user_teammate");
    expect(teammate.workspaces.map((w) => w.id)).toEqual([wsId]);
  });
});

describe("bootstrap — default focus", () => {
  test("follows preferences.defaultWorkspaceId over an earlier-created membership", async () => {
    await createUser("user_alice", "Alice");
    // Earlier-created team workspace, so the preferred one is NOT the first
    // membership — otherwise the preference and the fallback alias.
    const [team, own] = await createInOrder(["Team Alpha", "Alice's workspace"], "user_alice");
    const alice = (await runtime.getUserStore().get("user_alice"))!;
    await runtime.getUserStore().update("user_alice", {
      preferences: { ...alice.preferences, defaultWorkspaceId: own },
    });

    const body = await bootstrapFor("user_alice");

    expect(body.workspaces[0]?.id).toBe(team!);
    expect(body.activeWorkspace).toBe(own!);
  });

  test("falls back to the earliest membership when the user left the preferred one", async () => {
    await createUser("user_alice", "Alice");
    const [team, other, preferred] = await createInOrder(
      ["Team Alpha", "Other", "Preferred"],
      "user_alice",
    );
    const alice = (await runtime.getUserStore().get("user_alice"))!;
    await runtime.getUserStore().update("user_alice", {
      preferences: { ...alice.preferences, defaultWorkspaceId: preferred },
    });
    await runtime.getWorkspaceStore().removeMember(preferred!, "user_alice");

    const body = await bootstrapFor("user_alice");

    expect(body.workspaces.map((w) => w.id)).toEqual([team!, other!]);
    expect(body.activeWorkspace).toBe(team!);
  });

  test("no workspace entry carries isPersonal", async () => {
    await createUser("user_alice", "Alice");
    await createInOrder(["Team Alpha", "Team Beta"], "user_alice");

    const body = await bootstrapFor("user_alice");

    expect(body.workspaces).toHaveLength(2);
    expect(body.workspaces.every((w) => !("isPersonal" in w))).toBe(true);
  });
});

describe("bootstrap — attachment limits", () => {
  const identity = {
    id: "user_limits",
    email: "user_limits@example.test",
    displayName: "Limits",
    orgRole: "member" as const,
    preferences: {},
  };

  test("carries the files config when file context is on", async () => {
    const res = await handleBootstrap(runtime, identity, resolveFeatures({ fileContext: true }));
    const body = await readJson<BootstrapResponse>(res);
    const { maxFileSize, maxTotalSize, maxFilesPerMessage } = runtime.getFilesConfig();
    expect(body.config.files).toEqual({ maxFileSize, maxTotalSize, maxFilesPerMessage });
  });

  test("omits it when file context is off", async () => {
    const res = await handleBootstrap(runtime, identity, resolveFeatures({ fileContext: false }));
    const body = await readJson<BootstrapResponse>(res);
    expect(body.config.files).toBeUndefined();
  });
});
