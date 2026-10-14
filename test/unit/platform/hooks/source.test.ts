/**
 * The webhook settings tools.
 *
 * Two properties carry the design and both are asserted here: a delivery URL is
 * a capability, so no agent may list it and no non-admin may read it.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { EventSink } from "../../../../src/engine/types.ts";
import { isModelVisible } from "../../../../src/engine/types.ts";
import { buildHookUrl } from "../../../../src/hooks/token.ts";
import type { HookDeclaration, HookRegistration } from "../../../../src/hooks/types.ts";
import { createHooksSource } from "../../../../src/platform/hooks/source.ts";
import type { HooksListOutput, HooksRotateOutput } from "../../../../src/platform/schemas/hooks.ts";
import type { Runtime } from "../../../../src/runtime/runtime.ts";
import type { ConnectorPort } from "../../../../src/tools/connector-surface.ts";
import type { McpSource } from "../../../../src/tools/mcp-source.ts";
import type { Tool, ToolResult } from "../../../../src/tools/types.ts";
import type { Workspace } from "../../../../src/workspace/types.ts";
import type { WorkspaceStore } from "../../../../src/workspace/workspace-store.ts";
import { makeIdentity } from "../../../helpers/identity.ts";
import { stub } from "../../../helpers/stub.ts";
import { makeWorkspace } from "../../../helpers/test-workspace.ts";

const WS = "ws_005b519ef7efc353";
const USER = "usr_admin";
const DELIVERY_ID = "a-delivery-id-that-is-the-whole-capability";

function reg(over: Partial<HookRegistration> = {}): HookRegistration {
  return {
    connector: "acme-billing-mcp",
    vendor: "acme",
    kid: "hk_current0000001",
    deliveryId: DELIVERY_ID,
    createdAt: "2026-01-01T00:00:00.000Z",
    route: "/ingest/acme",
    ...over,
  };
}

class FakeRuntime {
  identity: { id: string } | null = { id: USER };
  wsId: string | null = WS;
  workspaces = new Map<string, Workspace>();

  getCurrentIdentity() {
    return this.identity && makeIdentity(this.identity);
  }
  getCurrentWorkspaceId() {
    return this.wsId;
  }
  getWorkspaceStore() {
    return stub<WorkspaceStore>({ get: async (id: string) => this.workspaces.get(id) ?? null });
  }
  /** What `ensureHooks` will find. Empty = the connector is not running. */
  hookPorts = new Map<string, ConnectorPort>();
  /** What the connector declares. Empty = it declares no inbound hook. */
  declarations: HookDeclaration[] = [];
  getHookReconcileDeps() {
    return {
      workspaceStore: stub<WorkspaceStore>({
        get: async (id: string) => this.workspaces.get(id) ?? null,
        update: async (id: string, patch: Partial<Workspace>) => {
          const ws = this.workspaces.get(id);
          if (!ws) return null;
          const next = { ...ws, ...patch };
          this.workspaces.set(id, next);
          return next;
        },
      }),
      identity: { tid: "tenant-a", key: Buffer.alloc(32, 7) },
      declarationsFor: async () => this.declarations,
      portFor: (_wsId: string, name: string) => this.hookPorts.get(name),
    };
  }

  seed(role: "admin" | "member", hooks: Record<string, HookRegistration>): void {
    this.workspaces.set(
      WS,
      makeWorkspace({
        id: WS,
        members: [{ userId: USER, role }],
        connectors: [{ url: "https://acme.example/mcp", serverName: "acme-billing-mcp" }],
        hooks,
      }),
    );
  }

  /** A running connector that declares the stream, answering its register tool with `answer`. */
  runConnector(
    answer: ToolResult = { content: [], isError: false },
  ): Array<Record<string, unknown>> {
    const handed: Array<Record<string, unknown>> = [];
    this.declarations = [
      { vendor: "acme", route: "/ingest/acme", register_tool: "set_webhook_url" },
    ];
    const registerTool: Tool = {
      name: "set_webhook_url",
      description: "Register a webhook URL",
      inputSchema: {
        type: "object",
        properties: { vendor: { type: "string" }, url: { type: "string" } },
        required: ["vendor", "url"],
      },
      source: "acme-billing-mcp",
    };
    this.hookPorts.set("acme-billing-mcp", {
      tools: async () => [registerTool],
      execute: async (_name, input) => {
        handed.push(input);
        return answer;
      },
    });
    return handed;
  }
}

let runtime: FakeRuntime;
let source: McpSource;

const noopSink: EventSink = { emit: () => {} };

beforeEach(async () => {
  runtime = new FakeRuntime();
  source = createHooksSource(stub<Runtime>(runtime), noopSink);
  await source.start();
  // List first, as the engine does: the SDK client validates a result against
  // its tool's output schema only once it holds the `tools/list` that declares it.
  await source.tools();
});

/** The text a reader gets, which the structured result restates and never extends. */
function textOf(res: ToolResult): string {
  return (res.content?.[0] as { text?: string } | undefined)?.text ?? "";
}

/** Fail with the result's own text, which names an output-schema mismatch when there is one. */
function expectSuccess(res: ToolResult): void {
  if (res.isError) throw new Error(`expected a success, got: ${textOf(res)}`);
}

async function list(): Promise<HooksListOutput> {
  const res = await source.execute("list_webhooks", {});
  expectSuccess(res);
  return JSON.parse(textOf(res)) as HooksListOutput;
}

describe("the webhook tools are not agent capabilities", () => {
  test("both are app-only, so no LLM listing carries them", async () => {
    const tools = await source.tools();
    // Namespaced on the wire, which is the name the settings page calls.
    expect(tools.map((t) => t.name).sort()).toEqual([
      "hooks__list_webhooks",
      "hooks__rotate_webhook",
    ]);
    // A delivery URL is a capability. An agent that could read one could put it
    // in a message, a file, or an outbound email — handing a working capability
    // to whoever received it. An admin reading it off their own screen cannot.
    for (const tool of tools) {
      expect(isModelVisible(tool)).toBe(false);
    }
  });
});

async function rotate(): Promise<{ isError?: boolean; text: string; res: ToolResult }> {
  const res = await source.execute("rotate_webhook", {
    connector: "acme-billing-mcp",
    vendor: "acme",
  });
  return { isError: res.isError, text: textOf(res), res };
}

describe("a rotation that did not happen is not reported as one", () => {
  test("refuses when the connector is not running, and says the old URL is live", async () => {
    // The realistic shape: the tab lists from the store and never consults
    // liveness, so an admin can press Rotate against a stopped connector. If
    // that answered with the re-read record it would hand back the CURRENT url
    // as the new one — and this control is reached when a URL has leaked.
    runtime.seed("admin", { "acme-billing-mcp:acme": reg() });
    const out = await rotate();
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Nothing was rotated");
    expect(out.text).toContain("still live");
    // And nothing moved.
    const after = (await list()).webhooks;
    expect(after[0]?.url).toBe(buildHookUrl(DELIVERY_ID));
  });
});

describe("the grace window the page reports is the one the door enforces", () => {
  const rotatedAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

  test("an open window says the previous URL still works", async () => {
    runtime.seed("admin", {
      "acme-billing-mcp:acme": reg({ prevDeliveryId: "older-id", rotatedAt: rotatedAgo(60_000) }),
    });
    const webhooks = (await list()).webhooks;
    expect(webhooks[0]?.previousStillValid).toBe(true);
  });

  test("a closed window does not, however long ago the rotation was", async () => {
    // Neither prevDeliveryId nor rotatedAt is ever cleared, so a rotation from
    // last year still carries both. Reading them as "still valid" would tell an
    // admin it is safe to defer re-registering at the vendor, indefinitely,
    // while the door drops every delivery to the old URL.
    runtime.seed("admin", {
      "acme-billing-mcp:acme": reg({
        prevDeliveryId: "older-id",
        rotatedAt: rotatedAgo(25 * 60 * 60 * 1000),
      }),
    });
    const webhooks = (await list()).webhooks;
    expect(webhooks[0]?.previousStillValid).toBe(false);
  });
});

describe("a registration that predates delivery ids", () => {
  test("reports no URL rather than one the door would refuse", async () => {
    // buildHookUrl on a missing id yields an address ending in "undefined" —
    // copyable, plausible, and admitted nowhere. The door already refuses this
    // record; the page has to say the same thing, or an admin pastes a dead
    // address into a vendor console and gets no error from anyone.
    const { deliveryId: _dropped, ...stale } = reg();
    runtime.seed("admin", { "acme-billing-mcp:acme": stale });
    const webhooks = (await list()).webhooks;
    expect(webhooks[0]?.url).toBeNull();
    expect(JSON.stringify(webhooks)).not.toContain("undefined");
  });
});

describe("reading a delivery URL", () => {
  test("an admin gets the full address, which is what makes the page useful", async () => {
    runtime.seed("admin", { "acme-billing-mcp:acme": reg() });
    const out = await list();
    const webhooks = out.webhooks;
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0]?.url).toBe(buildHookUrl(DELIVERY_ID));
    expect(webhooks[0]?.vendor).toBe("acme");
  });

  test("a member is refused, and the URL is not in the refusal", async () => {
    runtime.seed("member", { "acme-billing-mcp:acme": reg() });
    const res = await source.execute("list_webhooks", {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain(DELIVERY_ID);
    expect(JSON.stringify(res.structuredContent ?? {})).not.toContain(DELIVERY_ID);
  });

  test("no identity is refused", async () => {
    runtime.seed("admin", { "acme-billing-mcp:acme": reg() });
    runtime.identity = null;
    expect((await source.execute("list_webhooks", {})).isError).toBe(true);
  });

  test("a workspace holding no streams is an empty list, not an error", async () => {
    runtime.seed("admin", {});
    const out = await list();
    expect(out.count).toBe(0);
  });
});

describe("rotation refuses before it acts", () => {
  test("a member cannot rotate", async () => {
    runtime.seed("member", { "acme-billing-mcp:acme": reg() });
    const res = await source.execute("rotate_webhook", {
      connector: "acme-billing-mcp",
      vendor: "acme",
    });
    expect(res.isError).toBe(true);
  });

  test("a stream this workspace does not hold is refused", async () => {
    runtime.seed("admin", {});
    const res = await source.execute("rotate_webhook", {
      connector: "acme-billing-mcp",
      vendor: "acme",
    });
    expect(res.isError).toBe(true);
  });
});

describe("a result carries the same object as text and as structured content", () => {
  test("list: the structured result is the text, checked against the output schema", async () => {
    runtime.seed("admin", {
      "acme-billing-mcp/acme": reg({
        prevDeliveryId: "older-id",
        rotatedAt: new Date().toISOString(),
      }),
      "acme-billing-mcp/legacy": (() => {
        const { deliveryId: _dropped, ...stale } = reg({ vendor: "legacy" });
        return stale;
      })(),
    });
    const res = await source.execute("list_webhooks", {});
    expectSuccess(res);
    const out = res.structuredContent as HooksListOutput;
    expect(out).toEqual(JSON.parse(textOf(res)));
    expect(out.count).toBe(2);
    // A registration from before delivery ids, and one never rotated: both are
    // shapes the store holds, and both pass the output schema.
    expect(out.webhooks.map((w) => [w.vendor, w.url === null, w.rotatedAt === null])).toEqual([
      ["acme", false, false],
      ["legacy", true, true],
    ]);
  });

  test("rotate: a rotation the connector accepted reports the new URL", async () => {
    // Keyed as `registrationKey` keys it, so the rotation replaces this record.
    runtime.seed("admin", { "acme-billing-mcp/acme": reg() });
    const handed = runtime.runConnector();
    const out = await rotate();
    expectSuccess(out.res);
    const data = out.res.structuredContent as HooksRotateOutput;
    expect(data).toEqual(JSON.parse(out.text));
    expect(data.registered).toBe(true);
    expect(data.error).toBeNull();
    expect(data.previousStillValid).toBe(true);
    // The URL reported is the one the connector was handed and the store holds.
    expect(data.url).not.toBe(buildHookUrl(DELIVERY_ID));
    expect(handed[0]?.url).toBe(data.url);
    expect((await list()).webhooks[0]?.url).toBe(data.url as string);
  });

  test("rotate: a connector that refused the URL is a success that says so", async () => {
    runtime.seed("admin", { "acme-billing-mcp/acme": reg() });
    runtime.runConnector({ content: [{ type: "text", text: "vendor is down" }], isError: true });
    const out = await rotate();
    expectSuccess(out.res);
    const data = out.res.structuredContent as HooksRotateOutput;
    expect(data).toEqual(JSON.parse(out.text));
    expect(data.registered).toBe(false);
    expect(typeof data.error).toBe("string");
  });
});
