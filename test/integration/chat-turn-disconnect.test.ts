/**
 * A chat turn is NOT cancelled when the viewer watching it disconnects.
 *
 * The run is owned by the runtime, not by any HTTP connection. A mobile
 * client that locks its screen / backgrounds the tab / hits a network blip
 * tears down its `/v1/conversations/:id/events` stream, but the engine loop
 * keeps running, persists its result, and stays available to a reconnecting
 * subscriber. This is the "leave and come back and it loaded" contract: after
 * the viewer disconnects, the conversation still ends in `run.done` with the
 * assistant's response persisted, and no `run.error` is written. Only
 * `/v1/conversations/:id/cancel` stops a turn.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const SENTINEL = "DETACH_SENTINEL";
const BACKGROUND_REPLY = "completed in the background after disconnect";

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("chat turn — run survives viewer disconnect", () => {
  let handle: ServerHandle | null = null;
  let runtime: Runtime | null = null;

  afterEach(async () => {
    handle?.stop(true);
    await runtime?.shutdown();
    handle = null;
    runtime = null;
  });

  test("client disconnect mid-run does not cancel the run; it completes and persists", async () => {
    // Gate only the streamed turn (identified by the sentinel in its
    // prompt). The seed turn and its fire-and-forget auto-title pass
    // through immediately, so the gate isolates the run under test.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The gated turn mirrors a real provider: its in-flight call resolves
    // when the gate opens, but rejects with an AbortError if the run's
    // `abortSignal` fires first, so anything that aborted the run on a
    // disconnect would fail it here.
    const gatedModel = createMockModel((options) => {
      const promptText = JSON.stringify(options.prompt ?? "");
      if (!promptText.includes(SENTINEL)) {
        return { content: [{ type: "text", text: "seeded" }] };
      }
      const signal = options.abortSignal;
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("The operation was aborted.", "AbortError"));
          return;
        }
        const onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
        signal?.addEventListener("abort", onAbort, { once: true });
        gate.then(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve({ content: [{ type: "text", text: BACKGROUND_REPLY }] });
        });
      });
    });

    const workDir = join(tmpdir(), `nb-detach-${Date.now()}`);
    mkdirSync(workDir, { recursive: true });
    runtime = await Runtime.start({
      identityProvider: devProvider,
      model: { provider: "custom", adapter: gatedModel },
      logging: { disabled: true },
      workDir,
    });
    await provisionTestWorkspace(runtime);
    handle = startServer({ runtime, port: 0 });
    const baseUrl = `http://localhost:${handle.port}`;

    // Seed a conversation to get a stable convId to assert against.
    const seed = await runtime.chat({
      identity: DEV_IDENTITY,
      message: "seed",
      workspaceId: TEST_WORKSPACE_ID,
    });
    const convId = seed.conversationId;

    // Start the turn. The model gates, so the run is in flight while the
    // viewer connects and then drops.
    const start = await fetch(`${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/chat/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: `${SENTINEL} please answer`, conversationId: convId }),
    });
    expect(start.status).toBe(200);

    const ac = new AbortController();
    const res = await fetch(`${baseUrl}/v1/conversations/${convId}/events`, {
      signal: ac.signal,
    });

    // Read until the run has demonstrably started server-side.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const startDeadline = Date.now() + 5_000;
    while (!buffer.includes("event: chat.start") && Date.now() < startDeadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    expect(buffer).toContain("event: chat.start");
    expect(runtime.isTurnActive(convId)).toBe(true);

    // The mobile client drops: abort the request and tear down the reader.
    await reader.cancel().catch(() => {});
    ac.abort();

    // Give the server a tick to observe the disconnect, then let the run finish.
    await new Promise((r) => setTimeout(r, 50));
    release();

    await waitFor(() => runtime?.isTurnActive(convId) === false);
    expect(runtime.isTurnActive(convId)).toBe(false);

    // Inspect the persisted event log.
    const store = (await runtime.resolveConversationStore(convId))!;
    const events = await store.readEvents(convId);

    const runErrors = events.filter((e) => e.type === "run.error");
    expect(runErrors).toEqual([]);
    expect(events.some((e) => e.type === "run.done")).toBe(true);

    // And the assistant's answer, produced entirely after the viewer left,
    // was persisted.
    const llmResponses = events.filter((e) => e.type === "llm.response");
    expect(JSON.stringify(llmResponses)).toContain(BACKGROUND_REPLY);
  });
});
