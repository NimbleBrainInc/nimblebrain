/**
 * Platform `instructions` source contract tests.
 *
 * Verifies the two-scope model after the bundle-side rework:
 *   - Resources `instructions://org` and `instructions://workspace` round-trip
 *     through `InstructionsStore` (callback-form `text` reads on every call).
 *   - The single tool `write_instructions(scope, text)` writes via storage,
 *     fires `notifications/resources/updated` for the matching URI, and
 *     enforces role gates per scope.
 *   - Per-bundle instructions are NOT in this source's surface area —
 *     bundles publish their own `<sourceName>://instructions` resource;
 *     the runtime reads it. Verified at integration tier.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import { InstructionsStore } from "../../../src/instructions/index.ts";
import { McpSource } from "../../../src/tools/mcp-source.ts";
import { createInstructionsSource } from "../../../src/tools/platform/instructions.ts";
import type { Workspace } from "../../../src/workspace/types.ts";

// ── Fake Runtime ────────────────────────────────────────────────────────

interface FakeIdentity {
  id: string;
  email: string;
  displayName: string;
  orgRole: "owner" | "admin" | "member";
  preferences: { timezone: string; locale: string; theme: string };
}

class FakeRuntime {
  identity: FakeIdentity | null = null;
  hasIdentityProvider = false;
  wsId: string | null = null;
  workspaces = new Map<string, Workspace>();

  constructor(private workDir: string) {}

  getInstructionsStore() {
    return new InstructionsStore(this.workDir);
  }
  getCurrentIdentity() {
    return this.identity;
  }
  getIdentityProvider() {
    return this.hasIdentityProvider ? ({} as object) : null;
  }
  requireWorkspaceId(): string {
    if (!this.wsId) throw new Error("no workspace");
    return this.wsId;
  }
  getWorkspaceStore() {
    return {
      get: async (id: string): Promise<Workspace | null> => this.workspaces.get(id) ?? null,
    };
  }

  setMember(wsId: string, userId: string, role: "admin" | "member"): void {
    const ws = this.workspaces.get(wsId);
    if (!ws) {
      this.workspaces.set(wsId, {
        id: wsId,
        name: wsId,
        members: [{ userId, role }],
        bundles: [],
        createdAt: "",
        updatedAt: "",
      });
    } else {
      ws.members = [{ userId, role }];
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

let workDir: string;
let runtime: FakeRuntime;
let source: McpSource | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "instructions-source-test-"));
  runtime = new FakeRuntime(workDir);
});

afterEach(async () => {
  if (source) await source.stop();
  source = undefined;
  await rm(workDir, { recursive: true, force: true });
});

async function buildSource(): Promise<McpSource> {
  source = createInstructionsSource(runtime as unknown as never, new NoopEventSink());
  await source.start();
  return source;
}

function parseStructured(result: { content?: Array<{ type: string; text?: string }> }): unknown {
  const text = result.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ── Resources ───────────────────────────────────────────────────────────

describe("instructions source — resources", () => {
  test("resources/list exposes exactly instructions://org and instructions://workspace", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.listResources();
    const uris = result.resources.map((r) => r.uri).sort();
    expect(uris).toEqual(["instructions://org", "instructions://workspace"]);
  });

  test("instructions://org returns empty body when nothing written", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const data = await client.readResource({ uri: "instructions://org" });
    expect(data.contents?.[0]?.text).toBe("");
  });

  test("instructions://workspace requires a workspace context (throws via callback)", async () => {
    const src = await buildSource();
    runtime.wsId = null;
    const client = src.getClient()!;
    await expect(client.readResource({ uri: "instructions://workspace" })).rejects.toThrow();
  });

  test("instructions://workspace round-trips when wsId is set", async () => {
    const src = await buildSource();
    runtime.wsId = "ws_demo";
    await runtime
      .getInstructionsStore()
      .write({ scope: "workspace", wsId: "ws_demo", text: "ws-body", updatedBy: "ui" });
    const client = src.getClient()!;
    const data = await client.readResource({ uri: "instructions://workspace" });
    expect(data.contents?.[0]?.text).toBe("ws-body");
  });

  test("text is read fresh on every call (no caching)", async () => {
    const src = await buildSource();
    runtime.wsId = "ws_demo";
    const client = src.getClient()!;

    await runtime
      .getInstructionsStore()
      .write({ scope: "workspace", wsId: "ws_demo", text: "v1", updatedBy: "ui" });
    expect(
      (await client.readResource({ uri: "instructions://workspace" })).contents?.[0]?.text,
    ).toBe("v1");

    await runtime
      .getInstructionsStore()
      .write({ scope: "workspace", wsId: "ws_demo", text: "v2", updatedBy: "agent" });
    expect(
      (await client.readResource({ uri: "instructions://workspace" })).contents?.[0]?.text,
    ).toBe("v2");
  });
});

// ── write_instructions tool — happy path + notifications ──────────────

describe("instructions source — write_instructions", () => {
  test("dev mode (no identity provider) allows writes and fires notification", async () => {
    const src = await buildSource();
    runtime.wsId = "ws_demo";

    const updates: Array<{ uri: string }> = [];
    const client = src.getClient()!;
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      updates.push({ uri: n.params.uri as string });
    });

    const result = await client.callTool({
      name: "write_instructions",
      arguments: { scope: "workspace", text: "ws body" },
    });
    expect(result.isError).toBeFalsy();
    expect((result as { structuredContent?: { ok?: boolean } }).structuredContent?.ok).toBe(true);

    const body = await runtime.getInstructionsStore().read({ scope: "workspace", wsId: "ws_demo" });
    expect(body).toBe("ws body");

    await new Promise((r) => setTimeout(r, 0));
    expect(updates).toEqual([{ uri: "instructions://workspace" }]);
  });

  test("empty text clears the overlay", async () => {
    const src = await buildSource();
    runtime.wsId = "ws_demo";
    await runtime
      .getInstructionsStore()
      .write({ scope: "workspace", wsId: "ws_demo", text: "first", updatedBy: "ui" });

    const client = src.getClient()!;
    const result = await client.callTool({
      name: "write_instructions",
      arguments: { scope: "workspace", text: "" },
    });
    expect(result.isError).toBeFalsy();
    expect(
      await runtime.getInstructionsStore().read({ scope: "workspace", wsId: "ws_demo" }),
    ).toBe("");
  });

  test("8KB cap rejection surfaces as isError, never throws", async () => {
    const src = await buildSource();
    runtime.wsId = "ws_demo";
    const client = src.getClient()!;
    const huge = "x".repeat(8 * 1024 + 1);
    const result = await client.callTool({
      name: "write_instructions",
      arguments: { scope: "workspace", text: huge },
    });
    expect(result.isError).toBe(true);
    const parsed = parseStructured(result as { content?: Array<{ type: string; text?: string }> });
    expect(JSON.stringify(parsed)).toContain("8192");
  });

  test("schema rejects unknown scopes (e.g. 'bundles/whatever')", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({
      name: "write_instructions",
      arguments: { scope: "bundles/foo", text: "x" },
    });
    expect(result.isError).toBe(true);
  });
});

// ── Role gates ──────────────────────────────────────────────────────────

describe("instructions source — role gates", () => {
  test("non-admin identity denied for workspace scope", async () => {
    const src = await buildSource();
    runtime.hasIdentityProvider = true;
    runtime.identity = {
      id: "u1",
      email: "u@ex.com",
      displayName: "U",
      orgRole: "member",
      preferences: { timezone: "UTC", locale: "en-US", theme: "system" },
    };
    runtime.wsId = "ws_demo";
    runtime.setMember("ws_demo", "u1", "member");

    const client = src.getClient()!;
    const result = await client.callTool({
      name: "write_instructions",
      arguments: { scope: "workspace", text: "x" },
    });
    expect(result.isError).toBe(true);
  });

  test("workspace admin identity allowed for workspace scope", async () => {
    const src = await buildSource();
    runtime.hasIdentityProvider = true;
    runtime.identity = {
      id: "u1",
      email: "u@ex.com",
      displayName: "U",
      orgRole: "member",
      preferences: { timezone: "UTC", locale: "en-US", theme: "system" },
    };
    runtime.wsId = "ws_demo";
    runtime.setMember("ws_demo", "u1", "admin");

    const client = src.getClient()!;
    const result = await client.callTool({
      name: "write_instructions",
      arguments: { scope: "workspace", text: "ws-body" },
    });
    expect(result.isError).toBeFalsy();
  });

  test("non-admin identity denied for org scope; org owner allowed", async () => {
    const src = await buildSource();
    runtime.hasIdentityProvider = true;
    const client = src.getClient()!;

    runtime.identity = {
      id: "u1",
      email: "u@ex.com",
      displayName: "U",
      orgRole: "member",
      preferences: { timezone: "UTC", locale: "en-US", theme: "system" },
    };
    const denied = await client.callTool({
      name: "write_instructions",
      arguments: { scope: "org", text: "x" },
    });
    expect(denied.isError).toBe(true);

    runtime.identity = {
      ...runtime.identity,
      orgRole: "owner",
    };
    const allowed = await client.callTool({
      name: "write_instructions",
      arguments: { scope: "org", text: "org-policy" },
    });
    expect(allowed.isError).toBeFalsy();
  });
});

// ── Tool list ───────────────────────────────────────────────────────────

describe("instructions source — tool list", () => {
  test("exposes only `write_instructions`", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(["write_instructions"]);
  });

  test("write_instructions description preserves the description-as-policy framing", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const tools = await client.listTools();
    const writeTool = tools.tools.find((t) => t.name === "write_instructions");
    expect(writeTool?.description).toContain("Use this only when the user explicitly asks");
    expect(writeTool?.description).toContain("strongly recurring pattern");
    expect(writeTool?.description).toContain("Empty text clears");
  });

  test("does NOT expose deprecated/old tool names", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).not.toContain("list_settings_overview");
    expect(names).not.toContain("write_instruction");
  });
});

// ── No bundle-list-changed notifications ────────────────────────────────

describe("instructions source — bundle lifecycle", () => {
  test("does NOT emit list-changed notifications (resource catalog is fixed)", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const seen: string[] = [];
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
      seen.push("list_changed");
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual([]);
  });
});
