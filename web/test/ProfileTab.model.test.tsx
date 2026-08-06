/**
 * The Model control on /profile.
 *
 * The preference is otherwise reachable only by asking the agent, so what this
 * pins is the round trip: the stored choice arrives in the field, and Save
 * sends what the field holds — including the empty string, which
 * `set_preferences` reads as "follow the configured default".
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
let configFails = false;
let saveRejects = false;

mock.module("../src/api/client", () => ({
  ...realClient,
  callTool: async (server: string, tool: string, args: Record<string, unknown>) => {
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
          preferences: { displayName: "P", timezone: "", theme: "system", model: storedModel },
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
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  callToolCalls.length = 0;
  storedModel = "";
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
        React.createElement(
          SessionProvider,
          { session: SESSION },
          React.createElement(ThemeProvider, null, React.createElement(ProfileTab)),
        ),
      ),
    );
  });
  for (let i = 0; i < 3; i++) await act(async () => await Promise.resolve());
  return {
    container,
    unmount() {
      root.unmount();
      container.remove();
    },
  };
}

const select = (c: HTMLElement) => c.querySelector<HTMLSelectElement>("#preferred-model");

async function save(container: HTMLElement) {
  for (const el of Array.from(container.querySelectorAll("button"))) {
    if (el.textContent?.includes("Save")) {
      await act(async () => el.click());
      return;
    }
  }
  throw new Error("Save button not found");
}

const findByText = (c: HTMLElement, text: string) =>
  Array.from(c.querySelectorAll("*")).some((el) => el.textContent === text);

const saveButton = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("button")).find((b) => b.textContent?.includes("Save"));

const lastSet = () => callToolCalls.filter((c) => c.tool === "set_preferences").at(-1);

/** The shim's own Event constructor — a global `Event` is a different class to it. */
const WindowEvent = (globalThis as unknown as { window: { Event: typeof Event } }).window.Event;

async function choose(el: HTMLSelectElement, value: string) {
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new WindowEvent("change", { bubbles: true }));
  });
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
  // person cannot tell it from "nothing loaded".
  test("names the configured default in the empty option", async () => {
    mounted = await mount();
    expect(select(mounted.container)!.options[0].textContent).toContain(
      "anthropic:claude-sonnet-4-6",
    );
  });

  test("shows a stored choice as the current value", async () => {
    storedModel = "anthropic:claude-opus-4-6";
    mounted = await mount();
    expect(select(mounted.container)!.value).toBe("anthropic:claude-opus-4-6");
  });

  test("sends the chosen model on save", async () => {
    mounted = await mount();
    await choose(select(mounted.container)!, "anthropic:claude-opus-4-6");
    await save(mounted.container);
    expect(lastSet()?.args.model).toBe("anthropic:claude-opus-4-6");
  });

  // Choosing the empty option is how a person goes back to the default, so the
  // empty string has to reach the server rather than being dropped as falsy.
  test("sends an empty string when the default option is chosen", async () => {
    storedModel = "anthropic:claude-opus-4-6";
    mounted = await mount();
    await choose(select(mounted.container)!, "");
    await save(mounted.container);
    expect(lastSet()?.args).toHaveProperty("model", "");
  });
});

describe("the form does not claim more than it did", () => {
  // `callTool` resolves on an MCP tool error — only the HTTP call throws. The
  // model gate refuses before anything is written, so a swallowed isError
  // reports "saved" over a save that discarded the name and timezone too.
  test("reports a refused save as an error, not as success", async () => {
    saveRejects = true;
    mounted = await mount();
    await save(mounted.container);
    expect(findByText(mounted.container, "Preferences saved.")).toBe(false);
    expect(mounted.container.textContent).toContain("not permitted");
  });

  // A failed read leaves the form holding empty defaults, and the server reads
  // an empty model as a clear — so saving would wipe settings never touched.
  test("refuses to save settings it could not read", async () => {
    configFails = true;
    mounted = await mount();
    expect(saveButton(mounted.container)?.disabled).toBe(true);
    expect(mounted.container.textContent).toContain("Couldn't load your settings");
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
