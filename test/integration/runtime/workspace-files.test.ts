/**
 * File persistence tests — the workspace-owned layout.
 *
 * Files are workspace-owned: each lives at
 * `{workDir}/workspaces/<wsId>/files/<ownerId>/` (see `src/files/paths.ts`).
 * `Runtime.getFileStore(wsId, ownerId)` is the single sanctioned constructor;
 * the directory is path-authoritative for `workspaceId` + `ownerId` (§2.3). A
 * file created in one workspace never crosses the wall into another.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceFilesDir } from "../../../src/files/paths.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";

const testDir = join(tmpdir(), `nb-ws-files-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

const OWNER = "user_alice";
const WS_A = "ws_team_a";
const WS_B = "ws_team_b";

async function startRuntime(workDir: string): Promise<Runtime> {
  mkdirSync(workDir, { recursive: true });
  return Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    workDir,
  });
}

describe("file persistence — workspace layout", () => {
  it("a file created in a workspace lands under that workspace's files/<ownerId>", async () => {
    const workDir = join(testDir, "lands-in-workspace");
    const runtime = await startRuntime(workDir);

    const store = runtime.getFileStore(WS_A, OWNER);
    const saved = await store.saveFile(Buffer.from("hello A"), "note.txt", "text/plain");

    // The blob lives under the workspace's owner partition, not at the identity
    // level (`users/<ownerId>/files/`).
    const expectedDir = workspaceFilesDir(workDir, WS_A, OWNER);
    expect(saved.path.startsWith(expectedDir)).toBe(true);
    expect(existsSync(join(expectedDir, `${saved.id}_note.txt`))).toBe(true);
    expect(existsSync(join(workDir, "users", OWNER, "files"))).toBe(false);

    await runtime.shutdown();
  });

  it("a stored file reads back through the same workspace store", async () => {
    const workDir = join(testDir, "read-back");
    const runtime = await startRuntime(workDir);

    const store = runtime.getFileStore(WS_A, OWNER);
    const saved = await store.saveFile(Buffer.from("round trip"), "doc.txt", "text/plain");
    await store.appendRegistry({
      id: saved.id,
      filename: "doc.txt",
      mimeType: "text/plain",
      size: saved.size,
      tags: [],
      source: "manual",
      conversationId: null,
      createdAt: new Date().toISOString(),
      description: null,
      workspaceId: WS_A,
      ownerId: OWNER,
      visibility: "private",
    });

    const read = await store.readFile(saved.id);
    expect(read.data.toString("utf-8")).toBe("round trip");

    const entry = await store.findEntry(saved.id);
    expect(entry?.workspaceId).toBe(WS_A);
    expect(entry?.ownerId).toBe(OWNER);

    await runtime.shutdown();
  });

  it("a file in workspace A is NOT visible from workspace B", async () => {
    const workDir = join(testDir, "cross-workspace-isolation");
    const runtime = await startRuntime(workDir);

    const storeA = runtime.getFileStore(WS_A, OWNER);
    const saved = await storeA.saveFile(Buffer.from("A only"), "secret.txt", "text/plain");
    await storeA.appendRegistry({
      id: saved.id,
      filename: "secret.txt",
      mimeType: "text/plain",
      size: saved.size,
      tags: [],
      source: "manual",
      conversationId: null,
      createdAt: new Date().toISOString(),
      description: null,
      workspaceId: WS_A,
      ownerId: OWNER,
      visibility: "private",
    });

    // Same owner, different workspace → a different partition, a different wall.
    const storeB = runtime.getFileStore(WS_B, OWNER);
    expect(await storeB.findEntry(saved.id)).toBeNull();
    expect(await storeB.readRegistry()).toHaveLength(0);

    await runtime.shutdown();
  });
});
