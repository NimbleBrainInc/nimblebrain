/**
 * Platform `usage` source contract tests.
 *
 * Verifies the per-user / per-org scope model after usage moved off
 * workspace settings to the org/audit surface:
 *   - The ledger is tenant-wide and carries `userId` on the line, so a user's
 *     usage aggregates regardless of which workspace the spend happened in.
 *   - `scope: "user"` (default) is gated to the caller's own spend via the
 *     aggregator's ownerFilter — a member can't see peers' usage.
 *   - `scope: "org"` requires org admin/owner; a member is denied.
 *   - The dev user is an org owner: it reads the org scope on its role, and
 *     its user scope is its own spend.
 *   - The response echoes the resolved `scope`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../../../src/adapters/noop-events.ts";
import type { UsageReportOutput } from "../../../../src/platform/schemas/usage.ts";
import { createUsageSource } from "../../../../src/platform/usage/source.ts";
import type { McpSource } from "../../../../src/tools/mcp-source.ts";
import { usageMonthDir, usageMonthOf } from "../../../../src/usage/paths.ts";
import type { UsageLedgerEntry } from "../../../../src/usage/types.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────

interface FakeIdentity {
  id: string;
  orgRole: "owner" | "admin" | "member";
}

class FakeRuntime {
  identity: FakeIdentity | null = null;

  constructor(private workDir: string) {}

  /** The usage source reads the ledger under the work dir. */
  getWorkDir() {
    return this.workDir;
  }
  getCurrentIdentity() {
    return this.identity;
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
  conversationId: string,
  input: number,
  output: number,
): Promise<void> {
  const dir = usageMonthDir(workDir, usageMonthOf(AT));
  await mkdir(dir, { recursive: true });
  const entry: UsageLedgerEntry = {
    ts: AT,
    source: "main",
    origin: "chat",
    model: "claude-sonnet-4-5-20250929",
    usage: { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 },
    llmMs: 100,
    userId: ownerId,
    workspaceId: wsId,
    conversationId,
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
  await seedSpend(workDir, "ws_00148bca567ef156", "usr_alice", "conv_0000000000000a1c", 100, 50);
  await seedSpend(workDir, "ws_0021762e0e7b3844", "usr_bob", "conv_0000000000000b0b", 400, 200);
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
    runtime.identity = null;

    const client = src.getClient()!;
    const result = await client.callTool({ name: "report", arguments: { period: "all" } });
    expect(result.isError).toBe(true);
  });
});

describe("usage source — scope: org", () => {
  test("org admin sees all users, attributed by owner with groupBy:user", async () => {
    const src = await buildSource();
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
    runtime.identity = { id: "usr_alice", orgRole: "member" };

    const client = src.getClient()!;
    const result = await client.callTool({
      name: "report",
      arguments: { scope: "org", period: "all" },
    });
    expect(result.isError).toBe(true);
  });
});

describe("usage source — the dev user", () => {
  const DEV_USER: FakeIdentity = { id: "usr_default", orgRole: "owner" };

  test("reads the org scope as an org owner", async () => {
    const src = await buildSource();
    runtime.identity = DEV_USER;

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

  test("its user scope is its own spend, not everyone's", async () => {
    const src = await buildSource();
    runtime.identity = DEV_USER;

    const client = src.getClient()!;
    const result = await client.callTool({ name: "report", arguments: { period: "all" } });
    const data = parse(result as { content?: Array<{ type: string; text?: string }> });

    expect(data.totals.conversations).toBe(0);
  });

  test("a call with no identity is refused", async () => {
    const src = await buildSource();
    runtime.identity = null;

    const client = src.getClient()!;
    const result = await client.callTool({ name: "report", arguments: { period: "all" } });
    expect(result.isError).toBe(true);
  });
});

describe("usage source — filters", () => {
  test("a member filtering by another user is refused, not shown an empty report", async () => {
    const src = await buildSource();
    runtime.identity = { id: "usr_alice", orgRole: "member" };

    const client = src.getClient()!;
    const result = await client.callTool({
      name: "report",
      arguments: { period: "all", userId: "usr_bob" },
    });
    expect(result.isError).toBe(true);
  });

  test("a member filtering by themselves gets their own spend", async () => {
    const src = await buildSource();
    runtime.identity = { id: "usr_alice", orgRole: "member" };

    const client = src.getClient()!;
    const result = await client.callTool({
      name: "report",
      arguments: { period: "all", userId: "usr_alice" },
    });
    expect(result.isError).toBeFalsy();
    const data = parse(result as { content?: Array<{ type: string; text?: string }> });
    expect(data.totals.tokens.input).toBe(100);
  });

  test("a member's workspace filter still sees only their own spend", async () => {
    const src = await buildSource();
    runtime.identity = { id: "usr_alice", orgRole: "member" };

    const client = src.getClient()!;
    const result = await client.callTool({
      name: "report",
      arguments: { period: "all", workspaceId: "ws_0021762e0e7b3844" },
    });
    const data = parse(result as { content?: Array<{ type: string; text?: string }> });
    expect(data.totals.llmCalls).toBe(0);
  });

  test("org scope narrows by workspace and user, and groups by workspace", async () => {
    const src = await buildSource();
    runtime.identity = { id: "usr_admin", orgRole: "admin" };

    const client = src.getClient()!;
    const byWorkspace = parse(
      (await client.callTool({
        name: "report",
        arguments: { scope: "org", period: "all", groupBy: "workspace" },
      })) as { content?: Array<{ type: string; text?: string }> },
    );
    expect(byWorkspace.breakdown.map((b) => b.key).sort()).toEqual([
      "ws_00148bca567ef156",
      "ws_0021762e0e7b3844",
    ]);

    const filtered = parse(
      (await client.callTool({
        name: "report",
        arguments: {
          scope: "org",
          period: "all",
          workspaceId: "ws_0021762e0e7b3844",
          userId: "usr_bob",
        },
      })) as { content?: Array<{ type: string; text?: string }> },
    );
    expect(filtered.totals.tokens.input).toBe(400);
  });

  test("the schema rejects an origin outside the enum", async () => {
    const src = await buildSource();
    runtime.identity = { id: "usr_admin", orgRole: "admin" };

    const client = src.getClient()!;
    const result = await client.callTool({
      name: "report",
      arguments: { scope: "org", period: "all", origin: "batch" },
    });
    expect(result.isError).toBe(true);
  });
});
