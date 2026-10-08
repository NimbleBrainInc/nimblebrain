/**
 * Organization → Users: refusals on create, deactivate and restore, and the
 * per-user editor for display name, email and role.
 *
 * The tool answers a refusal as a result, not a throw. Unchecked, each handler
 * carried on as if it had worked: the create form closed and cleared, and the
 * list re-read with no error shown. The editor saves each field as it changes,
 * and disables what the server refuses.
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
// A text-only result without `isError` is still read as a refusal.
let refusalIsError = true;

type ListedUser = {
  id: string;
  email: string;
  displayName: string;
  orgRole: "admin" | "member";
  deletedAt?: string;
};
const DEFAULT_USERS: ListedUser[] = [
  { id: "usr_me", email: "me@example.com", displayName: "Me", orgRole: "admin" },
  { id: "usr_bo", email: "bo@example.com", displayName: "Bo", orgRole: "member" },
  { id: "usr_al", email: "al@example.com", displayName: "Al", orgRole: "admin" },
  {
    id: "usr_cy",
    email: "cy@example.com",
    displayName: "Cy",
    orgRole: "member",
    deletedAt: "2026-09-01T00:00:00.000Z",
  },
];
let users: ListedUser[] = DEFAULT_USERS;
let providerOwnedFields: string[] = [];
let confirmAnswer = true;
const confirmations: string[] = [];

mock.module("../src/api/client", () => ({
  ...realClient,
  callToolWithoutWorkspace: async (_server: string, _tool: string, args: Record<string, unknown>) => {
    calls.push(args);
    if (args.action === "list") {
      return { structuredContent: { users, providerOwnedFields }, isError: false };
    }
    if (refusal) return { content: [{ type: "text", text: refusal }], isError: refusalIsError };
    return { structuredContent: {}, isError: false };
  },
}));

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter } = await import("react-router-dom");
const { NoticeProvider, NoticeViewport } = await import("../src/components/notices");
const { SessionProvider } = await import("../src/context/SessionContext");
const { UsersTab } = await import("../src/pages/settings/UsersTab");

const win = () => (globalThis as unknown as { window: Window & typeof globalThis }).window;

let unmount: (() => void) | null = null;
afterEach(async () => {
  await act(async () => unmount?.());
  unmount = null;
  calls.length = 0;
  refusal = null;
  refusalIsError = true;
  users = DEFAULT_USERS;
  providerOwnedFields = [];
  confirmAnswer = true;
  confirmations.length = 0;
});

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => await Promise.resolve());
}

async function mount(): Promise<HTMLElement> {
  // Deactivate and a demotion ask through the browser's confirm.
  win().confirm = (message?: string) => {
    confirmations.push(message ?? "");
    return confirmAnswer;
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <SessionProvider
          session={{
            authenticated: true,
            user: {
              id: "usr_me",
              email: "me@example.com",
              displayName: "Me",
              orgRole: "admin",
            },
          }}
        >
          <NoticeProvider>
            <NoticeViewport />
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

async function blur(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new (win().FocusEvent)("focusout", { bubbles: true }));
  });
  await flush();
}

async function choose(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(win().HTMLSelectElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new (win().Event)("change", { bubbles: true }));
  });
  await flush();
}

const field = <T extends Element>(c: HTMLElement, userId: string, name: string) =>
  c.querySelector<T>(`#user-${userId}-${name}`);

const updates = () => calls.filter((x) => x.action === "update");

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
    refusal = "Cannot deactivate the last admin. Make another user an admin first.";
    const c = await mount();
    await click(c.querySelector("button[title='Deactivate Bo']"));

    expect(calls.some((x) => x.action === "delete")).toBe(true);
    expect(c.textContent).toContain("Cannot deactivate the last admin.");
  });

  test("a refusal sent without isError still shows its reason", async () => {
    refusal = "Cannot deactivate the last admin. Make another user an admin first.";
    refusalIsError = false;
    const c = await mount();
    await click(c.querySelector("button[title='Deactivate Bo']"));

    expect(calls.some((x) => x.action === "delete")).toBe(true);
    expect(c.textContent).toContain("Cannot deactivate the last admin.");
  });

  test("a refused restore shows the server's reason", async () => {
    refusal = "You don't have permission to manage users.";
    const c = await mount();
    await click(c.querySelector("button[title='Restore Cy']"));

    expect(calls.some((x) => x.action === "restore")).toBe(true);
    expect(c.textContent).toContain("You don't have permission to manage users.");
  });
});

describe("editing a user", () => {
  test("a name saves on blur as a one-field update, with a notice", async () => {
    const c = await mount();
    await click(c.querySelector("button[title='Edit Bo']"));
    const name = field<HTMLInputElement>(c, "usr_bo", "displayName")!;
    expect(name.value).toBe("Bo");

    await type(name, " Bobby ");
    await blur(name);

    expect(updates()).toEqual([{ action: "update", userId: "usr_bo", displayName: "Bobby" }]);
    expect(document.body.textContent).toContain("Bo's display name updated");
    // The list re-reads after a save.
    expect(calls.filter((x) => x.action === "list").length).toBe(2);
  });

  test("a failed save keeps the edit and shows the server's reason on the field", async () => {
    refusal = "A user with email \"al@example.com\" already exists";
    const c = await mount();
    await click(c.querySelector("button[title='Edit Bo']"));
    const email = field<HTMLInputElement>(c, "usr_bo", "email")!;

    await type(email, "al@example.com");
    await blur(email);

    expect(updates()).toEqual([{ action: "update", userId: "usr_bo", email: "al@example.com" }]);
    expect(c.textContent).toContain("Not saved");
    expect(c.textContent).toContain('A user with email "al@example.com" already exists');
    expect(email.value).toBe("al@example.com");
    expect(document.body.textContent).not.toContain("Bo's email updated");
  });

  test("promoting saves at once without asking", async () => {
    const c = await mount();
    await click(c.querySelector("button[title='Edit Bo']"));

    await choose(field<HTMLSelectElement>(c, "usr_bo", "orgRole")!, "admin");

    expect(confirmations).toEqual([]);
    expect(updates()).toEqual([{ action: "update", userId: "usr_bo", orgRole: "admin" }]);
  });

  test("a change that removes admin rights asks first, and a no sends nothing", async () => {
    confirmAnswer = false;
    const c = await mount();
    await click(c.querySelector("button[title='Edit Al']"));
    const role = field<HTMLSelectElement>(c, "usr_al", "orgRole")!;

    await choose(role, "member");

    expect(confirmations[0]).toContain("Make Al a member?");
    expect(updates()).toEqual([]);
    expect(role.value).toBe("admin");

    confirmAnswer = true;
    await choose(role, "member");
    expect(updates()).toEqual([{ action: "update", userId: "usr_al", orgRole: "member" }]);
  });

  test("your own role is locked, with the server's rule as the reason", async () => {
    users = [
      { id: "usr_me", email: "me@example.com", displayName: "Me", orgRole: "admin" },
      { id: "usr_al", email: "al@example.com", displayName: "Al", orgRole: "admin" },
    ];
    const c = await mount();
    await click(c.querySelector("button[title='Edit Me']"));

    expect(field<HTMLSelectElement>(c, "usr_me", "orgRole")?.disabled).toBe(true);
    expect(c.textContent).toContain("You can't change your own role.");
    // Your own name is still yours to change.
    expect(field<HTMLInputElement>(c, "usr_me", "displayName")?.disabled).toBe(false);
  });

  test("a refused role change shows the server's reason on the field", async () => {
    refusal = "Cannot change the role of the last admin. Make another user an admin first.";
    const c = await mount();
    await click(c.querySelector("button[title='Edit Bo']"));

    await choose(field<HTMLSelectElement>(c, "usr_bo", "orgRole")!, "admin");

    expect(c.textContent).toContain("Not saved");
    expect(c.textContent).toContain("Cannot change the role of the last admin.");
  });

  test("an email the identity provider owns is not editable, and says where to change it", async () => {
    providerOwnedFields = ["email"];
    const c = await mount();
    await click(c.querySelector("button[title='Edit Bo']"));

    expect(field<HTMLInputElement>(c, "usr_bo", "email")?.disabled).toBe(true);
    expect(c.textContent).toContain("Your identity provider signs people in by email");
    expect(field<HTMLInputElement>(c, "usr_bo", "displayName")?.disabled).toBe(false);
  });

  test("a deactivated user has no editor", async () => {
    const c = await mount();
    expect(c.querySelector("button[title='Edit Cy']")).toBeNull();
    expect(c.querySelector("button[title='Restore Cy']")).not.toBeNull();
  });

  test("an edit still being typed is saved when the editor closes", async () => {
    const c = await mount();
    await click(c.querySelector("button[title='Edit Bo']"));
    await type(field<HTMLInputElement>(c, "usr_bo", "displayName")!, "Robert");

    await click(c.querySelector("button[title='Close editor for Bo']"));

    expect(field(c, "usr_bo", "displayName")).toBeNull();
    expect(updates()).toEqual([{ action: "update", userId: "usr_bo", displayName: "Robert" }]);
  });
});
