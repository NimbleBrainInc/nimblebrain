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

function Form({ undo }: { undo: boolean }) {
  form = useAutosaveForm<Values>(
    { name: "a", limit: "10" },
    {
      save: (field, value) =>
        new Promise<void>((resolve, reject) => {
          saves.push({ field, value, resolve, reject });
        }),
      labels: { name: "Name", limit: "Limit" },
      notices: undo ? { name: { undo: true } } : undefined,
    },
  );
  return null;
}

/** Lets a test take the form off the page while the notices stay, as navigating does. */
let removeForm: () => void = () => {};
function Harness({ undo }: { undo: boolean }) {
  const [shown, setShown] = React.useState(true);
  removeForm = () => setShown(false);
  return shown ? React.createElement(Form, { undo }) : null;
}

async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => await Promise.resolve());
}

async function mount(undo = false) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        NoticeProvider,
        null,
        React.createElement(NoticeViewport),
        React.createElement(Harness, { undo }),
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
});
