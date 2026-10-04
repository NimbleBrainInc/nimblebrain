/**
 * Organization → Workspaces → one workspace: removing a member.
 *
 * Removal asks in the shared dialog, closes it once the member is removed (the
 * dialog leaves closing to its caller), and keeps it open with the server's
 * reason when the removal is refused.
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

const WS_ID = "ws_00000000000000aa";
const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
let refusal: string | null = null;

mock.module("../src/api/client", () => ({
  ...realClient,
  callToolWithoutWorkspace: async (_server: string, tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    if (tool === "manage_users") {
      return {
        structuredContent: {
          users: [
            { id: "usr_me", email: "me@example.com", displayName: "Me" },
            { id: "usr_bo", email: "bo@example.com", displayName: "Bo" },
          ],
        },
        isError: false,
      };
    }
    if (args.action === "list") {
      return {
        structuredContent: {
          workspaces: [{ id: WS_ID, name: "Acme", memberCount: 2, connectors: [] }],
        },
        isError: false,
      };
    }
    if (args.action === "list_members") {
      return {
        structuredContent: {
          workspaceId: WS_ID,
          members: [
            { userId: "usr_me", role: "admin" },
            { userId: "usr_bo", role: "member" },
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
const { MemoryRouter, Route, Routes } = await import("react-router-dom");
const { NoticeProvider, NoticeViewport } = await import("../src/components/notices");
const { SessionProvider } = await import("../src/context/SessionContext");
const { WorkspaceDetailPage } = await import("../src/pages/settings/WorkspaceDetailPage");

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
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/org/workspaces/00000000000000aa"]}>
        <SessionProvider
          session={{
            authenticated: true,
            user: { id: "usr_me", email: "me@example.com", displayName: "Me", orgRole: "admin" },
          }}
        >
          <NoticeProvider>
            <NoticeViewport />
            <Routes>
              <Route path="/org/workspaces/:slug" element={<WorkspaceDetailPage />} />
            </Routes>
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

const buttonByText = (text: string) =>
  Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);

describe("removing a member on the org workspace page", () => {
  test("asks first, removes, then closes the dialog", async () => {
    const c = await mount();
    await click(c.querySelector("button[aria-label='Remove Bo']"));

    expect(document.body.textContent).toContain("Remove Bo?");
    expect(calls.some((x) => x.args.action === "remove_member")).toBe(false);

    await click(buttonByText("Remove"));
    expect(calls.find((x) => x.args.action === "remove_member")?.args).toEqual({
      action: "remove_member",
      workspaceId: WS_ID,
      userId: "usr_bo",
    });
    expect(document.body.textContent).toContain("Bo was removed from Acme");
    // Closed once the removal lands, rather than holding on "Removing…".
    expect(document.body.textContent).not.toContain("Remove Bo?");
    expect(document.body.textContent).not.toContain("Removing…");
  });

  test("a refused removal stays in the dialog with the server's reason", async () => {
    refusal = "Cannot remove the last active admin of this workspace.";
    const c = await mount();
    await click(c.querySelector("button[aria-label='Remove Bo']"));
    await click(buttonByText("Remove"));

    const text = document.body.textContent ?? "";
    expect(text).toContain("Cannot remove the last active admin");
    expect(text).toContain("Remove Bo?");
    expect(text).not.toContain("Bo was removed");
  });

  test("the last admin cannot be removed", async () => {
    const c = await mount();
    const me = c.querySelector<HTMLButtonElement>("button[aria-label='Remove Me']")!;
    expect(me.getAttribute("aria-disabled")).toBe("true");
    await click(me);
    expect(document.body.textContent).not.toContain("Remove Me?");
  });
});
