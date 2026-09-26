import { describe, expect, it } from "bun:test";

describe("ChatRequest/ChatResult workspaceId", () => {
  it("ChatRequest type accepts workspaceId field", async () => {
    // Type-level check — if this compiles, the type is correct
    const { ChatRequest } = await import("../../../src/runtime/types.ts");
    const req = {
      message: "test",
      workspaceId: "ws_test",
    } satisfies import("../../../src/runtime/types.ts").ChatRequest;
    expect(req.workspaceId).toBe("ws_test");
  });

  it("ChatResult type accepts workspaceId field", async () => {
    const result = {
      response: "hello",
      conversationId: "conv_1",
      workspaceId: "ws_test",
      skillName: null,
      toolCalls: [],
      inputTokens: 100,
      outputTokens: 50,
      stopReason: "end_turn",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        costUsd: 0.001,
        model: "test",
        llmMs: 500,
        iterations: 1,
      },
    } satisfies import("../../../src/runtime/types.ts").ChatResult;
    expect(result.workspaceId).toBe("ws_test");
  });
});
