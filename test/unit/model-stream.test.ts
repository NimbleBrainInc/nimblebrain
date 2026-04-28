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

  it("emits tool-input start/end callbacks before the tool-call block", async () => {
    const model = createEchoModel({
      responses: [{ text: "preface", toolCalls: [sampleToolCall] }],
    });
    const events: string[] = [];

    await callModel(
      model,
      userPrompt("prep"),
      (t) => events.push(`text:${t}`),
      undefined,
      (id, name) => events.push(`prep-start:${id}:${name}`),
      (id) => events.push(`prep-end:${id}`),
    );

    // Tool-input start fires once per tool, with the tool name already known
    // (this is what lets the UI show "Calling X…" before execution begins).
    // Per-char tool-input-delta is intentionally swallowed in stream.ts —
    // verify by asserting only one start and one end event for this tool.
    const startEvents = events.filter((e) => e.startsWith("prep-start:"));
    const endEvents = events.filter((e) => e.startsWith("prep-end:"));
    expect(startEvents).toEqual([`prep-start:${sampleToolCall.toolCallId}:${sampleToolCall.toolName}`]);
    expect(endEvents).toEqual([`prep-end:${sampleToolCall.toolCallId}`]);

    // Order: text deltas precede prep-start (text emitted before tool-use
    // block in this fixture); prep-end precedes nothing relevant for this test
    // but must precede the assembled tool-call returned in result.content.
    const textIdx = events.findIndex((e) => e === "text:preface");
    const startIdx = events.indexOf(startEvents[0]);
    const endIdx = events.indexOf(endEvents[0]);
    expect(textIdx).toBeLessThan(startIdx);
    expect(startIdx).toBeLessThan(endIdx);
  });

  it("does not invoke tool-input callbacks for text-only responses", async () => {
    const model = createEchoModel();
    let starts = 0;
    let ends = 0;

    await callModel(
      model,
      userPrompt("no tools"),
      () => {},
      undefined,
      () => {
        starts++;
      },
      () => {
        ends++;
      },
    );

    expect(starts).toBe(0);
    expect(ends).toBe(0);
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
