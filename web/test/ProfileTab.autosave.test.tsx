/**
 * /profile saves each field as it changes.
 *
 * The model preference is otherwise reachable only by asking the agent, so the
 * round trip is pinned here: the stored choice arrives in the field, and a
 * choice sends that field alone — "follow the default" as `null`, which
 * `set_preferences` reads as a clear.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { defineHappyDomErrorClasses } from "./happy-dom";
import { realClient } from "./setup";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

defineHappyDomErrorClasses();

type CallToolArgs = { server: string; tool: string; args: Record<string, unknown> };
const callToolCalls: CallToolArgs[] = [];

let storedModel = "";
let storedTimezone = "";
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
          // What each unset preference falls back to.
          preferenceDefaults: {
            timezone: "Pacific/Honolulu",
            locale: "en-US",
            theme: "system",
            model: "anthropic:claude-sonnet-4-6",
          },
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
          // Only what the person set; an unset preference is absent.
          preferences: {
            displayName: "P",
            ...(storedTimezone ? { timezone: storedTimezone } : {}),
            ...(storedTheme ? { theme: storedTheme } : {}),
            ...(storedModel ? { model: storedModel } : {}),
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
  storedTimezone = "";
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
const WindowEvent = window.Event;

async function choose(el: HTMLSelectElement, value: string) {
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new WindowEvent("change", { bubbles: true }));
  });
  await flush();
}

const win = () => window;

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
  // The shell decides the theme from the stored preference; opening the page
  // applies none of its own, so the form's fallback never replaces it.
  test("opening the page leaves this browser's theme to the shell", async () => {
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

/** The "Use default" clear inside the field whose label is `label`. */
function clearFor(c: HTMLElement, controlId: string): HTMLButtonElement | null {
  const control = c.querySelector(`#${controlId}`);
  const row = control?.closest("div.flex.items-start");
  return row?.querySelector<HTMLButtonElement>('button[aria-label="Use default"]') ?? null;
}

const themeButton = (c: HTMLElement, label: string) =>
  Array.from(c.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")).find((b) =>
    b.textContent?.includes(label),
  )!;

describe("opening the page saves nothing", () => {
  // Saves come only from a person's choice or the × clear. Mounting with
  // every preference unset must leave each on the default, unsaved.
  test("with every preference unset, mounting saves nothing and shows each default", async () => {
    storedTheme = null;
    mounted = await mount();
    await flush();
    expect(sets()).toEqual([]);
    expect(mounted.container.textContent).not.toContain("updated");
    expect(mounted.container.textContent).not.toContain("Saved");

    const trigger = mounted.container.querySelector("#timezone")!;
    expect(trigger.textContent).toContain("Default (Pacific/Honolulu)");
    expect(select(mounted.container)!.value).toBe("");
    expect(themeButton(mounted.container, "System").textContent).toContain("Default (System)");
  });

  // The default in force is a value, like the model's "Follow the default"
  // and the theme's "Default (System)", not an empty field's placeholder.
  test("the default timezone renders as a value, not a placeholder", async () => {
    mounted = await mount();
    const trigger = mounted.container.querySelector("#timezone")!;
    expect(trigger.className).not.toContain("text-muted-foreground");
  });
});

describe("a preference the person set can go back to the default", () => {
  test("an unset timezone shows the deployment's default and offers no clear", async () => {
    mounted = await mount();
    const trigger = mounted.container.querySelector("#timezone")!;
    expect(trigger.textContent).toContain("Default (Pacific/Honolulu)");
    expect(clearFor(mounted.container, "timezone")).toBeNull();
  });

  test("a set timezone shows Use default, which clears it with null and shows the default", async () => {
    storedTimezone = "Europe/Berlin";
    mounted = await mount();
    const trigger = mounted.container.querySelector("#timezone")!;
    expect(trigger.textContent).toContain("Europe/Berlin");
    const clear = clearFor(mounted.container, "timezone")!;
    expect(clear).not.toBeNull();
    await act(async () => clear.click());
    await flush();
    expect(sets()).toEqual([{ timezone: null }]);
    expect(trigger.textContent).toContain("Default (Pacific/Honolulu)");
    expect(clearFor(mounted.container, "timezone")).toBeNull();
  });

  test("a set model clears with null through Use default", async () => {
    storedModel = "anthropic:claude-opus-4-6";
    mounted = await mount();
    await act(async () => clearFor(mounted!.container, "preferred-model")!.click());
    await flush();
    expect(sets()).toEqual([{ model: null }]);
    expect(select(mounted.container)!.value).toBe("");
    expect(clearFor(mounted.container, "preferred-model")).toBeNull();
  });

  test("a set theme clears with null, and the default theme shows as the default", async () => {
    storedTheme = "dark";
    localStorage.setItem("nb-theme", "dark");
    mounted = await mount();
    const row = themeButton(mounted.container, "Dark").closest("div.flex.items-start")!;
    const clear = row.querySelector<HTMLButtonElement>('button[aria-label="Use default"]')!;
    await act(async () => clear.click());
    await flush();
    expect(sets()).toEqual([{ theme: null }]);
    expect(themeButton(mounted.container, "System").textContent).toContain("Default (System)");
    expect(row.querySelector('button[aria-label="Use default"]')).toBeNull();
    // This browser's copy of the cleared choice is dropped, so the default applies.
    expect(localStorage.getItem("nb-theme")).toBeNull();
  });

  test("an unset theme shows the default option and offers no clear", async () => {
    storedTheme = null;
    mounted = await mount();
    const system = themeButton(mounted.container, "System");
    expect(system.textContent).toContain("Default (System)");
    expect(
      system.closest("div.flex.items-start")!.querySelector('button[aria-label="Use default"]'),
    ).toBeNull();
  });
});
