/**
 * The webhook settings tools.
 *
 * Two properties carry the design and both are asserted here: a delivery URL is
 * a capability, so no agent may list it and no non-admin may read it.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { isInternalTool } from "../../../../src/engine/types.ts";
import { buildHookUrl } from "../../../../src/hooks/token.ts";
import type { HookRegistration } from "../../../../src/hooks/types.ts";
import { createHooksSource } from "../../../../src/tools/platform/hooks.ts";
import type { McpSource } from "../../../../src/tools/mcp-source.ts";
import type { Workspace } from "../../../../src/workspace/types.ts";

const WS = "ws_outbound";
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
    return this.identity;
  }
  getCurrentWorkspaceId() {
    return this.wsId;
  }
  getWorkspaceStore() {
    return { get: async (id: string) => this.workspaces.get(id) ?? null };
  }
  /** What `ensureHooks` will find. Empty = the connector is not running. */
  hookPorts = new Map<string, unknown>();
  getHookReconcileDeps() {
    return {
      workspaceStore: {
        get: async (id: string) => this.workspaces.get(id) ?? null,
        update: async () => undefined,
      },
      identity: { tid: "tenant-a", key: Buffer.alloc(32, 7) },
      declarationsFor: () => [],
      portFor: (name: string) => this.hookPorts.get(name),
    };
  }

  seed(role: "admin" | "member", hooks: Record<string, HookRegistration>): void {
    this.workspaces.set(WS, {
      id: WS,
      name: WS,
      members: [{ userId: USER, role }],
      bundles: [],
      hooks,
      createdAt: "",
      updatedAt: "",
    } as unknown as Workspace);
  }
}

let runtime: FakeRuntime;
let source: McpSource;

const noopSink = { emit: () => {} } as unknown as never;

beforeEach(async () => {
  runtime = new FakeRuntime();
  source = createHooksSource(runtime as unknown as never, noopSink);
  await source.start();
});

async function list(): Promise<Record<string, unknown>> {
  const res = await source.execute("list_webhooks", {});
  const text = (res.content?.[0] as { text?: string } | undefined)?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

describe("the webhook tools are not agent capabilities", () => {
  test("both are internal, so no LLM listing carries them", async () => {
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
      expect(isInternalTool(tool)).toBe(true);
    }
  });
});

async function rotate(): Promise<{ isError?: boolean; text: string }> {
  const res = await source.execute("rotate_webhook", {
    connector: "acme-billing-mcp",
    vendor: "acme",
  });
  return {
    isError: res.isError,
    text: (res.content?.[0] as { text?: string } | undefined)?.text ?? "",
  };
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
    const after = (await list()).webhooks as Array<Record<string, unknown>>;
    expect(after[0]?.url).toBe(buildHookUrl(DELIVERY_ID));
  });
});

describe("the grace window the page reports is the one the door enforces", () => {
  const rotatedAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

  test("an open window says the previous URL still works", async () => {
    runtime.seed("admin", {
      "acme-billing-mcp:acme": reg({ prevDeliveryId: "older-id", rotatedAt: rotatedAgo(60_000) }),
    });
    const webhooks = (await list()).webhooks as Array<Record<string, unknown>>;
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
    const webhooks = (await list()).webhooks as Array<Record<string, unknown>>;
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
    runtime.seed("admin", { "acme-billing-mcp:acme": stale as never });
    const webhooks = (await list()).webhooks as Array<Record<string, unknown>>;
    expect(webhooks[0]?.url).toBeNull();
    expect(JSON.stringify(webhooks)).not.toContain("undefined");
  });
});

describe("reading a delivery URL", () => {
  test("an admin gets the full address, which is what makes the page useful", async () => {
    runtime.seed("admin", { "acme-billing-mcp:acme": reg() });
    const out = await list();
    const webhooks = out.webhooks as Array<Record<string, unknown>>;
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0]?.url).toBe(buildHookUrl(DELIVERY_ID));
    expect(webhooks[0]?.vendor).toBe("acme");
  });

  test("a member is refused, and the URL is not in the refusal", async () => {
    runtime.seed("member", { "acme-billing-mcp:acme": reg() });
    const res = await source.execute("list_webhooks", {});
    expect(res.isError).toBe(true);
    const body = (res.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(body).not.toContain(DELIVERY_ID);
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
