import { describe, expect, it, mock } from "bun:test";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { MessageList } from "../src/components/MessageList.tsx";
import type { ChatMessage } from "../src/hooks/useChat.ts";

// happy-dom's Window stub doesn't expose SyntaxError/TypeError; querySelector's
// selector parser constructs one and trips on the gap. Same patch the
// SkillsBrowser suite uses.
{
  const win = (globalThis as unknown as { window?: Record<string, unknown> }).window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

/**
 * useSmartScroll drives the jump-to-bottom chevron. happy-dom computes no
 * layout, so getBoundingClientRect returns zeros — we override it on the
 * scroll container and the last message to drive the geometry ourselves and
 * lock in two behaviors:
 *   1. the chevron shows only when the newest message sits below the fold;
 *   2. jumping targets the newest message (block:"end"), not the trailing
 *      60vh spacer (which was the pre-fix bug — you landed in blank space).
 */

const messages: ChatMessage[] = [
  { role: "user", content: "hi" },
  { role: "assistant", content: "a long reply that runs off the bottom" },
];

function rect(bottom: number): DOMRect {
  return {
    top: 0,
    bottom,
    left: 0,
    right: 0,
    width: 0,
    height: bottom,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function parts(container: HTMLElement) {
  const scrollEl = container.querySelector(".overflow-y-auto") as HTMLElement;
  const inner = scrollEl.firstElementChild as HTMLElement;
  // DOM order is [...messages, spacer]; the last message is at length - 1.
  const lastMsg = inner.children[messages.length - 1] as HTMLElement;
  return { scrollEl, lastMsg };
}

const jumpBtn = (c: HTMLElement) => c.querySelector('button[aria-label="Jump to bottom"]');

function renderList() {
  return render(
    <MessageList
      messages={messages}
      isStreaming={false}
      streamingState="idle"
      displayDetail="balanced"
    />,
  );
}

describe("MessageList jump-to-bottom (useSmartScroll)", () => {
  it("shows the chevron below the fold and hides it at the bottom", async () => {
    const { container } = renderList();
    const { scrollEl, lastMsg } = parts(container);

    // Viewport bottom at 500; newest message's bottom at 900 → below the fold.
    scrollEl.getBoundingClientRect = () => rect(500);
    lastMsg.getBoundingClientRect = () => rect(900);
    await act(async () => {
      fireEvent.scroll(scrollEl);
    });
    await waitFor(() => expect(jumpBtn(container)).not.toBeNull());

    // Now the newest message ends at/above the viewport bottom → at the bottom.
    lastMsg.getBoundingClientRect = () => rect(480);
    await act(async () => {
      fireEvent.scroll(scrollEl);
    });
    await waitFor(() => expect(jumpBtn(container)).toBeNull());
  });

  it("jumps to the newest message with block:'end', not the spacer", async () => {
    const { container } = renderList();
    const { scrollEl, lastMsg } = parts(container);

    const scrollSpy = mock((_opts?: ScrollIntoViewOptions) => {});
    lastMsg.scrollIntoView = scrollSpy as unknown as HTMLElement["scrollIntoView"];

    scrollEl.getBoundingClientRect = () => rect(500);
    lastMsg.getBoundingClientRect = () => rect(900);
    await act(async () => {
      fireEvent.scroll(scrollEl);
    });
    const btn = jumpBtn(container) as HTMLButtonElement;
    expect(btn).not.toBeNull();

    // Ignore any scroll the load path fired on mount; assert the click's target.
    scrollSpy.mockClear();
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(scrollSpy).toHaveBeenCalled();
    expect(scrollSpy.mock.calls.at(-1)?.[0]).toMatchObject({ block: "end" });
  });
});
