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

mock.module("../src/api/client", () => ({
  ...realClient,
  callTool: async (server: string, tool: string, args: Record<string, unknown>) => {
    callToolCalls.push({ server, tool, args });
    if (tool === "get_config") {
      return {
        structuredContent: {
          models: { default: "anthropic:claude-sonnet-4-6" },
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
