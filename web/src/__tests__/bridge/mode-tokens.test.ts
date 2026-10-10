// ---------------------------------------------------------------------------
// Mode-varying tokens follow a theme toggle
//
// An iframe stays mounted across a theme change, and its srcdoc style block is
// written once, at mount. So every token whose value differs between light and
// dark has to reach the app over the protocol, on the handshake and again on
// every `host-context-changed`: a spec key on `styles.variables`, anything else
// on the `ai.nimblebrain/styles` extension.
//
// These mount the app in one mode, toggle to the other through the real bridge,
// and assert the app receives the new mode's value for every token that varies,
// derived from the token map rather than listed, plus the palette values of the
// non-spec ones, asserted literally against the palette as `palette.test.ts`
// does.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, mock, test } from "bun:test";
import { realClient, realMcpBridgeClient } from "../../../test/setup";
import { HOST_STYLES_EXTENSION } from "../../bridge/extensions";
import { buildHostContext } from "../../bridge/host-extensions";
import { injectThemeStyles } from "../../bridge/iframe";
import {
  DARK_TOKENS,
  getModeExtensionTokens,
  getSpecThemeTokens,
  LIGHT_TOKENS,
  type ThemeMode,
} from "../../bridge/theme";
import { colors, pick } from "../../theme/palette";

mock.module("../../api/client", () => ({
  ...realClient,
  getActiveWorkspaceId: () => "ws_0076759dbbe19fcc",
}));

mock.module("../../mcp-bridge-client", () => ({
  ...realMcpBridgeClient,
  sendMcpRequest: mock(async () => ({ result: { content: [] } })),
}));

const { createBridge } = await import("../../bridge/bridge");

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Message = { id?: string; method?: string; params?: unknown; result?: unknown };

interface AppSide {
  inbox: Message[];
  send(data: unknown): void;
  cleanup(): void;
}

function makeApp(): { iframe: HTMLIFrameElement; app: AppSide } {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
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

  return { iframe, app: { inbox, send, cleanup: () => document.body.removeChild(iframe) } };
}

let teardown: (() => void) | null = null;

afterEach(() => {
  teardown?.();
  teardown = null;
  document.documentElement.classList.remove("dark");
});

function setShellMode(mode: ThemeMode): void {
  document.documentElement.classList.toggle("dark", mode === "dark");
}

/** The variables an app holds from one host context: spec keys and the extension's. */
function variablesOf(ctx: Record<string, unknown>): {
  spec: Record<string, string>;
  ext: Record<string, string>;
} {
  const spec = (ctx.styles as { variables?: Record<string, string> } | undefined)?.variables ?? {};
  const ext =
    (ctx[HOST_STYLES_EXTENSION] as { variables?: Record<string, string> } | undefined)?.variables ??
    {};
  return { spec, ext };
}

/** Mount in `from`, complete the handshake, toggle the shell to `to`; return both contexts. */
async function mountAndToggle(
  from: ThemeMode,
  to: ThemeMode,
): Promise<{ initial: Record<string, unknown>; toggled: Record<string, unknown> }> {
  setShellMode(from);
  const { iframe, app } = makeApp();
  const bridge = createBridge(iframe, "db-query");
  teardown = () => {
    bridge.destroy();
    app.cleanup();
  };

  app.send({
    jsonrpc: "2.0",
    id: "init",
    method: "ui/initialize",
    params: {
      protocolVersion: "2026-01-26",
      appInfo: { name: "iframe", version: "1.0.0" },
      appCapabilities: {},
    },
  });
  const reply = app.inbox.find((m) => m.id === "init") as
    | { result: { hostContext: Record<string, unknown> } }
    | undefined;
  expect(reply).toBeDefined();
  app.send({ jsonrpc: "2.0", method: "ui/notifications/initialized" });

  // What SlotRenderer does on a theme toggle.
  setShellMode(to);
  bridge.setHostContext(buildHostContext(to, null));
  const pushed = app.inbox.filter((m) => m.method === "ui/notifications/host-context-changed");
  expect(pushed.length).toBe(1);

  return {
    initial: (reply as { result: { hostContext: Record<string, unknown> } }).result.hostContext,
    toggled: pushed[0]?.params as Record<string, unknown>,
  };
}

/** Every token whose value differs between the modes, spec key or not. */
const MODE_VARYING = Object.keys(LIGHT_TOKENS).filter((k) => LIGHT_TOKENS[k] !== DARK_TOKENS[k]);

/** The non-spec mode-varying tokens and the palette colour each carries. */
const EXTENSION_PALETTE: Record<string, keyof typeof colors> = {
  "--color-text-accent": "primary",
  "--nb-color-processing": "processing",
  "--nb-color-processing-light": "processing-light",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("every mode-varying token follows a theme toggle", () => {
  test("the set is not empty, so the toggle tests assert something", () => {
    expect(MODE_VARYING.length).toBeGreaterThan(0);
    expect(Object.keys(getModeExtensionTokens("light")).sort()).toEqual(
      Object.keys(EXTENSION_PALETTE).sort(),
    );
  });

  for (const [from, to] of [
    ["light", "dark"],
    ["dark", "light"],
  ] as const) {
    test(`mounted ${from}, toggled ${to}: the app receives ${to}'s value for each`, async () => {
      const { initial, toggled } = await mountAndToggle(from, to);
      const expected = to === "dark" ? DARK_TOKENS : LIGHT_TOKENS;
      const before = from === "dark" ? DARK_TOKENS : LIGHT_TOKENS;

      for (const [ctx, values] of [
        [initial, before],
        [toggled, expected],
      ] as const) {
        const { spec, ext } = variablesOf(ctx);
        const received = { ...spec, ...ext };
        const wrong = MODE_VARYING.filter((k) => received[k] !== values[k]);
        expect(wrong, `tokens missing or stale: ${wrong.join(", ")}`).toEqual([]);
      }
    });

    test(`mounted ${from}, toggled ${to}: the extension carries the palette's ${to} values`, async () => {
      const { toggled } = await mountAndToggle(from, to);
      const { ext } = variablesOf(toggled);
      for (const [token, color] of Object.entries(EXTENSION_PALETTE)) {
        expect(ext[token]).toBe(pick(colors[color], to));
      }
    });
  }

  test("styles.variables stays inside the spec enum; the extension holds the rest", async () => {
    const { initial, toggled } = await mountAndToggle("light", "dark");
    for (const [ctx, mode] of [
      [initial, "light"],
      [toggled, "dark"],
    ] as const) {
      const { spec, ext } = variablesOf(ctx);
      expect(spec).toEqual(getSpecThemeTokens(mode));
      for (const key of Object.keys(ext)) expect(key in getSpecThemeTokens(mode)).toBe(false);
    }
  });
});

describe("the srcdoc block carries no token that a non-spec client would leave stale", () => {
  for (const mode of ["light", "dark"] as const) {
    test(`${mode}: no out-of-spec token in the block varies with the mode`, () => {
      const block = injectThemeStyles("<html><head></head><body></body></html>", mode);
      const spec = getSpecThemeTokens(mode);
      const declared = [...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1] as string);
      const stale = declared.filter((k) => !(k in spec) && LIGHT_TOKENS[k] !== DARK_TOKENS[k]);
      expect(stale).toEqual([]);
      // Guard the guard: the block still carries tokens.
      expect(declared).toContain("--color-background-primary");
    });
  }
});
