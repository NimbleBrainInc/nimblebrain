/**
 * Regression: a chat run must NOT be cancelled when the HTTP client that
 * started it disconnects mid-stream.
 *
 * The run is owned by the runtime, not by the request transport. A mobile
 * client that locks its screen / backgrounds the tab / hits a network blip
 * tears down the SSE connection, but the engine loop must keep running,
 * persist its result, and stay available to a reconnecting
 * `/v1/conversations/:id/events` subscriber. This is the "leave and come
 * back and it loaded" contract.
 *
 * PR #251 threaded `request.signal` into `runtime.chat`, so a disconnect
 * aborted the run — it died with `run.error: "The connection was closed."`
 * and never produced a reply. This test pins the corrected behavior: after
 * the client disconnects, the conversation still ends in `run.done` with the
 * assistant's response persisted, and no `run.error` is written.
 *
 * On the regressed code this fails (no `run.done`; a connection-closed
 * `run.error` instead).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

const SENTINEL = "DETACH_SENTINEL";
const BACKGROUND_REPLY = "completed in the background after disconnect";

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("POST /v1/chat/stream — run survives client disconnect", () => {
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
    // `abortSignal` fires first. That `abortSignal` is exactly what the
    // engine forwards from `ChatRequest.signal` — so on the regressed code
    // (which threads `request.signal`), a client disconnect aborts this
    // call and the run errors. On the fixed code no signal is threaded,
    // so `options.abortSignal` is undefined and the run completes.
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
        const onAbort = () =>
          reject(new DOMException("The operation was aborted.", "AbortError"));
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
      model: { provider: "custom", adapter: gatedModel },
      noDefaultBundles: true,
      logging: { disabled: true },
      workDir,
    });
    await provisionTestWorkspace(runtime);
    handle = startServer({ runtime, port: 0 });
    const baseUrl = `http://localhost:${handle.port}`;

    // Seed a conversation to get a stable convId to assert against.
    const seed = await runtime.chat({ message: "seed", workspaceId: TEST_WORKSPACE_ID });
    const convId = seed.conversationId;

    // Start the streamed turn. The model gates, so the run is in-flight
    // (and holds the conversation lock) while we yank the connection.
    const ac = new AbortController();
    const res = await fetch(`${baseUrl}/v1/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
      body: JSON.stringify({ message: `${SENTINEL} please answer`, conversationId: convId }),
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
    expect(runtime.isConversationActive(convId)).toBe(true);

    // The mobile client drops: abort the request and tear down the reader.
    // This fires the server stream's cancel(); on the regressed code it
    // also aborted request.signal and killed the run.
    await reader.cancel().catch(() => {});
    ac.abort();

    // Give the server a tick to observe the disconnect, then let the
    // (now detached) run finish.
    await new Promise((r) => setTimeout(r, 50));
    release();

    // The run must settle by completing — releasing the conversation lock.
    await waitFor(() => runtime?.isConversationActive(convId) === false);
    expect(runtime.isConversationActive(convId)).toBe(false);

    // Inspect the persisted event log — the same surface that showed
    // `run.error: "The connection was closed."` in the production repro.
    const store = (await runtime.resolveConversationStore(convId))!;
    const events = await store.readEvents(convId);

    const runErrors = events.filter((e) => e.type === "run.error");
    expect(runErrors).toEqual([]);
    expect(events.some((e) => e.type === "run.done")).toBe(true);

    // And the assistant's answer — produced entirely after the client
    // left — was persisted.
    const llmResponses = events.filter((e) => e.type === "llm.response");
    expect(JSON.stringify(llmResponses)).toContain(BACKGROUND_REPLY);
  });
});
