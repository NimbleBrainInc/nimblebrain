/**
 * Renaming a workspace (General) and managing its members (Members).
 *
 * The gates mirror the server's: a workspace admin member or an org admin may
 * rename and manage members; any member reads the roster. Every call names the
 * workspace it was made in, and the roster comes from `list_members` alone, so a
 * member who cannot list the organization's users still sees it.
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

interface Call {
  tool: string;
  args: Record<string, unknown>;
  opts: unknown;
}
const calls: Call[] = [];
let bootstraps = 0;
let refusal: string | null = null;

const ROSTER = [
  { userId: "usr_me", role: "admin", displayName: "Me", email: "me@example.com" },
  { userId: "usr_bo", role: "member", displayName: "Bo", email: "bo@example.com" },
];

mock.module("../src/api/client", () => ({
  ...realClient,
  tryBootstrap: async () => {
    bootstraps++;
    return null;
  },
  callTool: async (
    _server: string,
    tool: string,
    args: Record<string, unknown>,
    opts?: { workspaceId?: string },
  ) => {
    calls.push({ tool, args, opts });
    if (refusal && args.action !== "list_members") {
      return { content: [{ type: "text", text: refusal }], isError: true };
    }
    if (args.action === "list_members") {
      return { structuredContent: { workspaceId: "ws_a", members: ROSTER }, isError: false };
    }
    if (args.action === "add_member") {
      return { structuredContent: { added: { userId: "usr_cy", role: args.role } }, isError: false };
    }
    return { structuredContent: { workspace: { id: "ws_a" } }, isError: false };
  },
}));

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter } = await import("react-router-dom");
const { NoticeProvider, NoticeViewport } = await import("../src/components/notices");
const { SessionProvider } = await import("../src/context/SessionContext");
const { WorkspaceProvider } = await import("../src/context/WorkspaceContext");
type WorkspaceInfo = import("../src/context/WorkspaceContext").WorkspaceInfo;
const { WorkspaceGeneralTab } = await import("../src/pages/settings/WorkspaceGeneralTab");
const { WorkspaceMembersTab } = await import("../src/pages/settings/WorkspaceMembersTab");

type WsRole = "admin" | "member";

let unmount: (() => void) | null = null;
afterEach(async () => {
  await act(async () => unmount?.());
  unmount = null;
  calls.length = 0;
  bootstraps = 0;
  refusal = null;
});

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => await Promise.resolve());
}

async function mount(
  page: "general" | "members",
  { wsRole, orgRole = "member" }: { wsRole: WsRole; orgRole?: string },
): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  const workspaces: WorkspaceInfo[] = [
    { id: "ws_a", name: "Acme", memberCount: 2, connectorCount: 0, userRole: wsRole },
  ];
  const Page = page === "general" ? WorkspaceGeneralTab : WorkspaceMembersTab;
  await act(async () => {
    root.render(
      <MemoryRouter>
        <SessionProvider
          session={{
            authenticated: true,
            user: { id: "usr_me", email: "me@example.com", displayName: "Me", orgRole },
          }}
        >
          <WorkspaceProvider initialWorkspaces={workspaces} initialActiveId="ws_a">
            <NoticeProvider>
              <NoticeViewport />
              <Page />
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

const win = () => (globalThis as unknown as { window: Window & typeof globalThis }).window;

async function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(win().HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new (win().Event)("input", { bubbles: true }));
  });
}

async function choose(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(win().HTMLSelectElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new (win().Event)("change", { bubbles: true }));
  });
  await flush();
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush();
}

function button(root: ParentNode, text: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);
}

const nameInput = (c: HTMLElement) => c.querySelector<HTMLInputElement>("#workspace-name-ws_a")!;

describe("renaming a workspace on General", () => {
  test("a workspace admin renames on Enter; the save names the workspace and re-reads the list", async () => {
    const c = await mount("general", { wsRole: "admin" });
    expect(nameInput(c).value).toBe("Acme");

    await type(nameInput(c), "  Acme Sales ");
    await act(async () => {
      nameInput(c).dispatchEvent(
        new (win().KeyboardEvent)("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await flush();

    const rename = calls.find((x) => x.args.action === "update");
    expect(rename?.args).toEqual({ action: "update", workspaceId: "ws_a", name: "Acme Sales" });
    expect(rename?.opts).toEqual({ workspaceId: "ws_a" });
    expect(bootstraps).toBe(1);
  });

  test("an org admin who is a plain member may rename; a plain member may not", async () => {
    const asOrgAdmin = await mount("general", { wsRole: "member", orgRole: "admin" });
    expect(nameInput(asOrgAdmin).disabled).toBe(false);
    await act(async () => unmount?.());

    const asMember = await mount("general", { wsRole: "member" });
    expect(nameInput(asMember).disabled).toBe(true);
    expect(asMember.textContent).toContain("Only workspace admins can rename this workspace.");
  });

  test("a refused rename shows on the field and is not reported as saved", async () => {
    refusal = "You don't have permission to rename this workspace.";
    const c = await mount("general", { wsRole: "admin" });

    await type(nameInput(c), "Taken");
    await act(async () => {
      nameInput(c).dispatchEvent(new (win().FocusEvent)("focusout", { bubbles: true }));
    });
    await flush();

    expect(c.textContent).toContain("Not saved");
    expect(c.textContent).toContain("permission to rename");
    expect(bootstraps).toBe(0);
  });
});

describe("the Members tab", () => {
  test("a plain member sees the roster from list_members alone, with no controls", async () => {
    const c = await mount("members", { wsRole: "member" });

    expect(calls.map((x) => x.args.action)).toEqual(["list_members"]);
    expect(calls[0]?.opts).toEqual({ workspaceId: "ws_a" });
    expect(c.textContent).toContain("Bo");
    expect(c.textContent).toContain("bo@example.com");
    expect(button(document.body, "Add member")).toBeUndefined();
    expect(c.querySelector("select")).toBeNull();
  });

  test("an admin adds someone by email, with the role they chose", async () => {
    const c = await mount("members", { wsRole: "admin" });
    await click(button(c, "Add member")!);

    await type(c.querySelector<HTMLInputElement>("#add-member-email")!, " cy@example.com ");
    await choose(c.querySelector<HTMLSelectElement>("#add-member-role")!, "admin");
    await click(button(c, "Add")!);

    const add = calls.find((x) => x.args.action === "add_member");
    expect(add?.args).toEqual({
      action: "add_member",
      workspaceId: "ws_a",
      email: "cy@example.com",
      role: "admin",
    });
    expect(document.body.textContent).toContain("cy@example.com was added to Acme");
  });

  test("a refused add stays in the form with the server's reason", async () => {
    refusal = "No one in this organization has the email cy@example.com.";
    const c = await mount("members", { wsRole: "admin" });
    await click(button(c, "Add member")!);
    await type(c.querySelector<HTMLInputElement>("#add-member-email")!, "cy@example.com");
    await click(button(c, "Add")!);

    expect(c.textContent).toContain("No one in this organization has the email");
    expect(c.querySelector("#add-member-email")).not.toBeNull();
  });

  test("a role change saves at once and offers Undo, which changes it back", async () => {
    const c = await mount("members", { wsRole: "admin" });
    const boRole = c.querySelector<HTMLSelectElement>('select[aria-label="Role for Bo"]')!;

    await choose(boRole, "admin");
    const update = calls.find((x) => x.args.action === "update_member");
    expect(update?.args).toEqual({
      action: "update_member",
      workspaceId: "ws_a",
      userId: "usr_bo",
      role: "admin",
    });
    expect(document.body.textContent).toContain("Bo is now an admin");

    await click(button(document.body, "Undo")!);
    const updates = calls.filter((x) => x.args.action === "update_member");
    expect(updates.at(-1)?.args.role).toBe("member");
  });

  test("the last admin's role and removal are locked", async () => {
    const c = await mount("members", { wsRole: "admin" });
    const meRole = c.querySelector<HTMLSelectElement>('select[aria-label="Role for Me"]')!;
    expect(meRole.disabled).toBe(true);

    const removeMe = c.querySelector<HTMLButtonElement>('button[aria-label="Remove Me"]')!;
    expect(removeMe.getAttribute("aria-disabled")).toBe("true");
    await click(removeMe);
    expect(calls.some((x) => x.args.action === "remove_member")).toBe(false);
  });

  test("removing someone asks first, then removes them", async () => {
    const c = await mount("members", { wsRole: "admin" });
    await click(c.querySelector('button[aria-label="Remove Bo"]')!);

    expect(document.body.textContent).toContain("Remove Bo?");
    expect(calls.some((x) => x.args.action === "remove_member")).toBe(false);

    await click(button(document.body, "Remove")!);
    const removed = calls.find((x) => x.args.action === "remove_member");
    expect(removed?.args).toEqual({
      action: "remove_member",
      workspaceId: "ws_a",
      userId: "usr_bo",
    });
    expect(document.body.textContent).toContain("Bo was removed from Acme");
    // The dialog closes once the removal lands, rather than holding on "Removing…".
    expect(document.body.textContent).not.toContain("Remove Bo?");
    expect(document.body.textContent).not.toContain("Removing…");
  });
});
