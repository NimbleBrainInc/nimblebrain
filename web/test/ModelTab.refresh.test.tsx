/**
 * The Model tab after a save.
 *
 * A blank limit field shows the effective value as its placeholder, read from
 * `get_config`'s `resolved` group. Clearing an override changes that value, so
 * the form has to read `get_config` again after the save lands, or the
 * placeholder keeps showing the cleared override until the page reloads.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "./setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The DOM shim builds its own errors off `window`; without these, a failed
// `querySelectorAll` throws about a missing constructor instead of reporting.
{
  const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

const CATALOG_MAX_OUTPUT = 128000;
const PINNED_MAX_OUTPUT = 16384;

/** What the override file holds; `set_model_config` clears it in this fake. */
let pinnedMaxOutput: number | undefined = PINNED_MAX_OUTPUT;
let refreshFails = false;
/** While set, `set_model_config` waits on it, holding the save in flight. */
let saveGate: Promise<void> | null = null;
const tools: string[] = [];

mock.module("../src/api/client", () => ({
  ...realClient,
  callToolWithoutWorkspace: async (_server: string, tool: string, args: Record<string, unknown>) => {
    tools.push(tool);
    if (tool === "get_config") {
      if (refreshFails && tools.includes("set_model_config")) throw new Error("network down");
      return {
        structuredContent: {
          ...(pinnedMaxOutput !== undefined ? { maxOutputTokens: pinnedMaxOutput } : {}),
          resolved: {
            models: { default: "anthropic:claude-sonnet-5", fast: "anthropic:claude-haiku-4-5" },
            maxIterations: 25,
            maxInputTokens: 500000,
            maxOutputTokens: pinnedMaxOutput ?? CATALOG_MAX_OUTPUT,
          },
          configuredProviders: ["anthropic"],
          availableModels: {},
        },
        isError: false,
      };
    }
    if (tool === "set_model_config" && saveGate) await saveGate;
    if (tool === "set_model_config" && args.clearMaxOutputTokens === true) {
      pinnedMaxOutput = undefined;
    }
    return { structuredContent: {}, isError: false };
  },
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { ModelTab } = await import("../src/pages/settings/ModelTab");

interface Mounted {
  container: HTMLDivElement;
  unmount(): void;
}

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  pinnedMaxOutput = PINNED_MAX_OUTPUT;
  refreshFails = false;
  saveGate = null;
  tools.length = 0;
});

async function flush() {
  for (let i = 0; i < 3; i++) await act(async () => await Promise.resolve());
}

async function mount(): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(React.createElement(ModelTab));
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

const maxOutputField = (c: HTMLElement) => c.querySelector<HTMLInputElement>("#maxOutputTokens");

/** Clear a controlled input the way typing does: the native setter, then `input`. */
async function clear(el: HTMLInputElement) {
  const win = (globalThis as unknown as { window: Record<string, { prototype: object }> }).window;
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
  const WindowEvent = (globalThis as unknown as { window: { Event: typeof Event } }).window.Event;
  await act(async () => {
    setter?.call(el, "");
    el.dispatchEvent(new WindowEvent("input", { bubbles: true }));
  });
}

/**
 * Whether the field sits in a disabled fieldset. Browsers report such a field
 * as `:disabled`; happy-dom does not propagate a fieldset's disabled state.
 */
const locked = (el: HTMLElement) => el.closest("fieldset:disabled") !== null;

function saveButton(container: HTMLElement) {
  const button = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Sav"),
  );
  if (!button) throw new Error("Save button not found");
  return button;
}

async function save(container: HTMLElement) {
  await act(async () => saveButton(container).click());
  await flush();
}

describe("the Model tab after clearing an override", () => {
  test("shows the new effective value as the placeholder without a reload", async () => {
    mounted = await mount();
    const field = maxOutputField(mounted.container)!;
    expect(field.value).toBe(String(PINNED_MAX_OUTPUT));

    await clear(field);
    await save(mounted.container);

    expect(tools).toContain("set_model_config");
    expect(tools.filter((t) => t === "get_config").length).toBe(2);
    const after = maxOutputField(mounted.container)!;
    expect(after.value).toBe("");
    expect(after.placeholder).toBe(String(CATALOG_MAX_OUTPUT));
  });

  // The write already landed; a failed re-read only leaves stale placeholders.
  test("still reports the save as saved when the refresh fails", async () => {
    refreshFails = true;
    mounted = await mount();
    await clear(maxOutputField(mounted.container)!);
    await save(mounted.container);
    expect(mounted.container.textContent).toContain("Model configuration saved.");
  });

  // The save ends by reloading every field, so an edit made mid-save would be
  // overwritten; the form is locked until the reload lands.
  test("locks the fields while the save is in flight", async () => {
    let release = () => {};
    saveGate = new Promise((resolve) => {
      release = resolve;
    });
    mounted = await mount();
    await clear(maxOutputField(mounted.container)!);
    await act(async () => saveButton(mounted!.container).click());
    await flush();
    expect(locked(maxOutputField(mounted.container)!)).toBe(true);

    await act(async () => release());
    await flush();
    expect(locked(maxOutputField(mounted.container)!)).toBe(false);
  });
});
