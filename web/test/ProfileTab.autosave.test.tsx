/**
 * /profile saves each field as it changes.
 *
 * The model preference is otherwise reachable only by asking the agent, so the
 * round trip is pinned here: the stored choice arrives in the field, and a
 * choice sends that field alone — "follow the default" as `null`, which
 * `set_preferences` reads as a clear.
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

type CallToolArgs = { server: string; tool: string; args: Record<string, unknown> };
const callToolCalls: CallToolArgs[] = [];

let storedModel = "";
/** The theme the server has stored for this person; `null` means none set. */
let storedTheme: string | null = "system";
let configFails = false;
let saveRejects = false;

mock.module("../src/api/client", () => ({
  ...realClient,
  callToolWithoutWorkspace: async (server: string, tool: string, args: Record<string, unknown>) => {
    callToolCalls.push({ server, tool, args });
    if (tool === "get_config") {
      if (configFails) throw new Error("network down");
      return {
        structuredContent: {
          // No operator-set `models` key: nothing is pinned, and the label
          // still has to name what "use the default" resolves to.
          resolved: { models: { default: "anthropic:claude-sonnet-4-6" } },
          availableModels: {
            anthropic: [
              {
                id: "claude-sonnet-4-6",
                cost: { input: "$3", output: "$15" },
                limits: { context: 200000 },
              },
              {
                id: "claude-opus-4-6",
                cost: { input: "$15", output: "$75" },
                limits: { context: 200000 },
              },
            ],
          },
          preferences: {
            displayName: "P",
            timezone: "",
            ...(storedTheme ? { theme: storedTheme } : {}),
            model: storedModel,
          },
        },
        isError: false,
      };
    }
    if (tool === "set_preferences" && saveRejects) {
      // How an MCP tool refuses: a resolved result carrying isError, not a throw.
      return { content: [{ type: "text", text: 'Model "x" is not permitted.' }], isError: true };
    }
    return { structuredContent: {}, isError: false };
  },
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter } = await import("react-router-dom");
const { ProfileTab } = await import("../src/pages/settings/ProfileTab");
const { NoticeProvider, NoticeViewport } = await import("../src/components/notices");
const { ThemeProvider } = await import("../src/context/ThemeContext");
const { SessionProvider } = await import("../src/context/SessionContext");

const SESSION = {
  authenticated: true,
  user: { id: "usr_1", email: "p@example.com", displayName: "P", orgRole: "member" },
};

interface Mounted {
  container: HTMLDivElement;
  unmount(): void;
}

let mounted: Mounted | null = null;
afterEach(async () => {
  await act(async () => mounted?.unmount());
  mounted = null;
  callToolCalls.length = 0;
  storedModel = "";
  storedTheme = "system";
  configFails = false;
  saveRejects = false;
});

async function mount(): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(SessionProvider, {
          session: SESSION,
          children: React.createElement(
            ThemeProvider,
            null,
            React.createElement(
              NoticeProvider,
              null,
              React.createElement(NoticeViewport),
              React.createElement(ProfileTab),
            ),
          ),
        }),
      ),
    );
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

const select = (c: HTMLElement) => c.querySelector<HTMLSelectElement>("#preferred-model");

async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => await Promise.resolve());
}

const sets = () => callToolCalls.filter((c) => c.tool === "set_preferences").map((c) => c.args);

/** The shim's own Event constructor — a global `Event` is a different class to it. */
const WindowEvent = (globalThis as unknown as { window: { Event: typeof Event } }).window.Event;

async function choose(el: HTMLSelectElement, value: string) {
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new WindowEvent("change", { bubbles: true }));
  });
  await flush();
}

const win = () => (globalThis as unknown as { window: Window & typeof globalThis }).window;

/** Type into a controlled input the way a user does, then leave the field. */
async function typeAndLeave(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(win().HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new (win().Event)("input", { bubbles: true }));
  });
  await act(async () => {
    el.dispatchEvent(new (win().FocusEvent)("focusout", { bubbles: true }));
  });
  await flush();
}

describe("the Model control on /profile", () => {
  test("offers the catalog get_config publishes, plus an option to follow the default", async () => {
    mounted = await mount();
    const el = select(mounted.container);
    expect(el).not.toBeNull();

    const values = Array.from(el!.options).map((o) => o.value);
    expect(values).toContain("anthropic:claude-sonnet-4-6");
    expect(values).toContain("anthropic:claude-opus-4-6");
    expect(values[0]).toBe("");
  });

  // The empty option has to say what happens, not just be blank — otherwise a
  // person cannot tell it from "nothing loaded". It also has to read as
  // *following* the default: labelled with the model name alone, someone who
  // wants that model picks it and clears their preference instead, which is
  // the same outcome only until the default moves.
  test("the empty option names the default and reads as following it", async () => {
    mounted = await mount();
    const empty = select(mounted.container)!.options[0].textContent ?? "";
    expect(empty).toContain("anthropic:claude-sonnet-4-6");
    expect(empty.toLowerCase()).toContain("follow");
  });

  test("shows a stored choice as the current value", async () => {
    storedModel = "anthropic:claude-opus-4-6";
    mounted = await mount();
    expect(select(mounted.container)!.value).toBe("anthropic:claude-opus-4-6");
  });

  test("choosing a model saves it at once, alone", async () => {
    mounted = await mount();
    await choose(select(mounted.container)!, "anthropic:claude-opus-4-6");
    expect(sets()).toEqual([{ model: "anthropic:claude-opus-4-6" }]);
    expect(mounted.container.textContent).toContain("Saved");
  });

  // Choosing the empty option is how a person goes back to the default, so it
  // has to reach the server as a clear rather than being dropped as falsy.
  test("choosing the default option clears the preference with null", async () => {
    storedModel = "anthropic:claude-opus-4-6";
    mounted = await mount();
    await choose(select(mounted.container)!, "");
    expect(sets()).toEqual([{ model: null }]);
  });
});

describe("each field saves alone", () => {
  test("the name saves when the field is left", async () => {
    mounted = await mount();
    await typeAndLeave(mounted.container.querySelector<HTMLInputElement>("#displayName")!, "Q");
    expect(sets()).toEqual([{ displayName: "Q" }]);
  });

  test("a theme saves on click", async () => {
    mounted = await mount();
    const dark = Array.from(mounted.container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Dark"),
    )!;
    await act(async () => dark.click());
    await flush();
    expect(sets()).toEqual([{ theme: "dark" }]);
    expect(dark.getAttribute("aria-pressed")).toBe("true");
    // A theme the person picks is applied, not just saved.
    expect(localStorage.getItem("nb-theme")).toBe("dark");
  });
});

describe("the theme", () => {
  // With no theme saved on the server, the browser's own choice stands.
  // Opening the page must not replace it with the form's fallback.
  test("opening the page leaves a theme the person chose in this browser alone", async () => {
    storedTheme = null;
    localStorage.setItem("nb-theme", "dark");
    mounted = await mount();
    expect(localStorage.getItem("nb-theme")).toBe("dark");
    expect(sets()).toEqual([]);
  });
});

describe("the form does not claim more than it did", () => {
  // `callTool` resolves on an MCP tool error — only the HTTP call throws. A
  // swallowed isError would report a refused model as saved.
  test("reports a refused save on the field, not as saved", async () => {
    saveRejects = true;
    mounted = await mount();
    await choose(select(mounted.container)!, "anthropic:claude-opus-4-6");
    expect(mounted.container.textContent).toContain("not permitted");
    expect(mounted.container.textContent).toContain("Not saved");
    expect(mounted.container.textContent).not.toContain("Saved");
  });

  // A failed read leaves the fields holding fallbacks, not the person's
  // settings; an edit would be a choice made against values never theirs.
  test("locks the fields when the settings could not be read", async () => {
    configFails = true;
    mounted = await mount();
    expect(mounted.container.textContent).toContain("Couldn't load your settings");
    expect(mounted.container.querySelector("fieldset")?.disabled).toBe(true);
  });
});

describe("a stored model the catalog no longer carries", () => {
  // Rendering it as the empty option would tell the reader they are on the
  // default while state still holds the real value — and post it on save.
  test("stays visible and selected rather than reading as the default", async () => {
    storedModel = "google:gemini-3-pro-preview";
    mounted = await mount();
    const el = select(mounted.container)!;
    expect(el.value).toBe("google:gemini-3-pro-preview");
    expect(el.selectedOptions[0]?.textContent).toContain("google:gemini-3-pro-preview");
  });
});
