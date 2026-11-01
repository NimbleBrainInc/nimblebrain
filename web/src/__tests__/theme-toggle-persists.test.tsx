// ---------------------------------------------------------------------------
// ThemeProvider — a toggle (palette, ⌘⇧L) is the person's choice, so it is
// stored as their preference. Otherwise the shell re-applies the stored
// preference on the next config load and the toggle is lost.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { ThemeProvider, useTheme } = await import("../context/ThemeContext");
type ThemePreference = import("../context/ThemeContext").ThemePreference;

let theme: ReturnType<typeof useTheme>;
function Probe() {
  theme = useTheme();
  return null;
}

const isDark = () => document.documentElement.classList.contains("dark");

/** A save the test finishes by hand, so it can act while the save is in flight. */
function heldSaves() {
  const calls: { pref: ThemePreference; finish: () => void }[] = [];
  const save = mock(
    (pref: ThemePreference) =>
      new Promise<void>((resolve) => {
        calls.push({ pref, finish: resolve });
      }),
  );
  return { save, calls };
}

let root: ReturnType<typeof ReactDOMClient.createRoot> | null = null;
let container: HTMLDivElement | null = null;

async function mount(savePreference?: (pref: ThemePreference) => Promise<void>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root?.render(
      <ThemeProvider savePreference={savePreference}>
        <Probe />
      </ThemeProvider>,
    );
  });
}

/** Re-render with a different save function: signing in (a save) or out (none). */
async function rerender(savePreference?: (pref: ThemePreference) => Promise<void>) {
  await act(async () => {
    root?.render(
      <ThemeProvider savePreference={savePreference}>
        <Probe />
      </ThemeProvider>,
    );
  });
}

beforeEach(() => {
  localStorage.setItem("nb-theme", "light");
  document.documentElement.classList.remove("dark");
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  localStorage.removeItem("nb-theme");
});

describe("ThemeProvider toggle", () => {
  test("stores each toggled theme, starting a save only after the one before it", async () => {
    const { save, calls } = heldSaves();
    await mount(save);

    await act(async () => theme.toggle());
    await act(async () => theme.toggle());
    expect(calls.map((c) => c.pref)).toEqual(["dark"]);

    await act(async () => calls[0]?.finish());
    expect(calls.map((c) => c.pref)).toEqual(["dark", "light"]);
    expect(localStorage.getItem("nb-theme")).toBe("light");
  });

  test("while a toggle is saving, an older stored theme does not replace it", async () => {
    const { save, calls } = heldSaves();
    await mount(save);

    await act(async () => theme.toggle());
    // The shell's re-read lands before the save does and still says light.
    await act(async () => theme.applyPreference("light"));
    expect(isDark()).toBe(true);

    await act(async () => calls[0]?.finish());
    await act(async () => theme.applyPreference("light"));
    expect(isDark()).toBe(false);
  });

  test("a failed save keeps the toggled theme", async () => {
    await mount(async () => {
      throw new Error("offline");
    });

    await act(async () => theme.toggle());

    expect(isDark()).toBe(true);
    expect(localStorage.getItem("nb-theme")).toBe("dark");
  });

  test("toggles locally when no save is given", async () => {
    await mount();

    await act(async () => theme.toggle());

    expect(isDark()).toBe(true);
  });
});

// The provider sits above the auth gate and outlives sign-in and sign-out, so
// its save state belongs to one session and is dropped when the save changes.
describe("ThemeProvider across sessions", () => {
  test("a save left in flight at sign-out does not hold back the next account's preference", async () => {
    const first = heldSaves();
    await mount(first.save);
    await act(async () => theme.toggle());
    expect(isDark()).toBe(true);

    await rerender(undefined);
    await rerender(heldSaves().save);
    await act(async () => theme.applyPreference("light"));

    expect(isDark()).toBe(false);
  });

  test("the next session's saves do not queue behind a save left in flight", async () => {
    const first = heldSaves();
    await mount(first.save);
    await act(async () => theme.toggle());

    const second = heldSaves();
    await rerender(undefined);
    await rerender(second.save);
    await act(async () => theme.toggle());

    expect(second.calls.map((c) => c.pref)).toEqual(["light"]);
  });

  test("an old session's save finishing does not release the new session's guard", async () => {
    const first = heldSaves();
    await mount(first.save);
    await act(async () => theme.toggle());

    const second = heldSaves();
    await rerender(second.save);
    await act(async () => theme.toggle());
    expect(isDark()).toBe(false);

    await act(async () => first.calls[0]?.finish());
    // The new session's own save is still in flight, so an older read stays out.
    await act(async () => theme.applyPreference("dark"));
    expect(isDark()).toBe(false);
  });

  test("a toggle made signed out gives way to the account's preference at sign-in", async () => {
    await mount();
    await act(async () => theme.toggle());
    expect(isDark()).toBe(true);

    await rerender(heldSaves().save);
    await act(async () => theme.applyPreference("light"));

    expect(isDark()).toBe(false);
  });
});
