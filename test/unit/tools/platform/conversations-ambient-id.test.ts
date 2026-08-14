/**
 * The conversation-addressing tools resolve the conversation you are in.
 *
 * An agent running inside a chat is never told its own conversation id, so a
 * required `id` on `update`/`get`/`fork`/`export` left the current conversation
 * as the one conversation those tools could not name. What an agent does
 * instead is invent a placeholder — and get `Conversation not found` back.
 *
 * These tests pin the three answers: omitted resolves ambiently, the
 * placeholder agents reach for resolves the same way, and outside a chat the
 * failure says what to pass instead.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../../../src/adapters/noop-events.ts";
import type { ToolResult } from "../../../../src/engine/types.ts";
import { runWithRequestContext } from "../../../../src/runtime/request-context.ts";
import type { Runtime } from "../../../../src/runtime/runtime.ts";
import type { McpSource } from "../../../../src/tools/mcp-source.ts";
import { createConversationsSource } from "../../../../src/tools/platform/conversations.ts";

const OWNER_ID = "usr_test";
const WS_ID = "ws_ambient00000000";
/** The conversation the agent is running inside. */
const CURRENT_ID = "conv_aaaaaaaaaaaaaaaa";
/** Another of the caller's conversations, named explicitly. */
const OTHER_ID = "conv_bbbbbbbbbbbbbbbb";
/** The current conversation's only message — what identifies it in a payload. */
const CURRENT_MESSAGE = "save this into your memory";
/** An automation run's correlation id, in the shape `executeTask` mints. */
const RUN_ID = "run_0123456789ab";

let workDir: string;
let source: McpSource;

function writeConversation(id: string, title: string, message: string): void {
  const dir = join(workDir, "workspaces", WS_ID, "conversations", OWNER_ID);
  mkdirSync(dir, { recursive: true });
  const meta = {
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    title,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    lastModel: null,
    ownerId: OWNER_ID,
    workspaceId: WS_ID,
  };
  const lines = [
    JSON.stringify(meta),
    JSON.stringify({
      role: "user",
      content: message,
      timestamp: "2026-01-01T00:01:00.000Z",
    }),
  ];
  writeFileSync(join(dir, `${id}.jsonl`), `${lines.join("\n")}\n`);
}

function storedTitle(id: string): string {
  const path = join(workDir, "workspaces", WS_ID, "conversations", OWNER_ID, `${id}.jsonl`);
  const line = readFileSync(path, "utf-8").split("\n")[0]!;
  return (JSON.parse(line) as { title: string }).title;
}

function makeRuntime(): Runtime {
  return {
    getCurrentIdentity: () => ({ id: OWNER_ID }),
    resolveRequestUserId: () => OWNER_ID,
    getWorkspaceStore: () => ({ getWorkspacesDir: () => join(workDir, "workspaces") }),
    onConversationsChanged: () => {},
    isTurnActive: () => false,
  } as unknown as Runtime;
}

/** Run a tool the way a chat does — with an ambient conversation in scope. */
function inChat(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  return runWithRequestContext(
    { identity: { id: OWNER_ID } as never, workspaceId: WS_ID, conversationId: CURRENT_ID },
    () => source.execute(tool, args),
  );
}

/** Run a tool the way a REST or `/mcp` caller does — no conversation in scope. */
function outsideChat(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  return runWithRequestContext(
    { identity: { id: OWNER_ID } as never, workspaceId: WS_ID },
    () => source.execute(tool, args),
  );
}

/**
 * Run a tool the way an unattended automation does. `executeTask` sets
 * `conversationId` to the RUN id — a correlation id for stamping audit and
 * file records — so the field is populated with something that is not a
 * conversation.
 */
function inAutomationRun(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  return runWithRequestContext(
    {
      identity: { id: OWNER_ID } as never,
      workspaceId: WS_ID,
      conversationId: RUN_ID,
      unattended: true,
    },
    () => source.execute(tool, args),
  );
}

function parseFirst(result: ToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected a text block");
  return JSON.parse(first.text) as Record<string, unknown>;
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "nb-ambient-conv-"));
  writeConversation(CURRENT_ID, "Untitled", CURRENT_MESSAGE);
  writeConversation(OTHER_ID, "Other", "something else entirely");
  source = await createConversationsSource(makeRuntime(), new NoopEventSink());
  await source.start();
});

afterEach(async () => {
  await source.stop();
  rmSync(workDir, { recursive: true, force: true });
});

describe("conversations__update", () => {
  test("with no id, retitles the conversation the call is inside", async () => {
    const result = await inChat("update", { title: "Doctrine" });

    expect(result.isError).toBe(false);
    expect(parseFirst(result).id).toBe(CURRENT_ID);
    expect(storedTitle(CURRENT_ID)).toBe("Doctrine");
    expect(storedTitle(OTHER_ID)).toBe("Other");
  });

  test('id: "current" resolves the same way', async () => {
    const result = await inChat("update", { id: "current", title: "Doctrine" });

    expect(result.isError).toBe(false);
    expect(parseFirst(result).id).toBe(CURRENT_ID);
    expect(storedTitle(CURRENT_ID)).toBe("Doctrine");
  });

  test("an explicit id still wins over the ambient one", async () => {
    const result = await inChat("update", { id: OTHER_ID, title: "Named" });

    expect(result.isError).toBe(false);
    expect(parseFirst(result).id).toBe(OTHER_ID);
    expect(storedTitle(OTHER_ID)).toBe("Named");
    expect(storedTitle(CURRENT_ID)).toBe("Untitled");
  });

  test("outside a chat, an omitted id errors with what to pass instead", async () => {
    const result = await outsideChat("update", { title: "Doctrine" });

    expect(result.isError).toBe(true);
    const { error } = parseFirst(result) as { error: string };
    expect(error).toContain("No conversation in scope");
    expect(error).toContain("conversations__list");
    // Not the unresolvable-placeholder message the old contract produced.
    expect(error).not.toContain("Conversation not found");
    expect(storedTitle(CURRENT_ID)).toBe("Untitled");
  });
});

describe("the other conversation-addressing tools resolve the same way", () => {
  test("get with no id reads the current conversation", async () => {
    const result = await inChat("get", { expand: "metadata" });

    expect(result.isError).toBe(false);
    const { metadata } = parseFirst(result) as { metadata: { id: string } };
    expect(metadata.id).toBe(CURRENT_ID);
  });

  test("export with no id exports the current conversation", async () => {
    const result = await inChat("export", { format: "json" });

    expect(result.isError).toBe(false);
    const { content } = parseFirst(result) as { content: string };
    expect(content).toContain(CURRENT_MESSAGE);
  });

  test("fork with no id forks the current conversation", async () => {
    const result = await inChat("fork", {});

    expect(result.isError).toBe(false);
    // A fork is a NEW conversation, so its own id proves nothing — the preview
    // is what says which conversation it was copied from.
    const forked = parseFirst(result) as { id: string; preview: string };
    expect(forked.id).not.toBe(CURRENT_ID);
    expect(forked.preview).toContain(CURRENT_MESSAGE);
  });

  test("outside a chat, get with no id errors rather than guessing", async () => {
    const result = await outsideChat("get", { expand: "metadata" });

    expect(result.isError).toBe(true);
    const { error } = parseFirst(result) as { error: string };
    expect(error).toContain("No conversation in scope");
  });
});

describe("an automation run has no conversation, even though the field is set", () => {
  // `executeTask` populates `conversationId` with the run id, so "is the field
  // set" and "is a conversation in scope" are different questions. Answering
  // the first resolves `run_...` and reports `Conversation not found: run_...`
  // — the exact failure the ambient fallback exists to remove.

  for (const [tool, args] of [
    ["update", { title: "Doctrine" }],
    ["get", { expand: "metadata" }],
    ["export", { format: "json" }],
    ["fork", {}],
  ] as const) {
    test(`${tool} with no id errors, and does not name the run id`, async () => {
      const result = await inAutomationRun(tool, args);

      expect(result.isError).toBe(true);
      const { error } = parseFirst(result) as { error: string };
      expect(error).toContain("No conversation in scope");
      expect(error).not.toContain(RUN_ID);
      expect(error).not.toContain("Conversation not found");
    });
  }

  test("an explicit id still works inside a run", async () => {
    // The guard rejects the ambient value, not the caller's — a run that names
    // a real conversation still reaches it.
    const result = await inAutomationRun("update", { id: OTHER_ID, title: "Named" });

    expect(result.isError).toBe(false);
    expect(storedTitle(OTHER_ID)).toBe("Named");
  });
});
