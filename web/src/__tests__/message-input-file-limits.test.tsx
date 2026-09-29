// ---------------------------------------------------------------------------
// MessageInput — attachment limits are stated before a send, not after.
//
// The attach button names the limits; a set past them shows why and cannot be
// sent, so nothing uploads only to be refused.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom's Window stub doesn't expose SyntaxError/TypeError, which its own
// error paths construct.
{
  const win = (globalThis as unknown as { window?: Record<string, unknown> }).window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MessageInput } = await import("../components/MessageInput");

const LIMITS = {
  maxFileSize: 25 * 1_048_576,
  maxTotalSize: 100 * 1_048_576,
  maxFilesPerMessage: 2,
};

let container: HTMLDivElement;
let root: ReturnType<typeof ReactDOMClient.createRoot>;
const onSend = mock((_text: string, _files?: File[]) => {});

beforeEach(async () => {
  onSend.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(MessageInput, {
        onSend,
        conversationKey: `limits-${Math.random()}`,
        busy: false,
        fileLimits: LIMITS,
      }),
    );
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function attach(count: number): Promise<void> {
  const input = [...container.getElementsByTagName("input")].find(
    (el) => el.type === "file",
  ) as HTMLInputElement;
  const files = Array.from({ length: count }, (_, i) => new File(["x"], `f${i}.txt`));
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => {
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}

function button(label: string): HTMLButtonElement {
  return [...container.getElementsByTagName("button")].find((el) =>
    el.getAttribute("aria-label")?.startsWith(label),
  ) as HTMLButtonElement;
}

function sendButton(): HTMLButtonElement {
  return button("Send message");
}

function alertText(): string | null {
  const el = [...container.getElementsByTagName("p")].find(
    (p) => p.getAttribute("role") === "alert",
  );
  return el?.textContent ?? null;
}

describe("MessageInput attachment limits", () => {
  test("the attach button states the limits", () => {
    expect(button("Attach files").title).toBe("Attach files (up to 2, 25.0 MB each)");
  });

  test("a set past the per-message count says so and cannot be sent", async () => {
    await attach(3);
    expect(alertText()).toBe("Up to 2 files per message. Remove 1 to send.");
    expect(sendButton().disabled).toBe(true);

    // Enter is the other way to send; it is held by the same limit.
    const textarea = container.getElementsByTagName("textarea")[0] as HTMLTextAreaElement;
    await act(async () => {
      textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  test("a set within the limits can be sent", async () => {
    await attach(2);
    expect(alertText()).toBeNull();
    expect(sendButton().disabled).toBe(false);

    const textarea = container.getElementsByTagName("textarea")[0] as HTMLTextAreaElement;
    await act(async () => {
      textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});
