/**
 * Organization → Workspaces.
 *
 * A row opens from the keyboard (its name is a link), and deleting a workspace
 * asks in the shared dialog, says what it keeps and what it cannot undo, and
 * reports a refusal instead of treating it as done.
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
  tryBootstrap: async () => null,
  callToolWithoutWorkspace: async (_server: string, _tool: string, args: Record<string, unknown>) => {
    calls.push(args);
    if (args.action === "list") {
      return {
        structuredContent: {
          workspaces: [
            { id: "ws_00000000000000aa", name: "Acme", memberCount: 3, connectors: [] },
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
const { NoticeProvider, NoticeViewport } = await import("../src/components/notices");
const { SessionProvider } = await import("../src/context/SessionContext");
const { WorkspaceProvider } = await import("../src/context/WorkspaceContext");
const { WorkspacesTab } = await import("../src/pages/settings/WorkspacesTab");

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
      <MemoryRouter>
        <SessionProvider
          session={{
            authenticated: true,
            user: { id: "usr_me", email: "me@example.com", displayName: "Me", orgRole: "admin" },
          }}
        >
          <WorkspaceProvider initialWorkspaces={[]}>
            <NoticeProvider>
              <NoticeViewport />
              <WorkspacesTab />
            </NoticeProvider>
          </WorkspaceProvider>
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

describe("the workspace list", () => {
  test("names each workspace with a link to its page, so a row opens from the keyboard", async () => {
    const c = await mount();
    const link = Array.from(c.querySelectorAll("a")).find((a) => a.textContent === "Acme");
    expect(link?.getAttribute("href")).toBe("/org/workspaces/00000000000000aa");
  });

  test("delete asks first, saying what is kept and what can't be undone", async () => {
    const c = await mount();
    await click(c.querySelector("button[aria-label='Delete Acme']"));

    const text = document.body.textContent ?? "";
    expect(text).toContain("Delete Acme?");
    expect(text).toContain("connectors are disconnected");
    expect(text).toContain("Organization → Archives");
    expect(calls.some((x) => x.action === "delete")).toBe(false);

    await click(buttonByText("Delete workspace"));
    expect(calls.find((x) => x.action === "delete")).toEqual({
      action: "delete",
      workspaceId: "ws_00000000000000aa",
    });
    expect(document.body.textContent).toContain("Acme was deleted");
  });

  test("a refused delete stays in the dialog with the server's reason", async () => {
    refusal = "You don't have permission to manage workspaces. Ask an org admin.";
    const c = await mount();
    await click(c.querySelector("button[aria-label='Delete Acme']"));
    await click(buttonByText("Delete workspace"));

    const text = document.body.textContent ?? "";
    expect(text).toContain("You don't have permission to manage workspaces");
    expect(text).toContain("Delete Acme?");
    expect(text).not.toContain("Acme was deleted");
  });
});
