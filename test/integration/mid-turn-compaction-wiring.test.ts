/**
 * End-to-end wiring test for the MID-TURN fold.
 *
 * `test/integration/compaction-wiring.test.ts` covers the between-turns fold's
 * route. This covers the one the unit tests can't reach: the twelve lines in
 * `Runtime.chat` that decide whether `rewriteHistory` is installed at all, and
 * what happens to the summarizer call's cost when it is. The unit tests build
 * their own hook, so nothing else exercises the `features.compaction` gate,
 * `summarizeForMidTurnFold`, or the `aux.usage` append.
 *
 * A SINGLE chat turn drives it. The model calls a tool on every step with a
 * large argument payload, so the history grows inside one run — which is the
 * whole point — and turn-setup compaction cannot be what fired, because a
 * first turn opens on one message.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { workspaceConversationsDir } from "../../src/conversation/paths.ts";
import type { ConversationEvent } from "../../src/conversation/types.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { createTestAuthAdapter, TEST_IDENTITY } from "../helpers/test-auth-adapter.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const API_KEY = "mid-turn-compaction-wiring-key-1234";
const SUMMARY_NEEDLE = "MID_TURN_SUMMARY_NEEDLE_9z8y7x";
/** Steps before the model stops calling tools — enough to cross the budget. */
const TOOL_STEPS = 12;

/**
 * A model that grows the history from inside one run: each step emits a
 * tool call whose arguments are large, so the assistant message the engine
 * appends is large. The tool name varies per step so identical failures don't
 * trip the run supervisor's repetition guard.
 */
function growingModel() {
  let step = 0;
  return createMockModel((opts) => {
    const systemText = opts.prompt
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join(" ");
    if (systemText.includes("compacting the older portion")) {
      return { content: [{ type: "text", text: `${SUMMARY_NEEDLE} — dense summary` }] };
    }
    step += 1;
    if (step > TOOL_STEPS) return { content: [{ type: "text", text: "done" }] };
    return {
      content: [
        {
          type: "tool-call",
          toolCallId: `call-${step}`,
          toolName: `absent_tool_${step}`,
          input: JSON.stringify({ note: `${step}:${"x".repeat(6_000)}` }),
        },
      ],
      finishReason: "tool-calls",
    };
  });
}

async function startRuntime(workDir: string, compaction: boolean) {
  mkdirSync(workDir, { recursive: true });
  const runtime = await Runtime.start({
    model: { provider: "custom", adapter: growingModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir,
    features: { compaction },
    maxInputTokens: 8_000,
    maxOutputTokens: 512,
    maxIterations: TOOL_STEPS + 2,
  });
  await provisionTestWorkspace(runtime);
  const handle = startServer({
    runtime,
    port: 0,
    provider: createTestAuthAdapter(API_KEY, runtime),
  });
  return { runtime, handle, baseUrl: `http://localhost:${handle.port}` };
}

/** One chat turn. The loop inside it is what this test is about. */
async function sendTurn(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
      "X-Workspace-Id": TEST_WORKSPACE_ID,
    },
    body: JSON.stringify({ message: "Work through this with your tools." }),
  });
  expect(res.status).toBe(200);
  return (await res.json()).conversationId as string;
}

function readEvents(workDir: string, conversationId: string): ConversationEvent[] {
  const path = join(
    workspaceConversationsDir(workDir, TEST_WORKSPACE_ID, TEST_IDENTITY.id),
    `${conversationId}.jsonl`,
  );
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .slice(1)
    .map((l) => JSON.parse(l) as ConversationEvent);
}

const isCompactionUsage = (e: ConversationEvent) =>
  e.type === "aux.usage" && (e as { source?: string }).source === "compaction";

const onDir = join(tmpdir(), `nb-mid-turn-on-${Date.now()}`);
const offDir = join(tmpdir(), `nb-mid-turn-off-${Date.now()}`);
let on: Awaited<ReturnType<typeof startRuntime>>;
let off: Awaited<ReturnType<typeof startRuntime>>;

beforeAll(async () => {
  on = await startRuntime(onDir, true);
  off = await startRuntime(offDir, false);
});

afterAll(async () => {
  on?.handle.stop(true);
  off?.handle.stop(true);
  await on?.runtime.shutdown();
  await off?.runtime.shutdown();
  rmSync(onDir, { recursive: true, force: true });
  rmSync(offDir, { recursive: true, force: true });
});

describe("mid-turn compaction — wired path", () => {
  test(
    "a single turn folds mid-loop, bills the summarizer, and persists no compaction event",
    async () => {
      const convId = await sendTurn(on.baseUrl);
      const events = readEvents(onDir, convId);

      // The fold ran inside the turn. This is a FIRST turn — it opened on one
      // message — so turn-setup compaction had nothing to fold and cannot be
      // what produced this.
      expect(events.filter(isCompactionUsage).length).toBeGreaterThan(0);

      // Its cost is visible: the summarizer runs outside the agentic loop and
      // emits no llm.response, so the aux.usage append is the only record.
      const usage = events.find(isCompactionUsage) as { usage?: { inputTokens?: number } };
      expect(usage.usage?.inputTokens).toBeDefined();

      // And it left the conversation's record alone: a mid-turn fold is
      // in-memory for the turn, so nothing rewrites the stored projection.
      expect(events.some((e) => e.type === "history.compacted")).toBe(false);
    },
    30_000,
  );

  test(
    "features.compaction off makes no summarizer call on the same turn",
    async () => {
      const convId = await sendTurn(off.baseUrl);
      const events = readEvents(offDir, convId);

      // Same growth, same budget, gate closed: the hook is never installed, so
      // an operator who turned compaction off is not billed for folds.
      expect(events.filter(isCompactionUsage)).toEqual([]);
      expect(events.some((e) => e.type === "history.compacted")).toBe(false);
    },
    30_000,
  );
});
