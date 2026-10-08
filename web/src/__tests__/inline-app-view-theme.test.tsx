// ---------------------------------------------------------------------------
// An inline tool-result view follows a theme toggle
//
// The view's iframe stays mounted while the shell's theme changes, so the new
// mode reaches the app only as `ui/notifications/host-context-changed`. This
// mounts `InlineAppView` in one mode, completes the handshake through the real
// bridge, toggles the shell, and asserts the app is told the new theme and
// receives that mode's variables, spec keys and the `ai.nimblebrain/styles`
// extension both.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, mock, test } from "bun:test";
import { realClient, realMcpBridgeClient } from "../../test/setup";
import { HOST_STYLES_EXTENSION } from "../bridge/extensions";
import { getModeExtensionTokens, getSpecThemeTokens, type ThemeMode } from "../bridge/theme";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module("../api/client", () => ({
  ...realClient,
  getResources: async () => ({ html: "<html><head></head><body></body></html>" }),
}));

mock.module("../mcp-bridge-client", () => ({
  ...realMcpBridgeClient,
  sendMcpRequest: mock(async () => ({ result: { content: [] } })),
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { NoticeProvider } = await import("../components/notices");
const { ThemeProvider, useTheme } = await import("../context/ThemeContext");
const { InlineAppView } = await import("../components/InlineAppView");

type Message = { id?: string; method?: string; params?: Record<string, unknown> };

let teardown: (() => void) | null = null;

afterEach(() => {
  teardown?.();
  teardown = null;
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

/** Mount an inline view in `from`, complete its handshake, and expose a toggle. */
async function mountInline(from: ThemeMode): Promise<{
  inbox: Message[];
  setMode: (mode: ThemeMode) => Promise<void>;
}> {
  localStorage.setItem("nb-theme", from);
  let setModeRef: ((mode: ThemeMode) => void) | null = null;
  function Toggle() {
    setModeRef = useTheme().setMode;
    return null;
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        NoticeProvider,
        null,
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(Toggle),
          React.createElement(InlineAppView, {
            appName: "db-query",
            resourceUri: "ui://db-query/main",
          }),
        ),
      ),
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

  const iframe = container.querySelector("iframe");
  expect(iframe).not.toBeNull();
  const inbox: Message[] = [];
  const stubWindow = {
    postMessage(data: unknown) {
      inbox.push(data as Message);
    },
  } as Window;
  Object.defineProperty(iframe, "contentWindow", { configurable: true, get: () => stubWindow });

  function send(data: unknown): void {
    const WindowMessageEvent = (window as unknown as { MessageEvent: typeof MessageEvent })
      .MessageEvent;
    const event = new WindowMessageEvent("message", { data });
    Object.defineProperty(event, "source", { configurable: true, get: () => stubWindow });
    window.dispatchEvent(event);
  }

  send({
    jsonrpc: "2.0",
    id: "init",
    method: "ui/initialize",
    params: {
      protocolVersion: "2026-01-26",
      appInfo: { name: "iframe", version: "1.0.0" },
      appCapabilities: {},
    },
  });
  send({ jsonrpc: "2.0", method: "ui/notifications/initialized" });

  teardown = () => {
    act(() => root.unmount());
    container.remove();
  };

  return {
    inbox,
    setMode: async (mode) => {
      await act(async () => setModeRef?.(mode));
    },
  };
}

describe("InlineAppView follows a theme toggle", () => {
  for (const [from, to] of [
    ["light", "dark"],
    ["dark", "light"],
  ] as const) {
    test(`mounted ${from}, toggled ${to}: the app receives host-context-changed for ${to}`, async () => {
      const { inbox, setMode } = await mountInline(from);
      const init = inbox.find((m) => m.id === "init") as
        | { result: { hostContext: Record<string, unknown> } }
        | undefined;
      expect(init?.result.hostContext.theme).toBe(from);

      await setMode(to);

      const pushed = inbox.filter((m) => m.method === "ui/notifications/host-context-changed");
      const last = pushed[pushed.length - 1]?.params;
      expect(last?.theme).toBe(to);
      expect((last?.styles as { variables?: unknown } | undefined)?.variables).toEqual(
        getSpecThemeTokens(to),
      );
      expect(last?.[HOST_STYLES_EXTENSION]).toEqual({ variables: getModeExtensionTokens(to) });
    });
  }
});
