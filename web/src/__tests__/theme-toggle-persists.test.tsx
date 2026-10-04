// ---------------------------------------------------------------------------
// ThemeProvider — a toggle (palette, ⌘⇧L) is the person's choice, so it is
// stored as their preference. Otherwise the shell re-applies the stored
// preference on the next config load and the toggle is lost.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
