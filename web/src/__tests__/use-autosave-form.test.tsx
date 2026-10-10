// ---------------------------------------------------------------------------
// useAutosaveForm — fields that save themselves, asserted once against the
// hook rather than per form:
//
//   - a commit sends only that field, and only when it differs from what is saved
//   - saves run one at a time; a field committed again while queued is sent once,
//     with its latest value
//   - a save never overwrites another field's edit
//   - a failed save keeps the draft, marks the field, and can be retried or reverted
//   - Undo on a field's notice puts back the value the save replaced
//   - an edit still pending when the form unmounts is saved then, including one
//     typed while its field's own save was in flight
//   - a failure the field can no longer show (it failed after the form left, or
//     the form left with it failed) is raised as a notice, once
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, test } from "bun:test";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
{
  const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { NoticeProvider, NoticeViewport } = await import("../components/notices");
const { useAutosaveForm } = await import("../hooks/useAutosaveForm");

interface Values {
  name: string;
  limit: string;
}

type Form = ReturnType<typeof useAutosaveForm<Values>>;

interface Pending {
  field: keyof Values;
  value: string;
  resolve(): void;
  reject(err: Error): void;
}

/** Every save the hook made, held open until the test settles it. */
let saves: Pending[] = [];
let form: Form;
let unmount: (() => void) | null = null;

afterEach(async () => {
  await act(async () => unmount?.());
  unmount = null;
  saves = [];
});

type Policy = Parameters<typeof useAutosaveForm<Values>>[1]["notices"];

function Form({ undo, notices }: { undo: boolean; notices?: Policy }) {
  form = useAutosaveForm<Values>(
    { name: "a", limit: "10" },
    {
      save: (field, value) =>
        new Promise<void>((resolve, reject) => {
          saves.push({ field, value, resolve, reject });
        }),
      labels: { name: "Name", limit: "Limit" },
      notices: notices ?? (undo ? { name: { undo: true } } : undefined),
    },
  );
  return null;
}

/** Lets a test take the form off the page while the notices stay, as navigating does. */
let removeForm: () => void = () => {};
function Harness({ undo, notices }: { undo: boolean; notices?: Policy }) {
  const [shown, setShown] = React.useState(true);
  removeForm = () => setShown(false);
  return shown ? React.createElement(Form, { undo, notices }) : null;
}

async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => await Promise.resolve());
}

async function mount(undo = false, notices?: Policy) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        NoticeProvider,
        null,
        React.createElement(NoticeViewport),
        React.createElement(Harness, { undo, notices }),
      ),
    );
  });
  await flush();
  unmount = () => {
    root.unmount();
    container.remove();
  };
}

const status = (field: keyof Values) => form.fieldState(field).status;

describe("useAutosaveForm", () => {
  test("a commit sends only that field, and an unchanged field is not sent", async () => {
    await mount();
    await act(async () => form.commit("name"));
    expect(saves).toHaveLength(0);

    await act(async () => form.set("name", "b"));
    expect(status("name")).toBe("dirty");
    await act(async () => form.commit("name"));
    await flush();
    expect(saves.map((s) => [s.field, s.value])).toEqual([["name", "b"]]);
    expect(status("name")).toBe("saving");

    await act(async () => saves[0]!.resolve());
    await flush();
    expect(status("name")).toBe("saved");
    expect(form.status).toBe("saved");
  });

  test("saves run one at a time, and a field queued twice is sent once with its latest value", async () => {
    await mount();
    await act(async () => form.commit("name", "b"));
    await act(async () => form.commit("limit", "20"));
    await act(async () => form.commit("limit", "30"));
    await flush();
    // The second save has not started while the first is open.
    expect(saves.map((s) => s.field)).toEqual(["name"]);

    await act(async () => saves[0]!.resolve());
    await flush();
    expect(saves.map((s) => [s.field, s.value])).toEqual([
      ["name", "b"],
      ["limit", "30"],
    ]);
  });

  test("a save never overwrites another field's edit", async () => {
    await mount();
    await act(async () => form.commit("name", "b"));
    await act(async () => form.set("limit", "99"));
    await act(async () => saves[0]!.resolve());
    await flush();
    expect(form.values.limit).toBe("99");
    expect(status("limit")).toBe("dirty");
  });

  test("an edit made while its own save is in flight stays unsaved", async () => {
    await mount();
    await act(async () => form.commit("name", "b"));
    await act(async () => form.set("name", "c"));
    await act(async () => saves[0]!.resolve());
    await flush();
    expect(form.values.name).toBe("c");
    expect(status("name")).toBe("dirty");
  });

  test("a failed save keeps the draft, and retry or revert recovers", async () => {
    await mount();
    await act(async () => form.commit("limit", "0"));
    await act(async () => saves[0]!.reject(new Error("limit must be positive")));
    await flush();
    expect(form.values.limit).toBe("0");
    expect(form.fieldState("limit")).toMatchObject({
      status: "error",
      error: "limit must be positive",
    });
    expect(form.status).toBe("error");
    // The form is still on the page, and this field reports on the field only.
    expect(document.body.querySelectorAll("[data-testid='notice']")).toHaveLength(0);

    await act(async () => form.fieldState("limit").onRetry());
    await flush();
    expect(saves).toHaveLength(2);
    await act(async () => saves[1]!.reject(new Error("still no")));
    await flush();

    await act(async () => form.fieldState("limit").onRevert());
    expect(form.values.limit).toBe("10");
    expect(form.fieldState("limit")).toMatchObject({ status: "clean", error: null });
  });

  test("Undo on the notice puts back the value the save replaced", async () => {
    await mount(true);
    await act(async () => form.commit("name", "b"));
    await act(async () => saves[0]!.resolve());
    await flush();

    const notice = document.body.querySelector("[data-testid='notice']");
    expect(notice?.textContent).toContain("Name updated");
    const undo = Array.from(notice?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "Undo",
    );
    await act(async () => undo?.click());
    await flush();
    expect(saves.map((s) => [s.field, s.value])).toEqual([
      ["name", "b"],
      ["name", "a"],
    ]);

    // The undo itself raises no notice: one would offer Undo of the Undo.
    await act(async () => saves[1]!.resolve());
    await flush();
    expect(document.body.querySelectorAll("[data-testid='notice']")).toHaveLength(0);
    expect(status("name")).toBe("saved");
  });

  // Following a link blurs the field, which starts its save, and then
  // unmounts the form. A refusal after that has no field to show on, so it
  // reaches the reader as a notice whatever the form's policy.
  test("a save that fails after the form unmounts raises an error notice", async () => {
    await mount();
    await act(async () => form.commit("limit", "0"));
    await act(async () => removeForm());
    await act(async () => saves[0]!.reject(new Error("limit must be positive")));
    await flush();
    const notice = document.body.querySelector("[data-testid='notice']");
    expect(notice?.textContent).toContain("Couldn't save Limit");
    expect(notice?.textContent).toContain("limit must be positive");
  });

  // Back, a keyboard shortcut, or a route change that keeps focus unmounts the
  // form without blurring the field, so the edit is committed on the way out.
  test("an edit not yet committed is saved when the form unmounts", async () => {
    await mount();
    await act(async () => form.set("name", "b"));
    expect(status("name")).toBe("dirty");
    expect(saves).toHaveLength(0);
    await act(async () => removeForm());
    await flush();
    expect(saves.map((s) => [s.field, s.value])).toEqual([["name", "b"]]);
  });

  test("a clean field is not sent when the form unmounts, beside a dirty one that is", async () => {
    await mount();
    // Edited and put back: the draft matches what is saved.
    await act(async () => form.set("name", "b"));
    await act(async () => form.set("name", "a"));
    expect(status("name")).toBe("clean");
    await act(async () => form.set("limit", "20"));
    await act(async () => removeForm());
    await flush();
    expect(saves.map((s) => [s.field, s.value])).toEqual([["limit", "20"]]);
  });

  test("an uncommitted edit refused after the form unmounts raises an error notice", async () => {
    await mount();
    await act(async () => form.set("limit", "0"));
    await act(async () => removeForm());
    await flush();
    expect(saves.map((s) => [s.field, s.value])).toEqual([["limit", "0"]]);
    await act(async () => saves[0]!.reject(new Error("limit must be positive")));
    await flush();
    const notice = document.body.querySelector("[data-testid='notice']");
    expect(notice?.textContent).toContain("Couldn't save Limit");
    expect(notice?.textContent).toContain("limit must be positive");
  });

  // An edit typed while the field's own save is in flight leaves the field
  // "saving", not "dirty", so the unmount commit skips it; the save landing
  // after the form is gone has to send the newer text itself.
  test("an edit made during the field's own save is saved when the form has left the page", async () => {
    await mount();
    await act(async () => form.commit("name", "b"));
    await act(async () => form.set("name", "bc"));
    await act(async () => removeForm());
    await act(async () => saves[0]!.resolve());
    await flush();
    expect(saves.map((s) => [s.field, s.value])).toEqual([
      ["name", "b"],
      ["name", "bc"],
    ]);
  });

  // A save refused while the form is on the page shows on the field. Leaving
  // removes the field, so the refusal must reach the reader as a notice, or
  // the edit is gone with nothing to say so.
  test("a field whose save failed before the form left raises an error notice on leaving", async () => {
    await mount();
    await act(async () => form.commit("limit", "0"));
    await act(async () => saves[0]!.reject(new Error("limit must be positive")));
    await flush();
    expect(status("limit")).toBe("error");
    expect(document.body.querySelector("[data-testid='notice']")).toBeNull();

    await act(async () => removeForm());
    await flush();
    const notices = Array.from(document.body.querySelectorAll("[data-testid='notice']"));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.textContent).toContain("Couldn't save Limit");
    expect(notices[0]?.textContent).toContain("limit must be positive");
  });

  // A form whose policy already raised the failure as a notice has said it;
  // leaving does not say it twice.
  test("a failure already raised as a notice is not raised again on leaving", async () => {
    await mount(false, { limit: { error: "notice" } });
    await act(async () => form.commit("limit", "0"));
    await act(async () => saves[0]!.reject(new Error("limit must be positive")));
    await flush();
    expect(document.body.querySelectorAll("[data-testid='notice']")).toHaveLength(1);
    await act(async () => removeForm());
    await flush();
    expect(document.body.querySelectorAll("[data-testid='notice']")).toHaveLength(1);
  });

  // A failed field reverted, or retried into a save, no longer holds a lost edit.
  test("a failed field reverted before leaving raises nothing", async () => {
    await mount();
    await act(async () => form.commit("limit", "0"));
    await act(async () => saves[0]!.reject(new Error("limit must be positive")));
    await flush();
    await act(async () => form.revert("limit"));
    await act(async () => removeForm());
    await flush();
    expect(document.body.querySelector("[data-testid='notice']")).toBeNull();
  });
});
