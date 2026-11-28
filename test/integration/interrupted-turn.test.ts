/**
 * A chat turn whose process died has a stored start and no end. It is closed
 * `run.done` stopReason `interrupted` when the conversation is next opened (its
 * event stream subscribed with no turn running) or next resumed, before the new
 * turn's message, and the next message then runs as any other.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatStartResponse } from "../../src/api/schemas/responses.ts";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import type { ConversationEvent } from "../../src/conversation/types.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { workDirConversationStore } from "../helpers/conversation-store.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { readJson } from "../helpers/http.ts";
import { eventually } from "../helpers/tasks-plugin.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const WS = TEST_WORKSPACE_ID;
const OWNER = DEV_IDENTITY.id;
const testDir = join(tmpdir(), `nimblebrain-interrupted-${Date.now()}`);

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir: testDir,
  });
  await provisionTestWorkspace(runtime);
  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  rmSync(testDir, { recursive: true, force: true });
});

const store = () => runtime.workspaceConversationStore(WS, OWNER);

/** A conversation as a process that died mid-turn left it: the message and the run's start. */
async function interrupted(): Promise<string> {
  const seed = workDirConversationStore(testDir, WS, OWNER);
  const conv = await seed.create({ ownerId: OWNER, model: "anthropic:claude-sonnet-4-5" });
  const ts = new Date().toISOString();
  seed.appendEvent(conv.id, {
    ts,
    type: "user.message",
    content: [{ type: "text", text: "first question" }],
  } as ConversationEvent);
  seed.appendEvent(conv.id, {
    ts,
    type: "run.start",
    runId: "run_dead",
    model: "anthropic:claude-sonnet-4-5",
  } as ConversationEvent);
  await seed.flush();
  return conv.id;
}

const interruptedEnd = (events: ConversationEvent[]) =>
  events.findIndex(
    (e) => e.type === "run.done" && e.runId === "run_dead" && e.stopReason === "interrupted",
  );

describe("an interrupted chat turn", () => {
  it("is closed when its conversation is opened with no turn running", async () => {
    const id = await interrupted();
    const res = await fetch(`${baseUrl}/v1/workspaces/${WS}/conversations/${id}/events`);
    expect(res.status).toBe(200);
    await res.body?.cancel();
    expect(interruptedEnd(await store().readEvents(id))).toBeGreaterThan(0);
  });

  it("is closed before the next message, which then runs as any other", async () => {
    const id = await interrupted();
    const res = await fetch(`${baseUrl}/v1/workspaces/${WS}/chat/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "second question", conversationId: id }),
    });
    expect(res.status).toBe(200);
    expect((await readJson<ChatStartResponse>(res)).conversationId).toBe(id);
    await eventually(
      async () =>
        (await store().readEvents(id)).some(
          (e) => e.type === "run.done" && e.runId !== "run_dead" && e.stopReason === "complete",
        ),
      20_000,
      "the second turn to complete",
    );
    const events = await store().readEvents(id);
    const end = interruptedEnd(events);
    const second = events.findIndex(
      (e) => e.type === "user.message" && JSON.stringify(e.content).includes("second question"),
    );
    expect(end).toBeGreaterThan(0);
    expect(end).toBeLessThan(second);

    const source = runtime.getIdentitySource("conversations");
    if (!source) throw new Error("no conversations source");
    const got = await runWithRequestContext({ identity: DEV_IDENTITY, workspaceId: WS }, () =>
      source.execute("get", { id, expand: "full" }),
    );
    const messages = (
      got.structuredContent as { messages: Array<{ role: string; stopReason?: string }> }
    ).messages;
    expect(messages.map((m) => [m.role, m.stopReason])).toEqual([
      ["user", undefined],
      ["assistant", "interrupted"],
      ["user", undefined],
      ["assistant", undefined],
    ]);
  }, 30_000);
});
