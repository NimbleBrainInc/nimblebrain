/**
 * End-to-end wiring test for history compaction.
 *
 * The unit tests cover the pure helpers (planCompaction, summarizeMessages,
 * compactConversationMessages, reconstructMessages, fork). This test covers
 * the ROUTE the units don't: enabling `features.compaction` and driving real
 * `/v1/chat` turns through a live Runtime + EventSourcedConversationStore until
 * the accumulated history crosses the budget, then proving that
 * `Runtime.maybeCompactHistory` actually fired — it persisted a
 * `history.compacted` event, the model-facing projection is compacted, and the
 * verbatim projection still holds every turn.
 *
 * Uses a mock model that returns a recognizable summary for the (doGenerate)
 * summarizer call and a large reply for normal (doStream) turns, so history
 * grows fast and the summary/oldest markers are assertable.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../../src/api/server.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import { reconstructMessages } from "../../src/conversation/event-reconstructor.ts";
import { workspaceConversationsDir } from "../../src/conversation/paths.ts";
import type { ConversationEvent } from "../../src/conversation/types.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { createTestAuthAdapter, TEST_IDENTITY } from "../helpers/test-auth-adapter.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

const API_KEY = "compaction-wiring-test-key-1234";
const OLDEST_NEEDLE = "OLDEST_TURN_NEEDLE_a1b2c3";
const SUMMARY_NEEDLE = "COMPACTION_SUMMARY_NEEDLE_d4e5f6";

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
const workDir = join(tmpdir(), `nb-compaction-wiring-${Date.now()}`);

beforeAll(async () => {
  mkdirSync(workDir, { recursive: true });

  // Mock model: the summarizer calls doGenerate with the SUMMARIZE_SYSTEM
  // preamble; everything else is a normal turn. We detect the summarizer by
  // its system text and return a recognizable summary; normal turns return a
  // large reply so history crosses the budget within a handful of turns.
  const model = createMockModel((opts) => {
    const systemText = opts.prompt
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join(" ");
    if (systemText.includes("compacting the older portion")) {
      return { content: [{ type: "text", text: `${SUMMARY_NEEDLE} — dense summary of older turns` }] };
    }
    return { content: [{ type: "text", text: `assistant reply ${"x".repeat(3000)}` }] };
  });

  runtime = await Runtime.start({
    model: { provider: "custom", adapter: model },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir,
    features: { compaction: true },
    // Small budget + bounded output so a few large turns cross the trigger.
    maxInputTokens: 8000,
    maxOutputTokens: 512,
  });

  await provisionTestWorkspace(runtime);

  handle = startServer({
    runtime,
    port: 0,
    provider: createTestAuthAdapter(API_KEY, runtime),
  });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle?.stop(true);
  await runtime?.shutdown();
  rmSync(workDir, { recursive: true, force: true });
});

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_KEY}`,
    "X-Workspace-Id": TEST_WORKSPACE_ID,
  };
}

async function sendTurn(message: string, conversationId?: string): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/chat`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(conversationId ? { message, conversationId } : { message }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.conversationId as string;
}

function readEvents(conversationId: string): ConversationEvent[] {
  // The authenticated caller (usr_test via the test auth adapter) chats focused
  // on TEST_WORKSPACE_ID, so the conversation lives in that workspace's owner partition.
  const path = join(
    workspaceConversationsDir(workDir, TEST_WORKSPACE_ID, TEST_IDENTITY.id),
    `${conversationId}.jsonl`,
  );
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  return lines.slice(1).map((l) => JSON.parse(l) as ConversationEvent);
}

describe("history compaction — wired path", () => {
  test(
    "enabling features.compaction drives a chat to compact, persist, and split projections",
    async () => {
      // Turn 1 carries a unique marker so we can prove it later gets summarized
      // away from the model view but survives in the verbatim view.
      const convId = await sendTurn(`First question. ${OLDEST_NEEDLE}`);

      // Drive turns until compaction fires (it persists a history.compacted
      // event), capped so a wiring regression fails fast instead of hanging.
      let compacted = false;
      for (let i = 0; i < 24 && !compacted; i++) {
        await sendTurn(`Follow up number ${i} with some additional content to grow the history.`, convId);
        compacted = readEvents(convId).some((e) => e.type === "history.compacted");
      }

      const events = readEvents(convId);

      // (a) The wired path actually persisted a compaction event.
      expect(events.some((e) => e.type === "history.compacted")).toBe(true);

      // (a.2) The summarizer's usage is persisted as an aux.usage event, so the
      // fold's cost is visible to the usage aggregator (not undercounted).
      expect(
        events.some(
          (e) =>
            e.type === "aux.usage" &&
            (e as { source?: string }).source === "compaction" &&
            (e as { usage?: { inputTokens?: number } }).usage?.inputTokens !== undefined,
        ),
      ).toBe(true);

      // (a.3) The summarizer's usage is ALSO recorded to Prometheus — proves
      // the forked-call metric wiring (recordLlmUsage("compaction", ...) at the
      // onUsage site) fires end-to-end, not just the aux.usage append.
      const metricsBody = await (await fetch(`${baseUrl}/metrics`)).text();
      expect(metricsBody).toMatch(/nb_llm_tokens_total\{[^}]*source="compaction"[^}]*\}\s+[1-9]/);

      // (b) The model-facing projection is compacted: it carries the summary
      //     seed and NOT the oldest turn's text.
      const modelView = JSON.stringify(reconstructMessages(events));
      expect(modelView).toContain("<conversation-summary>");
      expect(modelView).toContain(SUMMARY_NEEDLE);
      expect(modelView).not.toContain(OLDEST_NEEDLE);

      // (c) The verbatim projection (what fork/UI read) still holds every turn.
      const verbatimView = JSON.stringify(reconstructMessages(events, { ignoreCompaction: true }));
      expect(verbatimView).toContain(OLDEST_NEEDLE);
      expect(verbatimView).not.toContain("<conversation-summary>");
    },
    30_000,
  );
});
