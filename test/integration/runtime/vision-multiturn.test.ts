/**
 * End-to-end regression for the bug that motivated the resource_link
 * persistence migration: image attachments dropped out of conversation
 * history after turn 1 because the user-message content reconstruction
 * filtered to text-only. A multi-turn agentic loop (extract from
 * screenshot → call CRM tool → continue) saw vision on turn 1 and
 * nothing on turn 2.
 *
 * This test asserts that an uploaded PNG reaches the model as an inline
 * `file` part on BOTH turn 1 and turn 2 of the agent loop.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FilePart,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { type ServerHandle, startServer } from "../../../src/api/server.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../../helpers/test-workspace.ts";

/**
 * A LanguageModelV3 that records every prompt it receives and returns
 * scripted responses. Lets the test inspect the user-message content the
 * engine actually sent to `model.doStream` on each iteration.
 */
function createRecordingModel(scripted: Array<{ text: string; toolCalls?: { id: string; name: string; input: string }[] }>): {
  model: LanguageModelV3;
  prompts: LanguageModelV3CallOptions["prompt"][];
} {
  const prompts: LanguageModelV3CallOptions["prompt"][] = [];
  let i = 0;

  const model: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: "test",
    modelId: "test-recording",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("doGenerate not used in this test");
    },
    async doStream(options: LanguageModelV3CallOptions) {
      prompts.push(options.prompt);
      const turn = scripted[i++] ?? scripted[scripted.length - 1]!;
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (turn.text) {
            controller.enqueue({ type: "text-start", id: "t1" });
            controller.enqueue({ type: "text-delta", id: "t1", delta: turn.text });
            controller.enqueue({ type: "text-end", id: "t1" });
          }
          if (turn.toolCalls) {
            for (const tc of turn.toolCalls) {
              controller.enqueue({
                type: "tool-call",
                toolCallId: tc.id,
                toolName: tc.name,
                input: tc.input,
              });
            }
          }
          controller.enqueue({
            type: "finish",
            usage: {
              inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 5, text: 5, reasoning: undefined },
            },
            finishReason: {
              unified: turn.toolCalls && turn.toolCalls.length > 0 ? "tool-calls" : "stop",
              raw: undefined,
            },
          });
          controller.close();
        },
      });
      return { stream, request: undefined };
    },
  };

  return { model, prompts };
}

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk header
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1 image
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
let recorded: { prompts: LanguageModelV3CallOptions["prompt"][] };
const testDir = join(tmpdir(), `nb-vision-multiturn-${Date.now()}`);

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  // Two scripted turns:
  //  1. Model "calls" a tool — forces the engine to issue a second iteration.
  //     The system tool `nb__list_apps` exists on every workspace (no bundles
  //     required), so we don't need to install anything to satisfy the call.
  //  2. Model produces final text.
  const { model, prompts } = createRecordingModel([
    {
      text: "Looking at the image now…",
      toolCalls: [{ id: "call_1", name: "nb__list_apps", input: "{}" }],
    },
    { text: "Done — that's John Doe, VP Sales at Acme." },
  ]);
  recorded = { prompts };

  runtime = await Runtime.start({
    model: { provider: "custom", adapter: model },
    noDefaultBundles: true,
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

describe("vision survives the multi-turn agent loop", () => {
  it("uploaded PNG reaches the model as an inline file part on BOTH turns", async () => {
    const form = new FormData();
    form.append("message", "extract the contact from this screenshot");
    form.append("workspaceId", TEST_WORKSPACE_ID);
    const file = new File([new Uint8Array(PNG_BYTES)], "linkedin.png", { type: "image/png" });
    form.append("files", file);

    const res = await fetch(`${baseUrl}/v1/chat/stream`, {
      method: "POST",
      headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
      body: form,
    });
    expect(res.status).toBe(200);
    await res.text();

    // Two iterations: turn 1 (model emits tool call) + turn 2 (model emits final text).
    expect(recorded.prompts.length).toBe(2);

    for (let turn = 0; turn < 2; turn++) {
      const prompt = recorded.prompts[turn]!;
      const userMsg = prompt.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      if (!userMsg || userMsg.role !== "user") return;

      const filePart = userMsg.content.find(
        (c): c is LanguageModelV3FilePart => c.type === "file",
      );
      expect(filePart).toBeDefined();
      if (!filePart) return;
      expect(filePart.mediaType).toBe("image/png");
      expect(filePart.data).toBeInstanceOf(Uint8Array);
      const bytes = filePart.data as Uint8Array;
      expect(Buffer.from(bytes).equals(PNG_BYTES)).toBe(true);
    }
  });
});
