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

let toggle: () => void = () => {};
function Probe() {
  toggle = useTheme().toggle;
  return null;
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

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  localStorage.removeItem("nb-theme");
});

describe("ThemeProvider toggle", () => {
  test("stores each toggled theme as the preference, in order", async () => {
    const saved: ThemePreference[] = [];
    const save = mock(async (pref: ThemePreference) => {
      saved.push(pref);
    });
    await mount(save);

    await act(async () => toggle());
    await act(async () => toggle());

    expect(saved).toEqual(["dark", "light"]);
    expect(localStorage.getItem("nb-theme")).toBe("light");
  });

  test("a failed save keeps the toggled theme", async () => {
    await mount(async () => {
      throw new Error("offline");
    });

    await act(async () => toggle());

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("nb-theme")).toBe("dark");
  });

  test("toggles locally when no save is given", async () => {
    await mount();

    await act(async () => toggle());

    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
