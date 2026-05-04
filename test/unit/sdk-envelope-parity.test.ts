/**
 * SDK ⇄ host bridge schema parity.
 *
 * The bundles in `src/bundles/{home,usage,conversations,automations}/ui`
 * construct postMessage envelopes through `@nimblebrain/synapse`, never
 * by hand. The bridge (`web/src/bridge/validate.ts`) drops any envelope
 * that fails its TypeBox schema. If the SDK ever emits an envelope that
 * doesn't match the host schemas, every internal app silently breaks.
 *
 * This test drives the SDK through a fake host, captures every
 * `window.parent.postMessage` payload, and runs each one through the
 * bridge validator. A bump of `@nimblebrain/synapse` that produces a
 * malformed envelope fails CI here — before the broken SDK can land.
 *
 * Mocking approach mirrors `bridge-extensions.test.ts`: install minimal
 * `window` / `document` shims, intercept `parent.postMessage`, and
 * dispatch synthetic `MessageEvent`s to advance the SDK's async handshake.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { validateAppToHostMessage } from "../../web/src/bridge/validate.ts";

// Captured outbound envelopes (`parent.postMessage` calls).
const captured: unknown[] = [];
// `addEventListener("message", ...)` handlers installed by the SDK.
const messageListeners: Set<(event: { data: unknown; source: unknown; origin: string }) => void> =
  new Set();

const ORIG_WINDOW = (globalThis as { window?: unknown }).window;
const ORIG_DOCUMENT = (globalThis as { document?: unknown }).document;
const ORIG_MESSAGE_EVENT = (globalThis as { MessageEvent?: unknown }).MessageEvent;

beforeEach(() => {
  captured.length = 0;
  messageListeners.clear();

  // biome-ignore lint/suspicious/noExplicitAny: minimal browser shim for SDK
  const fakeWindow: any = {
    parent: {
      postMessage: (msg: unknown) => {
        captured.push(msg);
      },
    },
    addEventListener: (type: string, fn: (e: { data: unknown; source: unknown; origin: string }) => void) => {
      if (type === "message") messageListeners.add(fn);
    },
    removeEventListener: (type: string, fn: (e: { data: unknown; source: unknown; origin: string }) => void) => {
      if (type === "message") messageListeners.delete(fn);
    },
    location: { origin: "http://localhost", href: "http://localhost/" },
  };
  // SDK reads `window.parent` AND uses `self`-style closures that pick up
  // whatever `window` is bound at module-load time. Setting both paths.
  fakeWindow.window = fakeWindow;
  fakeWindow.self = fakeWindow;
  (globalThis as { window?: unknown }).window = fakeWindow;

  (globalThis as { document?: unknown }).document = {
    documentElement: {
      style: { setProperty: () => {} },
      classList: { contains: () => false },
    },
    // SDK installs a keydown forwarder; needs a real-shaped addEventListener.
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  // MessageEvent is a browser global; Bun's test runtime doesn't ship it.
  // The SDK doesn't construct MessageEvents itself but we need the type
  // for the synthetic host responses we dispatch into the listeners.
  if (typeof MessageEvent === "undefined") {
    class FakeMessageEvent {
      type: string;
      data: unknown;
      source: unknown;
      origin: string;
      constructor(type: string, init?: { data?: unknown; source?: unknown; origin?: string }) {
        this.type = type;
        this.data = init?.data;
        this.source = init?.source ?? null;
        this.origin = init?.origin ?? "";
      }
    }
    (globalThis as { MessageEvent?: unknown }).MessageEvent = FakeMessageEvent;
  }
});

afterEach(() => {
  if (ORIG_WINDOW !== undefined) {
    (globalThis as { window?: unknown }).window = ORIG_WINDOW;
  } else {
    delete (globalThis as { window?: unknown }).window;
  }
  if (ORIG_DOCUMENT !== undefined) {
    (globalThis as { document?: unknown }).document = ORIG_DOCUMENT;
  } else {
    delete (globalThis as { document?: unknown }).document;
  }
  if (ORIG_MESSAGE_EVENT !== undefined) {
    (globalThis as { MessageEvent?: unknown }).MessageEvent = ORIG_MESSAGE_EVENT;
  } else {
    delete (globalThis as { MessageEvent?: unknown }).MessageEvent;
  }
});

/** Send a synthetic host → app message to all SDK message listeners. */
function dispatchToSdk(data: unknown): void {
  const event = {
    data,
    source: (globalThis as { window?: { parent?: unknown } }).window?.parent ?? null,
    origin: "",
  };
  for (const fn of messageListeners) fn(event);
}

/** Find the latest captured envelope with the given JSON-RPC method. */
function lastEnvelopeWithMethod(method: string): Record<string, unknown> | undefined {
  for (let i = captured.length - 1; i >= 0; i--) {
    const m = captured[i] as Record<string, unknown> | undefined;
    if (m && m.method === method) return m;
  }
  return undefined;
}

/** Drive the SDK through a successful handshake so non-init envelopes can flow. */
function completeHandshake(): void {
  const init = lastEnvelopeWithMethod("ui/initialize") as
    | { id: string | number }
    | undefined;
  if (!init) {
    throw new Error("SDK did not emit ui/initialize on instantiation");
  }
  dispatchToSdk({
    jsonrpc: "2.0",
    id: init.id,
    result: {
      protocolVersion: "2026-01-26",
      // The SDK gates NB-only methods (`action`, etc.) on `hostInfo.name === "nimblebrain"`.
      // Match the real bridge's value here so those methods aren't no-ops in the test.
      hostInfo: { name: "nimblebrain", version: "1.0.0" },
      hostCapabilities: {
        openLinks: {},
        serverTools: {},
        logging: {},
        tasks: { cancel: {}, requests: { tools: { call: {} } } },
      },
      hostContext: {
        theme: "light",
        styles: { variables: {} },
      },
    },
  });
}

/** Assert that every captured envelope to date passes the bridge validator. */
function expectAllCapturedValid(): void {
  for (const env of captured) {
    const v = validateAppToHostMessage(env);
    expect(
      v.ok,
      `envelope ${(env as { method?: string }).method ?? "(no method)"} failed validation: ${v.reason} — payload: ${JSON.stringify(env)}`,
    ).toBe(true);
  }
}

describe("Synapse SDK ⇄ host bridge schema parity", () => {
  it("ui/initialize handshake envelope passes the bridge validator", async () => {
    const { createSynapse } = await import("@nimblebrain/synapse");
    createSynapse({ name: "test-app", version: "1.0.0" });
    // microtask flush — the SDK constructs and posts init via a microtask in
    // some configurations
    await Promise.resolve();
    const init = lastEnvelopeWithMethod("ui/initialize");
    expect(init, "SDK must emit ui/initialize on instantiation").toBeDefined();
    const v = validateAppToHostMessage(init);
    expect(v.ok, `initialize: ${v.reason}`).toBe(true);
  });

  it("ui/notifications/initialized notification passes the validator", async () => {
    const { createSynapse } = await import("@nimblebrain/synapse");
    createSynapse({ name: "test-app", version: "1.0.0" });
    await Promise.resolve();
    completeHandshake();
    await Promise.resolve();
    const notif = lastEnvelopeWithMethod("ui/notifications/initialized");
    expect(notif, "SDK must emit initialized after handshake").toBeDefined();
    const v = validateAppToHostMessage(notif);
    expect(v.ok, `initialized: ${v.reason}`).toBe(true);
  });

  it("synapse.callTool emits a schema-valid tools/call envelope", async () => {
    const { createSynapse } = await import("@nimblebrain/synapse");
    const synapse = createSynapse({ name: "test-app", version: "1.0.0" });
    await Promise.resolve();
    completeHandshake();
    await synapse.ready;

    // Don't await — we only care about the envelope being posted.
    void synapse.callTool("report", { period: "week" });
    await Promise.resolve();

    const env = lastEnvelopeWithMethod("tools/call");
    expect(env).toBeDefined();
    const v = validateAppToHostMessage(env);
    expect(v.ok, `tools/call: ${v.reason}`).toBe(true);
  });

  it("synapse.action emits a schema-valid synapse/action envelope", async () => {
    const { createSynapse } = await import("@nimblebrain/synapse");
    const synapse = createSynapse({ name: "test-app", version: "1.0.0" });
    await Promise.resolve();
    completeHandshake();
    await synapse.ready;

    synapse.action("openConversation", { id: "abc-123" });

    const env = lastEnvelopeWithMethod("synapse/action");
    expect(env).toBeDefined();
    const v = validateAppToHostMessage(env);
    expect(v.ok, `synapse/action: ${v.reason}`).toBe(true);
  });

  it("every envelope captured during a typical session validates", async () => {
    // Aggregate check: nothing the SDK emits across init + a call + an action
    // is allowed to be malformed. This catches drift in envelopes we didn't
    // think to test individually (e.g., size-changed notifications).
    const { createSynapse } = await import("@nimblebrain/synapse");
    const synapse = createSynapse({ name: "test-app", version: "1.0.0" });
    await Promise.resolve();
    completeHandshake();
    await synapse.ready;

    void synapse.callTool("report", {});
    synapse.action("openConversation", { id: "x" });
    await Promise.resolve();

    expectAllCapturedValid();
  });
});
