import { describe, expect, test } from "bun:test";
import { reconstructMessages } from "../../../src/conversation/event-reconstructor.ts";
import type { ConversationEvent } from "../../../src/conversation/types.ts";

/**
 * The reconstructor maps user-message content through a user-content-aware
 * mapper that preserves MCP `resource_link` blocks alongside text. The
 * assistant-side `LanguageModelV4Content` projection drops everything that
 * isn't text, so through it image attachments would be silently lost on
 * every reload — vision would work on turn 1 (the in-memory message is not
 * round-tripped) and break on turn 2+.
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
