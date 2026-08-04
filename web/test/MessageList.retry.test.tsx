import { render } from "@testing-library/react";
import { describe, expect, it } from "bun:test";
import { MessageList } from "../src/components/MessageList.tsx";
import type { ChatMessage } from "../src/hooks/useChat.ts";

/**
 * The "Try again" control must track whether a retry can actually replay, not
 * merely whether a message carries an error. A turn settled from disk has no
 * captured send params, so the store reports `canRetry: false` and the panel
 * passes no `onRetry` — a button rendered there would silently do nothing.
 *
 * This locks the component half of that contract (`ChatSnapshot.canRetry` is
 * covered in chat-store.test.ts). Note it does not exercise the ternaries in
 * Chat.tsx / ChatChrome.tsx that connect the two.
 */

const erroredMsg: ChatMessage = {
  role: "assistant",
  content: "",
  error: "This response was interrupted and never finished.",
};

function retryButton(container: HTMLElement): HTMLButtonElement | null {
  for (const b of Array.from(container.getElementsByTagName("button"))) {
    if (b.textContent?.includes("Try again")) return b as HTMLButtonElement;
  }
  return null;
}

describe("MessageList retry affordance", () => {
  it("omits the retry button when no onRetry is supplied", () => {
    const { container } = render(
      <MessageList
        messages={[erroredMsg]}
        isStreaming={false}
        streamingState="idle"
        displayDetail="balanced"
      />,
    );
    // The written explanation is the headline, not a collapsed detail, and the
    // generic "you can try again" copy is gone along with the button.
    expect(container.textContent).toContain(
      "This response was interrupted and never finished.",
    );
    expect(container.textContent).not.toContain("You can try again");
    expect(container.getElementsByTagName("details")).toHaveLength(0);
    expect(retryButton(container)).toBeNull();
  });

  it("renders the retry button when onRetry is supplied", () => {
    const { container } = render(
      <MessageList
        messages={[erroredMsg]}
        isStreaming={false}
        streamingState="idle"
        displayDetail="balanced"
        onRetry={() => {}}
      />,
    );
    expect(retryButton(container)).not.toBeNull();
  });
});
