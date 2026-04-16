import { describe, expect, it } from "bun:test";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { createEchoModel } from "../helpers/echo-model.ts";

function userPrompt(text: string): LanguageModelV3CallOptions {
  return {
    prompt: [{ role: "user" as const, content: [{ type: "text" as const, text }] }],
  };
}

function systemOnlyPrompt(text: string): LanguageModelV3CallOptions {
  return {
    prompt: [{ role: "system" as const, content: text }],
  };
}

const sampleToolCall = {
  toolCallId: "call-1",
  toolName: "get_weather",
  input: JSON.stringify({ city: "Honolulu" }),
};

describe("createEchoModel — doGenerate", () => {
  it("echoes the last user message", async () => {
    const model = createEchoModel();
    const result = await model.doGenerate(userPrompt("hello"));

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: "text", text: "hello" });
    expect(result.finishReason.unified).toBe("stop");
  });

  it("returns [echo] when no user message is present", async () => {
    const model = createEchoModel();
    const result = await model.doGenerate(systemOnlyPrompt("you are helpful"));

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: "text", text: "[echo]" });
  });

  it("returns pre-programmed text response", async () => {
    const model = createEchoModel({ responses: [{ text: "custom" }] });
    const result = await model.doGenerate(userPrompt("ignored"));

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: "text", text: "custom" });
    expect(result.finishReason.unified).toBe("stop");
  });

  it("returns pre-programmed tool call", async () => {
    const model = createEchoModel({
      responses: [{ toolCalls: [sampleToolCall] }],
    });
    const result = await model.doGenerate(userPrompt("call a tool"));

    expect(result.content).toHaveLength(1);
    const tc = result.content[0];
    expect(tc.type).toBe("tool-call");
    expect(tc).toMatchObject({
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "get_weather",
      input: JSON.stringify({ city: "Honolulu" }),
    });
    expect(result.finishReason.unified).toBe("tool-calls");
  });

  it("falls back to echo after queue is exhausted", async () => {
    const model = createEchoModel({ responses: [{ text: "queued" }] });

    const first = await model.doGenerate(userPrompt("a"));
    expect(first.content[0]).toEqual({ type: "text", text: "queued" });

    const second = await model.doGenerate(userPrompt("fallback"));
    expect(second.content[0]).toEqual({ type: "text", text: "fallback" });
  });

  it("returns mixed text and tool calls", async () => {
    const model = createEchoModel({
      responses: [{ text: "thinking", toolCalls: [sampleToolCall] }],
    });
    const result = await model.doGenerate(userPrompt("do something"));

    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({ type: "text", text: "thinking" });
    expect(result.content[1]).toMatchObject({
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "get_weather",
    });
    expect(result.finishReason.unified).toBe("tool-calls");
  });
});

describe("createEchoModel — doStream", () => {
  it("produces correct stream part sequence", async () => {
    const model = createEchoModel();
    const { stream } = await model.doStream(userPrompt("hi"));

    const parts: string[] = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value.type);
    }

    expect(parts).toEqual([
      "stream-start",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
  });

  it("includes tool-call part when queued", async () => {
    const model = createEchoModel({
      responses: [{ toolCalls: [sampleToolCall] }],
    });
    const { stream } = await model.doStream(userPrompt("tools"));

    const parts: Array<{ type: string; [key: string]: unknown }> = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value as { type: string; [key: string]: unknown });
    }

    const toolPart = parts.find((p) => p.type === "tool-call");
    expect(toolPart).toBeDefined();
    expect(toolPart).toMatchObject({
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "get_weather",
    });
  });

  it("finish part contains usage and finishReason", async () => {
    const model = createEchoModel();
    const { stream } = await model.doStream(userPrompt("data"));

    const reader = stream.getReader();
    let finishPart: { type: string; usage?: unknown; finishReason?: unknown } | undefined;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.type === "finish") {
        finishPart = value as { type: string; usage?: unknown; finishReason?: unknown };
      }
    }

    expect(finishPart).toBeDefined();
    expect(finishPart!.usage).toBeDefined();
    expect(finishPart!.finishReason).toBeDefined();
  });
});
