import { describe, expect, test } from "bun:test";
import { reconstructMessages } from "../../../src/conversation/event-reconstructor.ts";
import type { ConversationEvent } from "../../../src/conversation/types.ts";

/**
 * Regression: the reconstructor used to map user-message content through
 * the assistant-side `LanguageModelV3Content` projection, which dropped
 * everything that wasn't text. Image attachments were silently lost on
 * every reload — vision worked on turn 1 (in-memory message hadn't been
 * round-tripped) and broke on turn 2+. The fix: a user-content-aware
 * mapper that preserves MCP `resource_link` blocks alongside text.
 */
describe("event-reconstructor: user-message resource_link round-trip", () => {
  test("preserves resource_link blocks alongside text", () => {
    const events: ConversationEvent[] = [
      {
        ts: "2026-05-07T00:00:00.000Z",
        type: "user.message",
        content: [
          { type: "text", text: "extract this contact" },
          {
            type: "resource_link",
            uri: "files://fl_aaaaaaaaaaaaaaaaaaaaaaaa",
            mimeType: "image/png",
            name: "linkedin.png",
          },
        ],
      },
    ];

    const messages = reconstructMessages(events);
    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    expect(msg.role).toBe("user");
    if (msg.role !== "user") return;
    expect(msg.content).toHaveLength(2);
    expect(msg.content[0]).toEqual({ type: "text", text: "extract this contact" });
    expect(msg.content[1]).toEqual({
      type: "resource_link",
      uri: "files://fl_aaaaaaaaaaaaaaaaaaaaaaaa",
      mimeType: "image/png",
      name: "linkedin.png",
    });
  });

  test("text-only user message reconstructs unchanged", () => {
    const events: ConversationEvent[] = [
      {
        ts: "2026-05-07T00:00:00.000Z",
        type: "user.message",
        content: [{ type: "text", text: "hello" }],
      },
    ];

    const messages = reconstructMessages(events);
    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    if (msg.role !== "user") throw new Error("expected user role");
    expect(msg.content).toEqual([{ type: "text", text: "hello" }]);
  });
});
