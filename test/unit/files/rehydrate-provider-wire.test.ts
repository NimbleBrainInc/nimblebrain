import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModelV4Message } from "@ai-sdk/provider";
import { describe, expect, test } from "bun:test";
import type { StoredMessage } from "../../../src/conversation/types.ts";
import { rehydrateUserResources } from "../../../src/files/rehydrate.ts";
import type { FileStore } from "../../../src/files/store.ts";

// Every other test in the suite hands the engine a hand-written mock model, so
// no real provider converter ever runs. That is why an attachment could stop
// reaching the wire while the suite stayed green: `LanguageModelV4FilePart.data`
// is a tagged union, the Anthropic converter switches on `data.type` with no
// default arm, and a part it cannot match is dropped with no throw and no
// warning. This test drives the real adapter with a stub `fetch` so the shape
// `rehydrateUserResources` emits is checked against what an actual provider
// does with it.

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function storeWith(id: string, data: Buffer, mimeType: string, filename: string): FileStore {
  const entry = { id, filename, mimeType, size: data.length, tags: [], createdAt: "2026-05-07T00:00:00.000Z" };
  return {
    saveFile: () => Promise.reject(new Error("not used")),
    readFile: async (wanted) => {
      if (wanted !== id) throw new Error(`File not found: ${wanted}`);
      return { data, filename, mimeType, size: data.length };
    },
    resolveFilePath: () => Promise.reject(new Error("not used")),
    appendRegistry: () => Promise.reject(new Error("not used")),
    readRegistry: () => Promise.reject(new Error("not used")),
    findEntry: async (wanted) => (wanted === id ? (entry as never) : null),
    readSidecar: async () => null,
    writeSidecar: async () => {},
  } as unknown as FileStore;
}

/** Runs one prompt through the real Anthropic adapter, returning the request body it would send. */
async function anthropicRequestBody(prompt: LanguageModelV4Message[]): Promise<{
  messages: Array<{ role: string; content: Array<{ type: string; [k: string]: unknown }> }>;
}> {
  let captured: unknown;
  const model = createAnthropic({
    apiKey: "sk-test",
    fetch: (async (_url: string, init: { body: string }) => {
      captured = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch,
  }).languageModel("claude-sonnet-4-5");

  await (model as unknown as { doGenerate: (o: unknown) => Promise<unknown> }).doGenerate({ prompt });
  return captured as never;
}

describe("rehydrated file parts survive a real provider converter", () => {
  test("an image attachment reaches the Anthropic wire as an image block", async () => {
    const stored: StoredMessage = {
      role: "user",
      content: [
        { type: "text", text: "what's in this picture?" },
        { type: "resource_link", uri: "files://fl_wire1", mimeType: "image/png", name: "photo.png" },
      ],
      timestamp: "2026-05-07T00:00:00.000Z",
    };

    const prompt = await rehydrateUserResources(
      [stored],
      storeWith("fl_wire1", PNG_BYTES, "image/png", "photo.png"),
      { model: "anthropic:claude-sonnet-4-6", maxExtractedTextSize: 1024 },
    );

    const body = await anthropicRequestBody(prompt as LanguageModelV4Message[]);
    const content = body.messages[0]?.content ?? [];

    // The assertion that matters: the attachment is still there. A dropped part
    // leaves `["text"]` and no error anywhere.
    expect(content.map((c) => c.type)).toEqual(["text", "image"]);
    expect(content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG_BYTES.toString("base64") },
    });
  });
});
