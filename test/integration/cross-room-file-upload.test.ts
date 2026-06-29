/**
 * Cross-room UPLOAD → file partition (the write side).
 *
 * A conversation is ROOM-owned: it lives under `workspaces/<roomWsId>/...` and
 * its attached files MUST land in that SAME room's partition
 * (`workspaces/<roomWsId>/files/<ownerId>/`) — the partition the chat READ path
 * rehydrates from. When a file is uploaded *attached to a conversation* on a
 * request that is NOT focused on that conversation's room (unfocused, or focused
 * on a different workspace), the upload must resolve the conversation's
 * authoritative room (probe + locator) and write THERE — not into the request's
 * header/personal partition.
 *
 * The sibling resume test (`runtime/cross-room-file-resume.test.ts`) pins the
 * read side by seeding the registry directly. This one drives the REAL upload
 * handler over HTTP (`POST /v1/resources` → `handleResourceUpload`) so it
 * exercises the actual partition-selection logic — the bug lived in the write
 * path. If the handler reverts to partitioning by the request header, the
 * attachment lands in the personal room while the chat reads from room A → it
 * silently vanishes, and the assertions below fail.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { personalWorkspaceIdFor } from "../../src/workspace/workspace-store.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { provisionTestWorkspace } from "../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nb-cross-room-file-upload-${Date.now()}`);

// The conversation's room — the chat is born here (focused on ROOM_A).
const ROOM_A = "ws_room_a";
// Dev mode: no identity on the request → the dev owner.
const OWNER = DEV_IDENTITY.id;
// An UNFOCUSED request (no X-Workspace-Id) falls back to the owner's personal
// room, a DIFFERENT workspace than ROOM_A. That gap is the cross-room hop the
// fix must bridge by resolving the conversation's room from the locator.
const PERSONAL = personalWorkspaceIdFor(OWNER);

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
  });
  await provisionTestWorkspace(runtime, ROOM_A);
  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe("cross-room upload writes to the conversation's room (not the request)", () => {
  it("a file attached to a room-A conversation lands in A even when the request is unfocused", async () => {
    // 1) Born in room A (focused on ROOM_A) — the conversation lives under
    //    workspaces/ws_room_a/conversations/<owner>/<convId>.jsonl.
    const born = await runtime.chat({ message: "hello from room A", workspaceId: ROOM_A });
    const convId = born.conversationId;

    // 2) Drive the REAL upload handler attached to that conversation, with the
    //    request UNFOCUSED (no X-Workspace-Id). The header/personal partition is
    //    PERSONAL; the conversation's room is A — they disagree, so this is the
    //    cross-room case the fix targets.
    const form = new FormData();
    form.append("file", new Blob(["room-A attachment bytes"], { type: "text/plain" }), "attach.txt");
    form.append("conversationId", convId);

    const res = await fetch(`${baseUrl}/v1/resources`, { method: "POST", body: form });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files).toHaveLength(1);
    const fileId: string = body.files[0].id;
    // The handler stamps the resolved room onto the FileEntry it returns.
    expect(body.files[0].workspaceId).toBe(ROOM_A);

    // 3) The file landed in room A's partition — the one the read path uses…
    const inRoomA = await runtime.getFileStore(ROOM_A, OWNER).findEntry(fileId);
    expect(inRoomA).not.toBeNull();
    expect(inRoomA?.workspaceId).toBe(ROOM_A);

    // …and NOT in the request's personal partition. With the write-side bug,
    // the upload partitions by the header (personal) and these two flip:
    // present in PERSONAL, absent in A → the attachment is lost on resume.
    expect(await runtime.getFileStore(PERSONAL, OWNER).findEntry(fileId)).toBeNull();

    // 4) Survives a read: an UNFOCUSED resume rehydrates from the conversation's
    //    room (A), where the upload actually wrote — the attachment is still
    //    there afterward, not orphaned in the wrong partition.
    await runtime.chat({ message: "resume from elsewhere", conversationId: convId });
    const afterResume = await runtime.getFileStore(ROOM_A, OWNER).findEntry(fileId);
    expect(afterResume).not.toBeNull();
    expect(afterResume?.workspaceId).toBe(ROOM_A);
    expect(await runtime.getFileStore(PERSONAL, OWNER).findEntry(fileId)).toBeNull();
  });
});
