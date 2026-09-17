/**
 * `conversations__list` reports, per entry, whether a reply is still
 * generating, read from the RunBus at request time.
 *
 * The conversations app draws its streaming dot from this flag. The index
 * cannot hold it: a turn starting or ending does not rewrite the file header
 * the index caches, so the answer has to be read on every list.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../../../src/adapters/noop-events.ts";
import type { ToolResult } from "../../../../src/engine/types.ts";
import { runWithRequestContext } from "../../../../src/runtime/request-context.ts";
import type { Runtime } from "../../../../src/runtime/runtime.ts";
import type { McpSource } from "../../../../src/tools/mcp-source.ts";
import { createConversationsSource } from "../../../../src/platform/conversations/source.ts";

const OWNER_ID = "usr_test";
const OTHER_ID = "usr_other";
const WS_ID = "ws_listlive0000000";
const LIVE_ID = "conv_live0000000001";
const IDLE_ID = "conv_idle0000000001";
const OTHERS_LIVE_ID = "conv_others00000001";

/** Ids the fake RunBus reports as generating. */
let liveIds: Set<string>;

let workDir: string;
let source: McpSource;

function writeConversation(id: string, ownerId: string): void {
  const dir = join(workDir, "workspaces", WS_ID, "conversations", ownerId);
  mkdirSync(dir, { recursive: true });
  const meta = {
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    title: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    lastModel: null,
    ownerId,
    workspaceId: WS_ID,
    format: "events",
  };
  const message = {
    ts: "2026-01-01T00:01:00.000Z",
    type: "user.message",
    content: [{ type: "text", text: "hello" }],
    userId: ownerId,
  };
  writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify(meta)}\n${JSON.stringify(message)}\n`);
}

function makeRuntime(): Runtime {
  return {
    getCurrentIdentity: () => ({ id: OWNER_ID }),
    resolveRequestUserId: () => OWNER_ID,
    getWorkspaceStore: () => ({ getWorkspacesDir: () => join(workDir, "workspaces") }),
    onConversationsChanged: () => {},
    isTurnActive: (conversationId: string) => liveIds.has(conversationId),
  } as unknown as Runtime;
}

async function list(): Promise<Array<{ id: string; active?: boolean }>> {
  const result: ToolResult = await runWithRequestContext(
    { identity: { id: OWNER_ID } as never, workspaceId: WS_ID },
    () => source.execute("list", {}),
  );
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected a text block");
  return (JSON.parse(first.text) as { conversations: Array<{ id: string; active?: boolean }> })
    .conversations;
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "nb-list-liveness-"));
  liveIds = new Set([LIVE_ID, OTHERS_LIVE_ID]);
  writeConversation(LIVE_ID, OWNER_ID);
  writeConversation(IDLE_ID, OWNER_ID);
  writeConversation(OTHERS_LIVE_ID, OTHER_ID);
  source = await createConversationsSource(makeRuntime(), new NoopEventSink());
  await source.start();
});

afterEach(async () => {
  await source.stop();
  rmSync(workDir, { recursive: true, force: true });
});

describe("conversations__list reports whether each conversation is generating", () => {
  test("a conversation with a live turn is active, one without is not", async () => {
    const byId = new Map((await list()).map((c) => [c.id, c.active]));
    expect(byId.get(LIVE_ID)).toBe(true);
    expect(byId.get(IDLE_ID)).toBe(false);
  });

  test("reads the RunBus on every list, not once", async () => {
    expect((await list()).find((c) => c.id === LIVE_ID)?.active).toBe(true);
    liveIds.delete(LIVE_ID);
    expect((await list()).find((c) => c.id === LIVE_ID)?.active).toBe(false);
  });

  test("another person's live conversation is not listed", async () => {
    expect((await list()).map((c) => c.id)).not.toContain(OTHERS_LIVE_ID);
  });
});
