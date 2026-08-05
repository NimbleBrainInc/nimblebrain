/**
 * `conversations__get` asks the RunBus whether THIS conversation has a live
 * turn, and that answer reaches the reader.
 *
 * The reader cannot tell an in-flight trailing run from one whose writer was
 * killed — both are a `run.start` with no terminator. Liveness is the only
 * thing that separates them, and it enters through this one wiring line. The
 * unit tests around `readConversation` cover both answers; nothing covered the
 * line that supplies one, so deleting the argument (or passing the wrong id)
 * left the whole suite green while settling live turns as interrupted.
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
import { createConversationsSource } from "../../../../src/tools/platform/conversations.ts";

const OWNER_ID = "usr_test";
const WS_ID = "ws_liveness000000";
const LIVE_ID = "conv_live0000000001";
const DEAD_ID = "conv_dead0000000001";

/** Conversation ids `isTurnActive` was asked about, in call order. */
let askedAbout: string[] = [];
/** Ids the fake RunBus reports as generating. */
let liveIds: Set<string>;

let workDir: string;
let source: McpSource;

/** A conversation whose trailing run never wrote a terminator. */
function writeUnterminated(id: string): void {
  const dir = join(workDir, "workspaces", WS_ID, "conversations", OWNER_ID);
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
    ownerId: OWNER_ID,
    workspaceId: WS_ID,
    format: "events",
  };
  const runId = `run_${id}`;
  const lines = [
    JSON.stringify(meta),
    JSON.stringify({
      ts: "2026-01-01T00:01:00.000Z",
      type: "user.message",
      content: [{ type: "text", text: "hello" }],
      userId: OWNER_ID,
    }),
    JSON.stringify({ ts: "2026-01-01T00:01:01.000Z", type: "run.start", runId }),
    JSON.stringify({
      ts: "2026-01-01T00:01:02.000Z",
      type: "llm.response",
      runId,
      model: "m1",
      content: [{ type: "text", text: "partial" }],
      usage: { inputTokens: 5, outputTokens: 2 },
      llmMs: 30,
    }),
    // No run.done — writer stopped here.
  ];
  writeFileSync(join(dir, `${id}.jsonl`), `${lines.join("\n")}\n`);
}

function makeRuntime(): Runtime {
  return {
    getCurrentIdentity: () => ({ id: OWNER_ID }),
    resolveRequestUserId: () => OWNER_ID,
    getWorkspaceStore: () => ({ getWorkspacesDir: () => join(workDir, "workspaces") }),
    onConversationsChanged: () => {},
    isTurnActive: (conversationId: string) => {
      askedAbout.push(conversationId);
      return liveIds.has(conversationId);
    },
  } as unknown as Runtime;
}

function exec(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  return runWithRequestContext(
    { identity: { id: OWNER_ID } as never, workspaceId: WS_ID },
    () => source.execute(tool, args),
  );
}

function messages(result: ToolResult): Array<Record<string, unknown>> {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected a text block");
  const data = JSON.parse(first.text) as { messages?: Array<Record<string, unknown>> };
  return data.messages ?? [];
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "nb-get-liveness-"));
  askedAbout = [];
  liveIds = new Set([LIVE_ID]);
  writeUnterminated(LIVE_ID);
  writeUnterminated(DEAD_ID);
  source = await createConversationsSource(makeRuntime(), new NoopEventSink());
  await source.start();
});

afterEach(async () => {
  await source.stop();
  rmSync(workDir, { recursive: true, force: true });
});

describe("conversations__get consults the RunBus for the conversation it was asked about", () => {
  test("a live turn stays pending", async () => {
    const msgs = messages(await exec("get", { id: LIVE_ID, expand: "full" }));
    const last = msgs[msgs.length - 1]!;
    expect(last.pending).toBe(true);
    expect(last.stopReason).toBeUndefined();
  });

  test("an identical file with no live turn settles as interrupted", async () => {
    const msgs = messages(await exec("get", { id: DEAD_ID, expand: "full" }));
    const last = msgs[msgs.length - 1]!;
    expect(last.pending).toBeUndefined();
    expect(last.stopReason).toBe("interrupted");
  });

  test("asks about the requested conversation, not some other one", async () => {
    // The failure this catches: a wrong id here reads as "not live" for a live
    // turn and settles it, which no reader-level test can see.
    await exec("get", { id: DEAD_ID, expand: "full" });
    expect(askedAbout).toContain(DEAD_ID);
    expect(askedAbout).not.toContain(LIVE_ID);
  });
});
