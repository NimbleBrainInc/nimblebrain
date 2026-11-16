import { describe, expect, test } from "bun:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4, LanguageModelV4Message } from "@ai-sdk/provider";
import { createXai } from "@ai-sdk/xai";
import type { StoredMessage } from "../../../src/conversation/types.ts";
import { rehydrateUserResources } from "../../../src/files/rehydrate.ts";
import type { FileStore } from "../../../src/files/store.ts";
import type { FileEntry } from "../../../src/files/types.ts";
import { fakeFetch } from "../../helpers/fake-fetch.ts";
import { stub } from "../../helpers/stub.ts";

// Every other test in the suite hands the engine a hand-written mock model, so
// no real provider converter ever runs. That is why an attachment could stop
// reaching the wire while the suite stayed green: `LanguageModelV4FilePart.data`
// is a tagged union, the Anthropic converter switches on `data.type` with no
// default arm, and a part it cannot match is dropped with no throw and no
// warning. These tests drive real adapters with stub `fetch` so the shape
// `rehydrateUserResources` emits is checked against provider request bodies.

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF_BYTES = Buffer.from("%PDF-1.4\nconverter-wire-fixture\n%%EOF");

type ModelFactory = (fetch: typeof globalThis.fetch) => LanguageModelV4;

const WIRE_MODELS = {
  anthropic: (fetch: typeof globalThis.fetch) =>
    createAnthropic({ apiKey: "sk-test", fetch }).languageModel("claude-haiku-4-5"),
  openai: (fetch: typeof globalThis.fetch) =>
    createOpenAI({ apiKey: "sk-test", fetch }).languageModel("gpt-4.1"),
  google: (fetch: typeof globalThis.fetch) =>
    createGoogleGenerativeAI({ apiKey: "test-key", fetch }).languageModel("gemini-2.5-flash"),
  xai: (fetch: typeof globalThis.fetch) =>
    createXai({ apiKey: "test-key", fetch }).chat("grok-4.20-0309-non-reasoning"),
  nebius: (fetch: typeof globalThis.fetch) =>
    createOpenAICompatible({
      name: "nebius",
      apiKey: "test-key",
      baseURL: "https://nebius.invalid/v1",
      fetch,
      includeUsage: true,
      supportsStructuredOutputs: true,
    }).languageModel("Qwen/Qwen3-235B-A22B-Instruct-2507"),
} satisfies Record<string, ModelFactory>;

/** Capture only the request; a 400 avoids maintaining vendor-specific response fixtures. */
async function sentRequestBody(
  factory: ModelFactory,
  prompt: LanguageModelV4Message[],
): Promise<string> {
  let body: string | undefined;
  const model = factory(
    fakeFetch(async (_url, init) => {
      body = String(init?.body ?? "");
      return new Response('{"error":{"message":"captured request"}}', {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  try {
    await model.doStream({ prompt });
  } catch {
    // The stub rejects after the adapter sends its request.
  }
  if (!body) throw new Error("The provider converter did not send a request");
  return body;
}

/** Guard the attachment's typed wire block without pinning a vendor's full envelope. */
function hasMediaBlock(value: unknown, marker: string, base64: string): boolean {
  if (Array.isArray(value)) return value.some((item) => hasMediaBlock(item, marker, base64));
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const media = marker === "inlineData" ? item.inlineData : item.type === marker ? item : undefined;
  if (media !== undefined && JSON.stringify(media).includes(base64)) return true;
  return Object.values(item).some((part) => hasMediaBlock(part, marker, base64));
}

async function attachmentPrompt(input: {
  model: string;
  mimeType: string;
  filename: string;
  data: Buffer;
}): Promise<LanguageModelV4Message[]> {
  const id = "fl_providerwire";
  const stored: StoredMessage = {
    role: "user",
    content: [
      { type: "text", text: "Describe the attached wire fixture." },
      {
        type: "resource_link",
        uri: `files://${id}`,
        mimeType: input.mimeType,
        name: input.filename,
      },
    ],
    timestamp: "2026-05-07T00:00:00.000Z",
  };
  return rehydrateUserResources(
    [stored],
    storeWith(id, input.data, input.mimeType, input.filename),
    { model: input.model, maxExtractedTextSize: 1024 },
  );
}

function storeWith(id: string, data: Buffer, mimeType: string, filename: string): FileStore {
  const entry: FileEntry = {
    id,
    filename,
    mimeType,
    size: data.length,
    tags: [],
    source: "manual",
    conversationId: null,
    createdAt: "2026-05-07T00:00:00.000Z",
    description: null,
  };
  return stub<FileStore>({
    saveFile: () => Promise.reject(new Error("not used")),
    readFile: async (wanted) => {
      if (wanted !== id) throw new Error(`File not found: ${wanted}`);
      return { data, filename, mimeType, size: data.length };
    },
    resolveFilePath: () => Promise.reject(new Error("not used")),
    appendRegistry: () => Promise.reject(new Error("not used")),
    readRegistry: () => Promise.reject(new Error("not used")),
    findEntry: async (wanted) => (wanted === id ? entry : null),
  });
}

/** The part of an Anthropic Messages request body these tests read. */
interface AnthropicRequestBody {
  messages: Array<{ role: string; content: Array<{ type: string; [k: string]: unknown }> }>;
}

describe("rehydrated file parts survive a real provider converter", () => {
  test("an image attachment reaches the Anthropic wire as an image block", async () => {
    const stored: StoredMessage = {
      role: "user",
      content: [
        { type: "text", text: "what's in this picture?" },
        {
          type: "resource_link",
          uri: "files://fl_wire1",
          mimeType: "image/png",
          name: "photo.png",
        },
      ],
      timestamp: "2026-05-07T00:00:00.000Z",
    };

    const prompt = await rehydrateUserResources(
      [stored],
      storeWith("fl_wire1", PNG_BYTES, "image/png", "photo.png"),
      { model: "anthropic:claude-sonnet-4-6", maxExtractedTextSize: 1024 },
    );

    const body = JSON.parse(
      await sentRequestBody(WIRE_MODELS.anthropic, prompt),
    ) as AnthropicRequestBody;
    const content = body.messages[0]?.content ?? [];

    // The assertion that matters: the attachment is still there. A dropped part
    // leaves `["text"]` and no error anywhere.
    expect(content.map((c) => c.type)).toEqual(["text", "image"]);
    expect(content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG_BYTES.toString("base64") },
    });
  });

  const attachmentCases = [
    {
      provider: "anthropic",
      model: "anthropic:claude-haiku-4-5",
      mimeType: "application/pdf",
      filename: "report.pdf",
      data: PDF_BYTES,
      marker: "document",
    },
    {
      provider: "openai",
      model: "openai:gpt-4.1",
      mimeType: "image/png",
      filename: "photo.png",
      data: PNG_BYTES,
      marker: "input_image",
    },
    {
      provider: "openai",
      model: "openai:gpt-4.1",
      mimeType: "application/pdf",
      filename: "report.pdf",
      data: PDF_BYTES,
      marker: "input_file",
    },
    {
      provider: "google",
      model: "google:gemini-2.5-flash",
      mimeType: "image/png",
      filename: "photo.png",
      data: PNG_BYTES,
      marker: "inlineData",
    },
    {
      provider: "google",
      model: "google:gemini-2.5-flash",
      mimeType: "application/pdf",
      filename: "report.pdf",
      data: PDF_BYTES,
      marker: "inlineData",
    },
    {
      provider: "xai",
      model: "xai:grok-4.20-0309-non-reasoning",
      mimeType: "image/png",
      filename: "photo.png",
      data: PNG_BYTES,
      marker: "image_url",
    },
  ] as const;

  for (const input of attachmentCases) {
    test(`${input.provider} ${input.mimeType} survives to the provider request`, async () => {
      const prompt = await attachmentPrompt(input);
      const body = await sentRequestBody(WIRE_MODELS[input.provider], prompt);
      expect(hasMediaBlock(JSON.parse(body), input.marker, input.data.toString("base64"))).toBe(
        true,
      );
      expect(body).toContain("Describe the attached wire fixture.");
    });
  }

  test("text and tool result survive the Nebius converter", async () => {
    const prompt: LanguageModelV4Message[] = [
      { role: "user", content: [{ type: "text", text: "Nebius user sentinel." }] },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call_nebius", toolName: "lookup", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_nebius",
            toolName: "lookup",
            output: { type: "text", value: "Nebius tool sentinel." },
          },
        ],
      },
    ];
    const body = JSON.parse(await sentRequestBody(WIRE_MODELS.nebius, prompt)) as {
      messages: Array<{ role: string; content?: string; tool_call_id?: string }>;
    };
    expect(body.messages).toContainEqual(
      expect.objectContaining({ role: "user", content: "Nebius user sentinel." }),
    );
    expect(body.messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        content: "Nebius tool sentinel.",
        tool_call_id: "call_nebius",
      }),
    );
  });

  const toolResultCases = [
    {
      provider: "anthropic",
      data: PNG_BYTES,
      mimeType: "image/png",
      filename: "snapshot.png",
      marker: "image",
    },
    {
      provider: "anthropic",
      data: PDF_BYTES,
      mimeType: "application/pdf",
      filename: "report.pdf",
      marker: "document",
    },
    {
      provider: "openai",
      data: PNG_BYTES,
      mimeType: "image/png",
      filename: "snapshot.png",
      marker: "input_image",
    },
    {
      provider: "openai",
      data: PDF_BYTES,
      mimeType: "application/pdf",
      filename: "report.pdf",
      marker: "input_file",
    },
    {
      provider: "google",
      data: PNG_BYTES,
      mimeType: "image/png",
      filename: "snapshot.png",
      marker: "inlineData",
    },
    {
      provider: "google",
      data: PDF_BYTES,
      mimeType: "application/pdf",
      filename: "report.pdf",
      marker: "inlineData",
    },
  ] as const;

  for (const input of toolResultCases) {
    test(`${input.provider} tool-result ${input.mimeType} survives to the provider request`, async () => {
      const prompt: LanguageModelV4Message[] = [
        { role: "user", content: [{ type: "text", text: "Inspect the tool attachment." }] },
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "call_snapshot", toolName: "snapshot", input: {} },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_snapshot",
              toolName: "snapshot",
              output: {
                type: "content",
                value: [
                  { type: "text", text: "Tool attachment sentinel." },
                  {
                    type: "file",
                    mediaType: input.mimeType,
                    filename: input.filename,
                    data: { type: "data", data: new Uint8Array(input.data) },
                  },
                ],
              },
            },
          ],
        },
      ];
      const body = await sentRequestBody(WIRE_MODELS[input.provider], prompt);
      expect(hasMediaBlock(JSON.parse(body), input.marker, input.data.toString("base64"))).toBe(
        true,
      );
      expect(body).toContain("Tool attachment sentinel.");
    });
  }
});
