// ---------------------------------------------------------------------------
// WorkspaceWebhooksTab — the two things this page must never get wrong.
//
// Pins:
//   1. A rotation the connector did NOT register says so, and the warning
//      SURVIVES the panel closing. This is the case that ends in dropped
//      deliveries a grace window later, so a silent close reads as success and
//      nobody acts. The bug this pins was exactly that: the message was set
//      into state the next line unmounted.
//   2. A registration written before delivery ids reports no URL rather than
//      an address ending in "undefined" — plausible, copyable, admitted
//      nowhere, and contradicting the door, which already refuses that record.
// ---------------------------------------------------------------------------

// Deliberately does NOT `mock.module("../context/WorkspaceContext", …)`: bun
// module mocks are process-global, and a partial replacement leaks into every
// other file that imports the real provider. The real provider takes its state
// as props, so there is nothing to gain by mocking it.
import { afterEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface ToolCall {
  source: string;
  tool: string;
  args: Record<string, unknown>;
}

let calls: ToolCall[] = [];
let rotateResult: Record<string, unknown> = { registered: true };
let listed: Array<Record<string, unknown>> = [];

mock.module("../api/client", () => ({
  ...realClient,
  callTool: mock(async (source: string, tool: string, args: Record<string, unknown>) => {
    calls.push({ source, tool, args });
    const payload = tool === "rotate_webhook" ? rotateResult : { webhooks: listed };
    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
  }),
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { WorkspaceProvider } = await import("../context/WorkspaceContext");
const { WorkspaceWebhooksTab } = await import("../pages/settings/WorkspaceWebhooksTab");

import type { WorkspaceInfo } from "../context/WorkspaceContext";

const WS: WorkspaceInfo = {
  id: "ws_outbound",
  name: "Outbound",
  bundles: [],
  memberCount: 1,
  isPersonal: false,
  userRole: "admin",
};

let unmount: (() => void) | null = null;

function hook(over: Record<string, unknown> = {}) {
  return {
    connector: "acme-billing-mcp",
    vendor: "acme",
    route: "/ingest/acme",
    url: "https://example.invalid/v1/hooks/an-opaque-delivery-id",
    createdAt: "2026-01-01T00:00:00.000Z",
    rotatedAt: null,
    previousStillValid: false,
    ...over,
  };
}

async function mount(): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        WorkspaceProvider,
        { initialWorkspaces: [WS], initialActiveId: WS.id },
        React.createElement(WorkspaceWebhooksTab),
      ),
    );
  });
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  return container;
}

function click(container: HTMLElement, label: string): Promise<void> {
  const button = Array.from(container.getElementsByTagName("button")).find((b) =>
    (b.textContent ?? "").includes(label),
  );
  if (!button) throw new Error(`no button labelled ${label}`);
  return act(async () => {
    button.click();
  });
}

afterEach(() => {
  unmount?.();
  unmount = null;
  calls = [];
  rotateResult = { registered: true };
  listed = [];
});

describe("a rotation the connector did not take", () => {
  test("says so, and the warning outlives the panel that started it", async () => {
    listed = [hook()];
    rotateResult = { registered: false, error: null };
    const container = await mount();

    await click(container, "Rotate");
    await click(container, "Rotate now");

    const text = container.textContent ?? "";
    expect(text).toContain("did not register the new URL");
    // The panel closes — the rotation DID happen — but the outcome stays put.
    expect(text).not.toContain("Rotate now");
  });

  test("a registered rotation leaves no warning behind", async () => {
    listed = [hook()];
    rotateResult = { registered: true };
    const container = await mount();

    await click(container, "Rotate");
    await click(container, "Rotate now");

    expect(container.textContent ?? "").not.toContain("did not register");
  });

  test("rotating sends no confirm field", async () => {
    listed = [hook()];
    const container = await mount();
    await click(container, "Rotate");
    await click(container, "Rotate now");

    const rotate = calls.find((c) => c.tool === "rotate_webhook");
    expect(rotate?.args).toEqual({ connector: "acme-billing-mcp", vendor: "acme" });
  });
});

describe("a registration with no delivery id", () => {
  test("reports no URL instead of one the door would refuse", async () => {
    listed = [hook({ url: null })];
    const container = await mount();

    const text = container.textContent ?? "";
    expect(text).not.toContain("undefined");
    expect(text).toContain("Rotate to mint one");
  });
});
