/**
 * Platform `usage` source contract tests.
 *
 * Verifies the per-user / per-org scope model after usage moved off
 * workspace settings to the org/audit surface:
 *   - The tool walks every workspace's conversation files (across workspaces /
 *     owner partitions), so it sees a user's usage regardless of which workspace
 *     a conversation lived in.
 *   - `scope: "user"` (default) is gated to the caller's own conversations
 *     via the aggregator's ownerFilter — a member can't see peers' usage.
 *   - `scope: "org"` requires org admin/owner; a member is denied.
 *   - Dev mode (no identity provider) bypasses the gate and sees everything.
 *   - The response echoes the resolved `scope`.
 */

import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NoopEventSink } from "../../../../src/adapters/noop-events.ts";
import type { McpSource } from "../../../../src/tools/mcp-source.ts";
import { usageMonthDir, usageMonthOf } from "../../../../src/usage/paths.ts";
import type { UsageLedgerEntry } from "../../../../src/usage/types.ts";
import type { UsageReportOutput } from "../../../../src/tools/platform/schemas/usage.ts";
import { createUsageSource } from "../../../../src/tools/platform/usage.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────

interface FakeIdentity {
  id: string;
  orgRole: "owner" | "admin" | "member";
}

class FakeRuntime {
  identity: FakeIdentity | null = null;
  hasIdentityProvider = false;

  constructor(private workDir: string) {}

  /** The usage source reads the ledger under the work dir. */
  getWorkDir() {
    return this.workDir;
  }
  getCurrentIdentity() {
    return this.identity;
  }
  getIdentityProvider() {
    return this.hasIdentityProvider ? ({} as object) : null;
  }
}

const AT = "2026-04-10T12:00:00Z";

/**
 * Seed one user's spend into the ledger.
 *
 * The tool used to walk every workspace's conversation files to find a user's
 * usage across workspaces; the ledger carries `userId` and `workspaceId` on the
 * line, so there is nothing to walk and the owner scoping is a field predicate.
 * The `workspaceId` is kept on the fixture because the calls really did happen
 * in different workspaces — that a cross-workspace read still aggregates by
 * owner is the property these tests exist for.
 */
async function seedSpend(
  workDir: string,
  wsId: string,
  ownerId: string,
  sessionId: string,
  input: number,
  output: number,
): Promise<void> {
  const dir = usageMonthDir(workDir, usageMonthOf(AT));
  await mkdir(dir, { recursive: true });
  const entry: UsageLedgerEntry = {
    ts: AT,
    source: "main",
    origin: "chat",
    delegated: false,
    model: "claude-sonnet-4-5-20250929",
    usage: { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 },
    llmMs: 100,
    userId: ownerId,
    workspaceId: wsId,
    sessionId,
  };
  await appendFile(join(dir, "test.jsonl"), `${JSON.stringify(entry)}\n`);
}

// ── Setup ───────────────────────────────────────────────────────────────

let workDir: string;
let runtime: FakeRuntime;
let source: McpSource | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "usage-source-test-"));
  runtime = new FakeRuntime(workDir);
  // Two owners in two different workspaces — usage must aggregate by owner ACROSS
  // workspaces via the cross-workspace walk. alice has 100/50, bob has 400/200.
  await seedSpend(workDir, "ws_alice", "usr_alice", "conv_0000000000000a1c", 100, 50);
  await seedSpend(workDir, "ws_bob", "usr_bob", "conv_0000000000000b0b", 400, 200);
});

afterEach(async () => {
  if (source) await source.stop();
  source = undefined;
  await rm(workDir, { recursive: true, force: true });
});

async function buildSource(): Promise<McpSource> {
  source = createUsageSource(runtime as unknown as never, new NoopEventSink());
  await source.start();
  return source;
}

function parse(result: { content?: Array<{ type: string; text?: string }> }): UsageReportOutput {
  const text = result.content?.[0]?.text ?? "{}";
  return JSON.parse(text) as UsageReportOutput;
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

  test("org admin can request user and day breakdowns in one report", async () => {
    const src = await buildSource();
    runtime.hasIdentityProvider = true;
    runtime.identity = { id: "usr_admin", orgRole: "admin" };

    const client = src.getClient()!;
    const result = await client.callTool({
      name: "report",
      arguments: { scope: "org", period: "all", groupBy: ["user", "day"] },
    });
    expect(result.isError).toBeFalsy();

    const data = parse(result as { content?: Array<{ type: string; text?: string }> });
    expect(data.scope).toBe("org");
    expect(data.breakdown.map((b) => b.key).sort()).toEqual(["usr_alice", "usr_bob"]);
    expect(data.breakdowns.user?.map((b) => b.key).sort()).toEqual(["usr_alice", "usr_bob"]);
    expect(data.breakdowns.day?.map((b) => b.key)).toEqual(["2026-04-10"]);
    expect(data.totals.tokens.input).toBe(500);
    expect(data.totals.conversations).toBe(2);
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
