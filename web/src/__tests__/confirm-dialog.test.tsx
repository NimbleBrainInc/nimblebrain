// ---------------------------------------------------------------------------
// ConfirmDialog — the confirmation primitive, asserted once.
//
// The shell had six hand-rolled modals and no dialog primitive, so every
// destructive action got whatever confirmation its author had time for and no
// two agreed on escape, backdrop, focus, or a pending state. This suite is the
// reason there is now one: the traits below are asserted HERE, against the
// primitive, rather than re-litigated per caller.
//
//   - every dismissal path denies (escape, backdrop, cancel), and none of them
//     runs the action
//   - focus starts on confirm and returns to the trigger on close, so a
//     keyboard user is not dropped at the top of the document
//   - a slow action cannot be double-fired, and its failure is reported inside
//     the dialog instead of behind one that has already dismissed itself
//
// Same plumbing as connector-sections.test.tsx: bun:test + react-dom/client +
// happy-dom, no @testing-library/react. The dialog portals into document.body,
// so queries here are body-scoped rather than container-scoped.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, mock, test } from "bun:test";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom builds its selector-parse errors from `window.SyntaxError`, which
// its Window does not define — so a rejected selector throws a constructor
// TypeError instead of the parse error naming it. Same shim as
// workspace-secrets-section.test.tsx.
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

const { ConfirmDialog } = await import("../components/ui/confirm-dialog");

interface Mounted {
  container: HTMLDivElement;
  unmount(): void;
}

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

/**
 * Settle React AND the primitive's own work. Base UI moves focus on a timer
 * rather than in the commit, so a microtask-only flush observes the dialog
 * before it has focused anything.
 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(element: React.ReactElement): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(element);
  });
  await flush();
  return {
    container,
    unmount() {
      root.unmount();
      container.remove();
    },
  };
}

/** The dialog's own buttons — it portals out of the mount container. */
function dialogButton(text: string): HTMLButtonElement | null {
  const popup = document.body.querySelector('[role="dialog"]');
  if (!popup) return null;
  return (
    Array.from(popup.querySelectorAll("button")).find((b) => b.textContent?.includes(text)) ?? null
  );
}

function popup(): HTMLElement | null {
  return document.body.querySelector('[role="dialog"]');
}

async function click(el: Element | null): Promise<void> {
  const MouseEventCtor = (globalThis as unknown as { window: { MouseEvent: typeof MouseEvent } })
    .window.MouseEvent;
  await act(async () => {
    el?.dispatchEvent(new MouseEventCtor("click", { bubbles: true }));
  });
  await flush();
}

async function pressEscape(): Promise<void> {
  const KeyboardEventCtor = (
    globalThis as unknown as { window: { KeyboardEvent: typeof KeyboardEvent } }
  ).window.KeyboardEvent;
  await act(async () => {
    (popup() ?? document.body).dispatchEvent(
      new KeyboardEventCtor("keydown", { key: "Escape", bubbles: true }),
    );
  });
  await flush();
}

/**
 * A host that owns `open` the way a real caller does, so a denial has to
 * actually travel through `onOpenChange` to close the dialog.
 */
function Host({
  onConfirm,
  onOpenChange,
  children,
}: {
  onConfirm: () => Promise<void> | void;
  onOpenChange?: (open: boolean) => void;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button type="button" id="trigger" onClick={() => setOpen(true)}>
        Open
      </button>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          onOpenChange?.(next);
          setOpen(next);
        }}
        title="Delete the thing?"
        description="This cannot be undone."
        confirmLabel="Delete"
        pendingLabel="Deleting…"
        destructive
        onConfirm={onConfirm}
      >
        {children}
      </ConfirmDialog>
    </>
  );
}

/**
 * Open it the way a person does — focus the trigger, then click. The focus
 * matters: the primitive restores to whatever held focus when it opened, so a
 * synthetic click alone would hand it back whatever the PREVIOUS test file left
 * focused, and the restore assertion would depend on file order.
 */
async function openDialog(mountedHost: Mounted): Promise<void> {
  const trigger = mountedHost.container.querySelector("#trigger") as HTMLButtonElement | null;
  await act(async () => {
    trigger?.focus();
  });
  await click(trigger);
}

describe("ConfirmDialog — denial", () => {
  test("escape closes and does not run the action", async () => {
    const onConfirm = mock(async () => {});
    mounted = await mount(<Host onConfirm={onConfirm} />);
    await openDialog(mounted);
    expect(popup()).not.toBeNull();

    await pressEscape();
    expect(popup()).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("cancel closes and does not run the action", async () => {
    const onConfirm = mock(async () => {});
    mounted = await mount(<Host onConfirm={onConfirm} />);
    await openDialog(mounted);

    await click(dialogButton("Cancel"));
    expect(popup()).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("a backdrop press closes and does not run the action", async () => {
    const onConfirm = mock(async () => {});
    mounted = await mount(<Host onConfirm={onConfirm} />);
    await openDialog(mounted);

    // Base UI dismisses on an outside pointer press, not a click on the
    // backdrop element — so this drives the press the way a mouse does. The
    // element is asserted rather than defaulted: a selector that stopped
    // matching would otherwise fall back to the body and pass anyway.
    const backdrop = document.body.querySelector(
      '[data-base-ui-portal] > div[role="presentation"][data-open]',
    );
    expect(backdrop).not.toBeNull();
    const MouseEventCtor = (globalThis as unknown as { window: { MouseEvent: typeof MouseEvent } })
      .window.MouseEvent;
    await act(async () => {
      for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
        backdrop?.dispatchEvent(new MouseEventCtor(type, { bubbles: true }));
      }
    });
    await flush();

    expect(popup()).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

/** What has focus, by label — a DOM node in a failure diff is unreadable. */
function focusedLabel(): string | null {
  return (document.activeElement as HTMLElement | null)?.textContent ?? null;
}

describe("ConfirmDialog — focus", () => {
  test("opens with confirm focused and restores the trigger on close", async () => {
    mounted = await mount(<Host onConfirm={async () => {}} />);
    await openDialog(mounted);

    expect(focusedLabel()).toBe("Delete");

    await pressEscape();
    expect(focusedLabel()).toBe("Open");
  });

  // The trap itself is not asserted here: happy-dom does not move focus on Tab,
  // so a "tab stays inside" test passes whether or not anything traps. What IS
  // observable is the state that produces the trap in a browser — the rest of
  // the document hidden from assistive tech while the dialog is open, and
  // released when it closes.
  test("the rest of the document is hidden while the dialog is open", async () => {
    mounted = await mount(<Host onConfirm={async () => {}} />);
    await openDialog(mounted);
    expect(mounted.container.getAttribute("aria-hidden")).toBe("true");

    await pressEscape();
    expect(mounted.container.getAttribute("aria-hidden")).toBeNull();
  });
});

describe("ConfirmDialog — labelling", () => {
  test("title and description are the dialog's accessible name and description", async () => {
    mounted = await mount(<Host onConfirm={async () => {}} />);
    await openDialog(mounted);

    const labelledBy = popup()?.getAttribute("aria-labelledby");
    const describedBy = popup()?.getAttribute("aria-describedby");
    expect(document.getElementById(labelledBy ?? "")?.textContent).toBe("Delete the thing?");
    expect(document.getElementById(describedBy ?? "")?.textContent).toBe("This cannot be undone.");
  });
});

describe("ConfirmDialog — confirming", () => {
  test("a slow action cannot be double-fired, and both buttons report pending", async () => {
    let release: (() => void) | null = null;
    const onConfirm = mock(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    mounted = await mount(<Host onConfirm={onConfirm} />);
    await openDialog(mounted);

    await click(dialogButton("Delete"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(dialogButton("Deleting…")?.disabled).toBe(true);
    expect(dialogButton("Cancel")?.disabled).toBe(true);

    // A second click while in flight is dropped, not queued.
    await click(dialogButton("Deleting…"));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    // And escape can't close over a running action, which would leave its
    // outcome with nowhere to be reported.
    await pressEscape();
    expect(popup()).not.toBeNull();

    await act(async () => {
      release?.();
    });
    await flush();
  });

  test("a failure is shown in the dialog and the dialog stays open", async () => {
    const onConfirm = mock(async () => {
      throw new Error("upstream refused");
    });
    mounted = await mount(<Host onConfirm={onConfirm} />);
    await openDialog(mounted);

    await click(dialogButton("Delete"));
    expect(popup()?.textContent).toContain("upstream refused");
    expect(dialogButton("Delete")?.disabled).toBe(false);
  });

  test("closing is the caller's to do — a resolved confirm leaves the dialog alone", async () => {
    // The primitive returns approve or deny; a confirm that navigates has
    // nothing to close, and one that stays wants the dialog gone on its own
    // terms. Auto-closing here would make both of those someone else's bug.
    const onConfirm = mock(async () => {});
    mounted = await mount(<Host onConfirm={onConfirm} />);
    await openDialog(mounted);

    await click(dialogButton("Delete"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(popup()).not.toBeNull();
  });

  test("a stale error is gone on reopen", async () => {
    let fail = true;
    const onConfirm = mock(async () => {
      if (fail) throw new Error("upstream refused");
    });
    mounted = await mount(<Host onConfirm={onConfirm} />);
    await openDialog(mounted);
    await click(dialogButton("Delete"));
    expect(popup()?.textContent).toContain("upstream refused");

    await pressEscape();
    fail = false;
    await openDialog(mounted);
    expect(popup()?.textContent).not.toContain("upstream refused");
  });
});

describe("ConfirmDialog — body", () => {
  test("arbitrary content renders, which is what lets a caller show what it takes", async () => {
    mounted = await mount(
      <Host onConfirm={async () => {}}>
        <p>and its two stored credentials</p>
      </Host>,
    );
    await openDialog(mounted);
    expect(popup()?.textContent).toContain("and its two stored credentials");
    expect(popup()?.textContent).toContain("This cannot be undone.");
  });
});
