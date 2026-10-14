// ---------------------------------------------------------------------------
// MessageList — a message's view state stays with its conversation.
//
// Messages carry no id, so they are keyed by position. Opening another
// conversation whose messages are already loaded swaps the list in one render;
// keyed by position alone, the message at index 1 of the new conversation
// would take over the component of index 1 in the old one, with its local
// state (an expanded activity chip). Keys carry the conversation as well.
//
// DOM is walked via getElementsByTagName, as in BlockTimeline's test.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../hooks/chat-store";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MessageList } = await import("../components/MessageList");

function conversation(startedAt: string): ChatMessage[] {
  return [
    { role: "user", content: "find it", timestamp: startedAt },
    {
      role: "assistant",
      content: "",
      timestamp: startedAt,
      blocks: [
        {
          type: "tool",
          toolCalls: [
            {
              id: `call-${startedAt}`,
              name: "nb__search",
              status: "done",
              input: { query: "it" },
              result: { content: [{ type: "text", text: "results" }], isError: false },
              ms: 12,
            },
          ],
        },
        { type: "text", text: "Found it." },
      ],
    },
  ];
}

function expandedToggles(root: Element): HTMLButtonElement[] {
  return Array.from(root.getElementsByTagName("button")).filter(
    (b) => b.getAttribute("aria-expanded") === "true",
  );
}

function collapsedToggles(root: Element): HTMLButtonElement[] {
  return Array.from(root.getElementsByTagName("button")).filter(
    (b) => b.getAttribute("aria-expanded") === "false",
  );
}

describe("MessageList — keys carry the conversation", () => {
  test("an activity chip expanded in one conversation is collapsed in the next", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = ReactDOMClient.createRoot(container);
    const render = (messages: ChatMessage[]) =>
      act(async () => {
        root.render(
          React.createElement(MessageList, {
            messages,
            isStreaming: false,
            streamingState: null,
            preparingTool: null,
            displayDetail: "balanced",
          }),
        );
      });

    await render(conversation("2026-01-01T00:00:00.000Z"));
    const [chip] = collapsedToggles(container);
    expect(chip).toBeDefined();
    await act(async () => chip?.click());
    expect(expandedToggles(container).length).toBe(1);

    await render(conversation("2026-02-01T00:00:00.000Z"));
    expect(expandedToggles(container).length).toBe(0);

    await act(async () => root.unmount());
    container.remove();
  });
});
