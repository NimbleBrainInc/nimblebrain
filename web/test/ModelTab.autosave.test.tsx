/**
 * The Model tab saves each field as it changes.
 *
 * A blank limit field shows the effective value as its placeholder, read from
 * `get_config`'s `resolved` group. Clearing an override changes that value, so
 * the form reads `resolved` again after the save lands — and only `resolved`,
 * so an edit made while a save is in flight is never overwritten.
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
/** When set, `set_model_config` answers with this refusal. */
let refusal: string | null = null;
/** When set, only a thinking-budget save is refused, with this text. */
let budgetRefusal: string | null = null;
/** While set, `set_model_config` waits on it, holding the save in flight. */
let saveGate: Promise<void> | null = null;
const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];

mock.module("../src/api/client", () => ({
  ...realClient,
  callToolWithoutWorkspace: async (_server: string, tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    if (tool === "get_config") {
      if (refreshFails && calls.some((c) => c.tool === "set_model_config")) {
        throw new Error("network down");
      }
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
          availableModels: {
            anthropic: [
              {
                id: "claude-opus-5",
                cost: { input: "$5", output: "$25" },
                limits: { context: 200000 },
              },
            ],
          },
        },
        isError: false,
      };
    }
    if (saveGate) await saveGate;
    if (refusal) return { content: [{ type: "text", text: refusal }], isError: true };
    if (budgetRefusal && "thinkingBudgetTokens" in args) {
      return { content: [{ type: "text", text: budgetRefusal }], isError: true };
    }
    if (args.maxOutputTokens === null) pinnedMaxOutput = undefined;
    return { structuredContent: {}, isError: false };
  },
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { NoticeProvider, NoticeViewport } = await import("../src/components/notices");
const { ModelTab } = await import("../src/pages/settings/ModelTab");

let unmount: (() => void) | null = null;
afterEach(async () => {
  await act(async () => unmount?.());
  unmount = null;
  pinnedMaxOutput = PINNED_MAX_OUTPUT;
  refreshFails = false;
  refusal = null;
  budgetRefusal = null;
  saveGate = null;
  calls.length = 0;
});

async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => await Promise.resolve());
}

async function mount(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(React.createElement(
        NoticeProvider,
        null,
        React.createElement(NoticeViewport),
        React.createElement(ModelTab),
      ));
  });
  await flush();
  unmount = () => {
    root.unmount();
    container.remove();
  };
  return container;
}

const win = () =>
  (globalThis as unknown as { window: Window & typeof globalThis }).window;

const field = <T extends HTMLElement>(c: HTMLElement, id: string) =>
  c.querySelector<T>(`#${id}`) ?? (() => { throw new Error(`#${id} not found`); })();

/** Type into a controlled input the way a user does: the native setter, then `input`. */
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

const saves = () => calls.filter((c) => c.tool === "set_model_config").map((c) => c.args);

describe("the Model tab", () => {
  test("has no Save button", async () => {
    const c = await mount();
    expect(Array.from(c.querySelectorAll("button")).some((b) => b.textContent === "Save")).toBe(
      false,
    );
  });

  test("clearing a limit saves that field alone, as null, when the field loses focus", async () => {
    const c = await mount();
    const maxOutput = field<HTMLInputElement>(c, "maxOutputTokens");
    expect(maxOutput.value).toBe(String(PINNED_MAX_OUTPUT));

    await type(maxOutput, "");
    expect(saves()).toEqual([]);
    expect(c.textContent).toContain("Unsaved");

    await blur(maxOutput);
    expect(saves()).toEqual([{ maxOutputTokens: null }]);
    // The new effective value shows as the placeholder without a reload.
    expect(field<HTMLInputElement>(c, "maxOutputTokens").placeholder).toBe(
      String(CATALOG_MAX_OUTPUT),
    );
    expect(c.textContent).toContain("Saved");
    expect(document.body.querySelector("[data-testid='notice']")?.textContent).toContain(
      "Max output tokens updated",
    );
  });

  test("a refused save shows the server's reason on the field, not 'saved'", async () => {
    refusal = "maxIterations must be an integer between 1 and 50.";
    const c = await mount();
    const iterations = field<HTMLInputElement>(c, "maxIterations");
    await type(iterations, "99");
    await blur(iterations);

    expect(c.textContent).toContain("maxIterations must be an integer between 1 and 50.");
    expect(c.textContent).toContain("Not saved");
    expect(c.textContent).not.toContain("Saved");
    // The typed value is kept for a retry.
    expect(field<HTMLInputElement>(c, "maxIterations").value).toBe("99");
  });

  // The write already landed; a failed re-read only leaves a stale placeholder.
  test("still reports the save as saved when the placeholder refresh fails", async () => {
    refreshFails = true;
    const c = await mount();
    const maxOutput = field<HTMLInputElement>(c, "maxOutputTokens");
    await type(maxOutput, "");
    await blur(maxOutput);
    expect(c.textContent).toContain("Saved");
  });

  test("an edit to another field while a save is in flight is kept", async () => {
    let release = () => {};
    saveGate = new Promise((resolve) => {
      release = resolve;
    });
    const c = await mount();
    const maxOutput = field<HTMLInputElement>(c, "maxOutputTokens");
    await type(maxOutput, "");
    await blur(maxOutput);
    expect(c.textContent).toContain("Saving…");

    const iterations = field<HTMLInputElement>(c, "maxIterations");
    expect(iterations.closest("fieldset:disabled")).toBeNull();
    await type(iterations, "7");

    await act(async () => release());
    await flush();
    expect(field<HTMLInputElement>(c, "maxIterations").value).toBe("7");
  });

  test("choosing a default model saves it at once and offers Undo", async () => {
    const c = await mount();
    await choose(field<HTMLSelectElement>(c, "defaultModel"), "anthropic:claude-opus-5");
    expect(saves()).toEqual([{ models: { default: "anthropic:claude-opus-5" } }]);

    const notice = document.body.querySelector("[data-testid='notice']");
    expect(notice?.textContent).toContain("Default model updated");
    const undo = Array.from(notice?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "Undo",
    );
    await act(async () => undo?.click());
    await flush();
    expect(saves()).toEqual([
      { models: { default: "anthropic:claude-opus-5" } },
      { models: { default: null } },
    ]);
  });

  test("switching the thinking mode sends the mode alone", async () => {
    const c = await mount();
    await choose(field<HTMLSelectElement>(c, "thinking"), "adaptive");
    expect(saves()).toEqual([{ thinking: "adaptive" }]);
  });
  // A mode that ignores the budget hides its field. A refused budget would
  // otherwise leave the page reporting a change nobody can see to fix.
  test("hiding a field that failed to save puts it back, so the page is not left in error", async () => {
    budgetRefusal = "thinkingBudgetTokens must be a positive integer ≥ 1024.";
    const c = await mount();
    const budget = field<HTMLInputElement>(c, "thinkingBudgetTokens");
    await type(budget, "500");
    await blur(budget);
    expect(c.textContent).toContain("Not saved");

    await choose(field<HTMLSelectElement>(c, "thinking"), "adaptive");
    expect(c.querySelector("#thinkingBudgetTokens")).toBeNull();
    expect(c.textContent).not.toContain("Not saved");

    // Back to a mode that shows it: the saved value, not the refused one.
    await choose(field<HTMLSelectElement>(c, "thinking"), "enabled");
    expect(field<HTMLInputElement>(c, "thinkingBudgetTokens").value).toBe("");
  });
});
