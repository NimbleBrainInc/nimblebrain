/**
 * Platform `usage` source contract tests.
 *
 * Verifies the per-user / per-org scope model after usage moved off
 * workspace settings to the org/audit surface:
 *   - The tool reads the TOP-LEVEL conversations dir (not workspace-scoped),
 *     so it sees conversations regardless of workspace.
 *   - `scope: "user"` (default) is gated to the caller's own conversations
 *     via the aggregator's ownerFilter — a member can't see peers' usage.
 *   - `scope: "org"` requires org admin/owner; a member is denied.
 *   - Dev mode (no identity provider) bypasses the gate and sees everything.
 *   - The response echoes the resolved `scope`.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NoopEventSink } from "../../../../src/adapters/noop-events.ts";
import type { McpSource } from "../../../../src/tools/mcp-source.ts";
import { createUsageSource } from "../../../../src/tools/platform/usage.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────

interface FakeIdentity {
  id: string;
  orgRole: "owner" | "admin" | "member";
}

class FakeRuntime {
  identity: FakeIdentity | null = null;
  hasIdentityProvider = false;

  constructor(private convDir: string) {}

  getConversationsDir(): string {
    return this.convDir;
  }
  getCurrentIdentity() {
    return this.identity;
  }
  getIdentityProvider() {
    return this.hasIdentityProvider ? ({} as object) : null;
  }
}

function llmEvent(input: number, output: number): Record<string, unknown> {
  return {
    type: "llm.response",
    ts: "2026-04-10T12:00:00Z",
    model: "claude-sonnet-4-5-20250929",
    usage: { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 },
    llmMs: 100,
  };
}

function convJsonl(id: string, ownerId: string, input: number, output: number): string {
  const meta = JSON.stringify({ id, ownerId, updatedAt: "2026-04-10T14:00:00Z" });
  return `${meta}\n${JSON.stringify(llmEvent(input, output))}\n`;
}

// ── Setup ───────────────────────────────────────────────────────────────

let convDir: string;
let runtime: FakeRuntime;
let source: McpSource | undefined;

beforeEach(async () => {
  convDir = await mkdtemp(join(tmpdir(), "usage-source-test-"));
  runtime = new FakeRuntime(convDir);
  // Two owners: alice has 100/50, bob has 400/200.
  await writeFile(join(convDir, "alice.jsonl"), convJsonl("conv_a", "usr_alice", 100, 50));
  await writeFile(join(convDir, "bob.jsonl"), convJsonl("conv_b", "usr_bob", 400, 200));
});

afterEach(async () => {
  if (source) await source.stop();
  source = undefined;
  await rm(convDir, { recursive: true, force: true });
});

async function buildSource(): Promise<McpSource> {
  source = createUsageSource(runtime as unknown as never, new NoopEventSink());
  await source.start();
  return source;
}

interface UsageResult {
  scope: "user" | "org";
  totals: { tokens: { input: number; output: number }; conversations: number };
  breakdown: Array<{ key: string }>;
}

function parse(result: { content?: Array<{ type: string; text?: string }> }): UsageResult {
  const text = result.content?.[0]?.text ?? "{}";
  return JSON.parse(text) as UsageResult;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("usage source — scope: user", () => {
  test("members see only their own conversations (ownerFilter)", async () => {
    const src = await buildSource();
    runtime.hasIdentityProvider = true;
    runtime.identity = { id: "usr_alice", orgRole: "member" };

    const client = src.getClient()!;
    const result = await client.callTool({
      name: "report",
      arguments: { scope: "user", period: "all" },
    });
    expect(result.isError).toBeFalsy();

    const data = parse(result as { content?: Array<{ type: string; text?: string }> });
    expect(data.scope).toBe("user");
    // Only alice's 100 input — bob's 400 is excluded.
    expect(data.totals.tokens.input).toBe(100);
    expect(data.totals.conversations).toBe(1);
  });

  test("defaults to user scope when scope omitted", async () => {
    const src = await buildSource();
    runtime.hasIdentityProvider = true;
    runtime.identity = { id: "usr_bob", orgRole: "member" };

    const client = src.getClient()!;
    const result = await client.callTool({ name: "report", arguments: { period: "all" } });
    const data = parse(result as { content?: Array<{ type: string; text?: string }> });

    expect(data.scope).toBe("user");
    expect(data.totals.tokens.input).toBe(400);
    expect(data.totals.conversations).toBe(1);
  });

  test("unauthenticated caller (provider present, no identity) is denied", async () => {
    const src = await buildSource();
    runtime.hasIdentityProvider = true;
    runtime.identity = null;

    const client = src.getClient()!;
    const result = await client.callTool({ name: "report", arguments: { period: "all" } });
    expect(result.isError).toBe(true);
  });
});

describe("usage source — scope: org", () => {
  test("org admin sees all users, attributed by owner with groupBy:user", async () => {
    const src = await buildSource();
    runtime.hasIdentityProvider = true;
    runtime.identity = { id: "usr_admin", orgRole: "admin" };

    const client = src.getClient()!;
    const result = await client.callTool({
      name: "report",
      arguments: { scope: "org", period: "all", groupBy: "user" },
    });
    expect(result.isError).toBeFalsy();

    const data = parse(result as { content?: Array<{ type: string; text?: string }> });
    expect(data.scope).toBe("org");
    // Both owners aggregated: 100 + 400 input, 2 conversations.
    expect(data.totals.tokens.input).toBe(500);
    expect(data.totals.conversations).toBe(2);
    expect(data.breakdown.map((b) => b.key).sort()).toEqual(["usr_alice", "usr_bob"]);
  });

  test("member is denied org scope", async () => {
    const src = await buildSource();
    runtime.hasIdentityProvider = true;
    runtime.identity = { id: "usr_alice", orgRole: "member" };

    const client = src.getClient()!;
    const result = await client.callTool({
      name: "report",
      arguments: { scope: "org", period: "all" },
    });
    expect(result.isError).toBe(true);
  });
});

describe("usage source — dev mode", () => {
  test("no identity provider: org scope sees everything without a gate", async () => {
    const src = await buildSource();
    runtime.hasIdentityProvider = false;
    runtime.identity = null;

    const client = src.getClient()!;
    const result = await client.callTool({
      name: "report",
      arguments: { scope: "org", period: "all", groupBy: "user" },
    });
    expect(result.isError).toBeFalsy();

    const data = parse(result as { content?: Array<{ type: string; text?: string }> });
    expect(data.totals.tokens.input).toBe(500);
    expect(data.totals.conversations).toBe(2);
  });

  test("no identity provider: user scope is unfiltered (dev sees all)", async () => {
    const src = await buildSource();
    runtime.hasIdentityProvider = false;
    runtime.identity = null;

    const client = src.getClient()!;
    const result = await client.callTool({ name: "report", arguments: { period: "all" } });
    const data = parse(result as { content?: Array<{ type: string; text?: string }> });

    // Dev mode: no ownerFilter, so both conversations are visible.
    expect(data.totals.conversations).toBe(2);
  });
});
