/**
 * Organization → Users reports a refused create, deactivate or restore.
 *
 * The tool answers a refusal as a result, not a throw. Unchecked, each handler
 * carried on as if it had worked: the create form closed and cleared, and the
 * list re-read with no error shown.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "./setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
{
  const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

const calls: Array<Record<string, unknown>> = [];
let refusal: string | null = null;

mock.module("../src/api/client", () => ({
  ...realClient,
  callToolWithoutWorkspace: async (_server: string, _tool: string, args: Record<string, unknown>) => {
    calls.push(args);
    if (args.action === "list") {
      return {
        structuredContent: {
          users: [
            { id: "usr_me", email: "me@example.com", displayName: "Me", orgRole: "owner" },
            { id: "usr_bo", email: "bo@example.com", displayName: "Bo", orgRole: "member" },
            {
              id: "usr_cy",
              email: "cy@example.com",
              displayName: "Cy",
              orgRole: "member",
              deletedAt: "2026-09-01T00:00:00.000Z",
            },
          ],
        },
        isError: false,
      };
    }
    if (refusal) return { content: [{ type: "text", text: refusal }], isError: true };
    return { structuredContent: {}, isError: false };
  },
}));

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter } = await import("react-router-dom");
const { NoticeProvider } = await import("../src/components/notices");
const { SessionProvider } = await import("../src/context/SessionContext");
const { UsersTab } = await import("../src/pages/settings/UsersTab");

const win = () => (globalThis as unknown as { window: Window & typeof globalThis }).window;

let unmount: (() => void) | null = null;
afterEach(async () => {
  await act(async () => unmount?.());
  unmount = null;
  calls.length = 0;
  refusal = null;
});

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => await Promise.resolve());
}

async function mount(): Promise<HTMLElement> {
  // Deactivate asks through the browser's confirm; answer yes.
  win().confirm = () => true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <SessionProvider
          session={{
            authenticated: true,
            user: { id: "usr_me", email: "me@example.com", displayName: "Me", orgRole: "owner" },
          }}
        >
          <NoticeProvider>
            <UsersTab />
          </NoticeProvider>
        </SessionProvider>
      </MemoryRouter>,
    );
  });
  await flush();
  unmount = () => {
    root.unmount();
    container.remove();
  };
  return container;
}

async function click(el: Element | null | undefined) {
  if (!el) throw new Error("nothing to click");
  await act(async () => (el as HTMLElement).click());
  await flush();
}

async function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(win().HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new (win().Event)("input", { bubbles: true }));
  });
}

const buttonByText = (c: HTMLElement, text: string) =>
  Array.from(c.querySelectorAll("button")).filter((b) => b.textContent?.trim() === text);

describe("a refusal on the Users tab", () => {
  test("a refused create keeps the form open, with what was typed and the server's reason", async () => {
    refusal = "A user with that email already exists.";
    const c = await mount();
    await click(buttonByText(c, "Create user")[0]);
    await type(c.querySelector<HTMLInputElement>("#create-email")!, "dee@example.com");
    await type(c.querySelector<HTMLInputElement>("#create-name")!, "Dee");
    // The form's submit button shares the toggle's label; it is the last one.
    await click(buttonByText(c, "Create user").at(-1));

    expect(calls.some((x) => x.action === "create")).toBe(true);
    expect(c.textContent).toContain("A user with that email already exists.");
    expect(c.querySelector<HTMLInputElement>("#create-email")?.value).toBe("dee@example.com");
  });

  test("a refused deactivate shows the server's reason", async () => {
    refusal = "The last owner can't be deactivated.";
    const c = await mount();
    await click(c.querySelector("button[title='Deactivate Bo']"));

    expect(calls.some((x) => x.action === "delete")).toBe(true);
    expect(c.textContent).toContain("The last owner can't be deactivated.");
  });

  test("a refused restore shows the server's reason", async () => {
    refusal = "You don't have permission to manage users.";
    const c = await mount();
    await click(c.querySelector("button[title='Restore Cy']"));

    expect(calls.some((x) => x.action === "restore")).toBe(true);
    expect(c.textContent).toContain("You don't have permission to manage users.");
  });
});
