import { describe, expect, it } from "bun:test";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { callModel } from "../../src/model/stream.ts";
import { createEchoModel } from "../helpers/echo-model.ts";

function userPrompt(text: string): LanguageModelV3CallOptions {
  return {
    prompt: [{ role: "user" as const, content: [{ type: "text" as const, text }] }],
  };
}

const sampleToolCall = {
  toolCallId: "call-1",
  toolName: "get_weather",
  input: JSON.stringify({ city: "Honolulu" }),
};

describe("callModel", () => {
  it("returns text content and calls onTextDelta", async () => {
    const model = createEchoModel();
    const deltas: string[] = [];

    const result = await callModel(model, userPrompt("hello"), (t) => deltas.push(t));

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: "text", text: "hello" });
    expect(deltas).toContain("hello");
    expect(result.usage.inputTokens.total).toBeGreaterThan(0);
    expect(result.usage.outputTokens.total).toBeGreaterThan(0);
    expect(result.finishReason.unified).toBe("stop");
  });

  it("returns tool call content", async () => {
    const model = createEchoModel({
      responses: [{ toolCalls: [sampleToolCall] }],
    });
    const deltas: string[] = [];

    const result = await callModel(model, userPrompt("call tool"), (t) => deltas.push(t));

    const toolBlock = result.content.find((c) => c.type === "tool-call");
    expect(toolBlock).toBeDefined();
    expect(toolBlock).toMatchObject({
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "get_weather",
      input: JSON.stringify({ city: "Honolulu" }),
    });
    expect(result.finishReason.unified).toBe("tool-calls");
  });

  it("handles mixed text and tool call response", async () => {
    const model = createEchoModel({
      responses: [{ text: "thinking aloud", toolCalls: [sampleToolCall] }],
    });
    const deltas: string[] = [];

    const result = await callModel(model, userPrompt("mixed"), (t) => deltas.push(t));

    const textBlock = result.content.find((c) => c.type === "text");
    const toolBlock = result.content.find((c) => c.type === "tool-call");
    expect(textBlock).toEqual({ type: "text", text: "thinking aloud" });
    expect(toolBlock).toBeDefined();
    expect(deltas).toContain("thinking aloud");
  });

  it("accumulates text deltas into one content block", async () => {
    const model = createEchoModel();
    const deltas: string[] = [];

    const result = await callModel(model, userPrompt("accumulate"), (t) => deltas.push(t));

    // The echo model emits one delta per text block; callModel should produce exactly one text content block
    const textBlocks = result.content.filter((c) => c.type === "text");
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0]).toEqual({ type: "text", text: "accumulate" });
  });

  it("extracts nested usage structure", async () => {
    const model = createEchoModel();

    const result = await callModel(model, userPrompt("usage test"), () => {});

    expect(result.usage.inputTokens).toBeDefined();
    expect(result.usage.inputTokens.total).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeDefined();
    expect(result.usage.outputTokens.total).toBeGreaterThan(0);
    // Verify nested fields exist (even if undefined)
    expect("noCache" in result.usage.inputTokens).toBe(true);
    expect("cacheRead" in result.usage.inputTokens).toBe(true);
    expect("text" in result.usage.outputTokens).toBe(true);
    expect("reasoning" in result.usage.outputTokens).toBe(true);
  });
});
