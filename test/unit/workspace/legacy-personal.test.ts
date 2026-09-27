import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { UserStore } from "../../../src/identity/user.ts";
import { retireLegacyPersonalWorkspaces } from "../../../src/workspace/legacy-personal.ts";
import type { WorkspaceMember } from "../../../src/workspace/types.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";

let workDir: string;
let store: WorkspaceStore;
let users: UserStore;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "ws-legacy-personal-test-"));
  store = new WorkspaceStore(workDir);
  users = new UserStore(workDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function recordPath(id: string): string {
  return join(workDir, "workspaces", id, "workspace.json");
}

/** Write a workspace record as an earlier build left it on disk. */
async function writeRaw(record: {
  id: string;
  name: string;
  members: WorkspaceMember[];
  isPersonal?: boolean;
  ownerUserId?: string;
}): Promise<void> {
  await mkdir(join(workDir, "workspaces", record.id), { recursive: true });
  const now = "2026-01-01T00:00:00.000Z";
  await writeFile(
    recordPath(record.id),
    JSON.stringify({ connectors: [], createdAt: now, updatedAt: now, about: null, ...record }),
  );
}

async function readRaw(id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(recordPath(id), "utf-8"));
}

async function addUser(id: string, displayName: string, defaultWorkspaceId?: string) {
  await users.create({
    id,
    email: `${id}@example.com`,
    displayName,
    ...(defaultWorkspaceId ? { preferences: { defaultWorkspaceId } } : {}),
  });
}

describe("retireLegacyPersonalWorkspaces", () => {
  test("removes the legacy fields from every record, personal and shared, keeping ids", async () => {
    await addUser("user_alice", "Alice Smith");
    await writeRaw({
      id: "ws_user_user_alice",
      name: "Alice Smith's Workspace",
      members: [{ userId: "user_alice", role: "admin" }],
      isPersonal: true,
      ownerUserId: "user_alice",
    });
    await writeRaw({
      id: "ws_team0000000000001",
      name: "Team",
      members: [{ userId: "user_alice", role: "member" }],
      isPersonal: false,
    });

    await retireLegacyPersonalWorkspaces(store, users);

    for (const id of ["ws_user_user_alice", "ws_team0000000000001"]) {
      const raw = await readRaw(id);
      expect(raw.id).toBe(id);
      expect("isPersonal" in raw).toBe(false);
      expect("ownerUserId" in raw).toBe(false);
    }
    expect((await readRaw("ws_team0000000000001")).name).toBe("Team");
    expect(await store.listLegacyPersonal()).toEqual([]);
  });

  test("sets the owner's default when unset", async () => {
    await addUser("user_alice", "Alice");
    await writeRaw({
      id: "ws_user_user_alice",
      name: "Alice's Workspace",
      members: [{ userId: "user_alice", role: "admin" }],
      isPersonal: true,
      ownerUserId: "user_alice",
    });

    await retireLegacyPersonalWorkspaces(store, users);

    expect((await users.get("user_alice"))?.preferences.defaultWorkspaceId).toBe(
      "ws_user_user_alice",
    );
  });

  test("keeps an owner's default that is already set", async () => {
    await addUser("user_alice", "Alice", "ws_chosen0000000001");
    await writeRaw({
      id: "ws_user_user_alice",
      name: "Alice's Workspace",
      members: [{ userId: "user_alice", role: "admin" }],
      isPersonal: true,
      ownerUserId: "user_alice",
    });

    await retireLegacyPersonalWorkspaces(store, users);

    expect((await users.get("user_alice"))?.preferences.defaultWorkspaceId).toBe(
      "ws_chosen0000000001",
    );
  });

  test("renames a workspace still carrying the old provisioned name, keeps an edited one", async () => {
    await addUser("user_alice", "Alice Smith");
    await addUser("user_bob", "Bob Jones");
    await writeRaw({
      id: "ws_user_user_alice",
      name: "Alice Smith's Workspace",
      members: [{ userId: "user_alice", role: "admin" }],
      isPersonal: true,
      ownerUserId: "user_alice",
    });
    await writeRaw({
      id: "ws_user_user_bob",
      name: "Bob's lab",
      members: [{ userId: "user_bob", role: "admin" }],
      isPersonal: true,
      ownerUserId: "user_bob",
    });

    await retireLegacyPersonalWorkspaces(store, users);

    expect((await readRaw("ws_user_user_alice")).name).toBe("Alice's workspace");
    expect((await readRaw("ws_user_user_bob")).name).toBe("Bob's lab");
  });

  test("an owner with no profile record: fields still retired, name kept, owner seated", async () => {
    await writeRaw({
      id: "ws_user_user_ghost",
      name: "Ghost's Workspace",
      members: [],
      isPersonal: true,
      ownerUserId: "user_ghost",
    });

    await retireLegacyPersonalWorkspaces(store, users);

    const raw = await readRaw("ws_user_user_ghost");
    expect("isPersonal" in raw).toBe(false);
    expect("ownerUserId" in raw).toBe(false);
    expect(raw.name).toBe("Ghost's Workspace");
    expect(raw.members).toEqual([{ userId: "user_ghost", role: "admin" }]);
  });

  test("seats an owner missing from the member list as admin", async () => {
    await addUser("user_alice", "Alice");
    await writeRaw({
      id: "ws_user_user_alice",
      name: "Alice's Workspace",
      members: [{ userId: "user_other", role: "member" }],
      isPersonal: true,
      ownerUserId: "user_alice",
    });

    await retireLegacyPersonalWorkspaces(store, users);

    const raw = await readRaw("ws_user_user_alice");
    expect(raw.members).toEqual([
      { userId: "user_other", role: "member" },
      { userId: "user_alice", role: "admin" },
    ]);
    expect("isPersonal" in raw).toBe(false);
    expect("ownerUserId" in raw).toBe(false);
  });

  test("leaves an owner already in the member list untouched, whatever their role", async () => {
    await addUser("user_alice", "Alice");
    await writeRaw({
      id: "ws_user_user_alice",
      name: "Alice's Workspace",
      members: [
        { userId: "user_alice", role: "member" },
        { userId: "user_bob", role: "admin" },
      ],
      isPersonal: true,
      ownerUserId: "user_alice",
    });

    await retireLegacyPersonalWorkspaces(store, users);

    expect((await readRaw("ws_user_user_alice")).members).toEqual([
      { userId: "user_alice", role: "member" },
      { userId: "user_bob", role: "admin" },
    ]);
  });

  test("a second run is a no-op", async () => {
    await addUser("user_alice", "Alice");
    await writeRaw({
      id: "ws_user_user_alice",
      name: "Alice's Workspace",
      members: [{ userId: "user_alice", role: "admin" }],
      isPersonal: true,
      ownerUserId: "user_alice",
    });

    await retireLegacyPersonalWorkspaces(store, users);
    const afterFirst = await readFile(recordPath("ws_user_user_alice"), "utf-8");
    const profileAfterFirst = await users.get("user_alice");

    await retireLegacyPersonalWorkspaces(store, users);

    expect(await readFile(recordPath("ws_user_user_alice"), "utf-8")).toBe(afterFirst);
    expect(await users.get("user_alice")).toEqual(profileAfterFirst);
  });
});
