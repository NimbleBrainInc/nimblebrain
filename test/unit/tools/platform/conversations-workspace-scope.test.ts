/**
 * The conversations app door is walled to ONE workspace.
 *
 * Conversations are workspace-owned, and `conversations__*` dispatches through
 * the IDENTITY door — so `scope.workspaceId` is the personal/session workspace,
 * not the workspace the user is looking at. The focused workspace therefore
 * rides `RequestContext.focusedWorkspaceId`, exactly as it does for `files__*` and
 * `automations__*` (see `test/unit/bundles/files/source.test.ts`).
 *
 * These tests pin the property that matters: the workspace a read lands in is
 * AMBIENT and validated, never a coordinate the caller supplies. A client that
 * omits it does not get a cross-workspace read, and a client that names another
 * workspace does not get that workspace.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../../../src/adapters/noop-events.ts";
import { ConversationLocator } from "../../../../src/conversation/locator.ts";
import type { ToolResult } from "../../../../src/engine/types.ts";
import { runWithRequestContext } from "../../../../src/runtime/request-context.ts";
import type { Runtime } from "../../../../src/runtime/runtime.ts";
import type { McpSource } from "../../../../src/tools/mcp-source.ts";
import { createConversationsSource } from "../../../../src/tools/platform/conversations.ts";
import {
  ConversationsListInput,
  ConversationsSearchInput,
  ConversationsStatsInput,
} from "../../../../src/tools/platform/schemas/conversations.ts";

const OWNER_ID = "usr_test";
const PEER_ID = "usr_peer";
/** Must match `personalWorkspaceIdFor(OWNER_ID)` — the personal-workspace derivation. */
const WS_PERSONAL = `ws_user_${OWNER_ID}`;
const WS_A = "ws_aaaaaaaaaaaaaaaa";
const WS_B = "ws_bbbbbbbbbbbbbbbb";

let workDir: string;
let source: McpSource;

interface ConvSpec {
  id: string;
  wsId: string;
  ownerId?: string;
  /** Omit to write a legacy record with NO stamped workspace. */
  stampWorkspace?: boolean;
  updatedAt?: string;
  message?: string;
}

function writeConv(spec: ConvSpec): void {
  const ownerId = spec.ownerId ?? OWNER_ID;
  const dir = join(workDir, "workspaces", spec.wsId, "conversations", ownerId);
  mkdirSync(dir, { recursive: true });
  const ts = spec.updatedAt ?? "2026-01-01T00:00:00.000Z";
  const meta: Record<string, unknown> = {
    id: spec.id,
    createdAt: ts,
    updatedAt: ts,
    title: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    lastModel: null,
    ownerId,
  };
  if (spec.stampWorkspace !== false) meta.workspaceId = spec.wsId;
  const lines = [
    JSON.stringify(meta),
    JSON.stringify({ role: "user", content: spec.message ?? `hello from ${spec.wsId}` }),
  ];
  writeFileSync(join(dir, `${spec.id}.jsonl`), `${lines.join("\n")}\n`);
}

function makeRuntime(): Runtime {
  return {
    getCurrentIdentity: () => ({ id: OWNER_ID }),
    resolveRequestUserId: (identity?: { id: string }) => identity?.id ?? OWNER_ID,
    getWorkspaceStore: () => ({ getWorkspacesDir: () => join(workDir, "workspaces") }),
    onConversationsChanged: () => {},
  } as unknown as Runtime;
}

/** Run a conversations tool with `wsId` as the request's focused workspace. */
function exec(
  tool: string,
  args: Record<string, unknown>,
  wsId: string | undefined,
): Promise<ToolResult> {
  return runWithRequestContext(
    {
      identity: { id: OWNER_ID } as never,
      scope: { kind: "identity" },
      ...(wsId ? { focusedWorkspaceId: wsId } : {}),
    },
    () => source.execute(tool, args),
  );
}

function payload(result: ToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected a text block");
  return JSON.parse(first.text) as Record<string, unknown>;
}

function idsOf(result: ToolResult): string[] {
  const data = payload(result) as { conversations?: Array<{ id: string }> };
  return (data.conversations ?? []).map((c) => c.id).sort();
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "nb-conv-scope-"));
  // Two shared workspaces, the owner's personal workspace, a legacy record with
  // no stamped workspace sitting in the personal partition, and a peer's
  // conversation in WS_A (the ownership gate must still hold inside a workspace).
  writeConv({ id: "conv_a1", wsId: WS_A, updatedAt: "2026-01-05T00:00:00.000Z" });
  writeConv({ id: "conv_a2", wsId: WS_A, updatedAt: "2026-01-04T00:00:00.000Z" });
  writeConv({ id: "conv_b1", wsId: WS_B, updatedAt: "2026-01-03T00:00:00.000Z" });
  writeConv({ id: "conv_p1", wsId: WS_PERSONAL, updatedAt: "2026-01-02T00:00:00.000Z" });
  writeConv({
    id: "conv_legacy",
    wsId: WS_PERSONAL,
    stampWorkspace: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  writeConv({ id: "conv_peer", wsId: WS_A, ownerId: PEER_ID });
  source = await createConversationsSource(makeRuntime(), new NoopEventSink());
  await source.start();
});

afterEach(async () => {
  await source.stop();
  rmSync(workDir, { recursive: true, force: true });
});

describe("the door exposes no workspace coordinate", () => {
  // The guard against reintroducing the bug rather than the bug's effect: as
  // soon as `workspaceId` is back on the input schema, a client can omit it,
  // and "omitted" is what produced a full-tenant read. The workspace is not the
  // caller's to name — same contract as `files__*`.
  test("ConversationsListInput has no workspaceId or includeUnstamped", () => {
    const properties = Object.keys(ConversationsListInput.properties);
    expect(properties).not.toContain("workspaceId");
    expect(properties).not.toContain("includeUnstamped");
  });

  test("ConversationsSearchInput has no workspaceId", () => {
    expect(Object.keys(ConversationsSearchInput.properties)).not.toContain("workspaceId");
  });

  test("ConversationsStatsInput has no workspaceId", () => {
    expect(Object.keys(ConversationsStatsInput.properties)).not.toContain("workspaceId");
  });
});

describe("conversations__list — ambient workspace scoping", () => {
  test("returns only the focused workspace's conversations", async () => {
    expect(idsOf(await exec("list", {}, WS_A))).toEqual(["conv_a1", "conv_a2"]);
  });

  test("a different focused workspace returns that workspace's set", async () => {
    expect(idsOf(await exec("list", {}, WS_B))).toEqual(["conv_b1"]);
  });

  test("omitting every argument does NOT produce a cross-workspace read", async () => {
    // The regression: the iframe's first call carries no arguments because the
    // host-context handshake has not resolved yet. It must still be walled.
    const ids = idsOf(await exec("list", {}, WS_A));
    expect(ids).not.toContain("conv_b1");
    expect(ids).not.toContain("conv_p1");
  });

  test("a caller-supplied workspaceId cannot reach another workspace", async () => {
    // The workspace is ambient, so a client coordinate is not authoritative and
    // cannot widen or redirect the read.
    const ids = idsOf(await exec("list", { workspaceId: WS_B }, WS_A));
    expect(ids).toEqual(["conv_a1", "conv_a2"]);
  });

  test("denies when no workspace is in scope", async () => {
    // e.g. an external `/mcp` call with no `X-Workspace-Id`. Deny rather than
    // guess a workspace — the same posture as `files__*`.
    const result = await exec("list", {}, undefined);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(payload(result))).toContain("workspace");
  });

  test("ownership still gates inside the focused workspace", async () => {
    expect(idsOf(await exec("list", {}, WS_A))).not.toContain("conv_peer");
  });

  test("the personal workspace folds in legacy unstamped conversations", async () => {
    // No migration stamps legacy records, and an unstamped conversation belongs
    // to the owner's personal workspace. Derived from the ambient workspace —
    // never a client flag.
    expect(idsOf(await exec("list", {}, WS_PERSONAL))).toEqual(["conv_legacy", "conv_p1"]);
  });

  test("a shared workspace never folds in legacy unstamped conversations", async () => {
    expect(idsOf(await exec("list", {}, WS_A))).not.toContain("conv_legacy");
  });

  test("a caller-supplied includeUnstamped cannot pull legacy chats into a shared workspace", async () => {
    const ids = idsOf(await exec("list", { includeUnstamped: true }, WS_A));
    expect(ids).toEqual(["conv_a1", "conv_a2"]);
  });
});

describe("conversations__search — ambient workspace scoping", () => {
  test("matches only within the focused workspace", async () => {
    const data = payload(await exec("search", { query: "hello from" }, WS_A)) as {
      results?: Array<{ id: string }>;
    };
    expect((data.results ?? []).map((r) => r.id).sort()).toEqual(["conv_a1", "conv_a2"]);
  });

  test("never returns snippets from another workspace's transcripts", async () => {
    const raw = JSON.stringify(payload(await exec("search", { query: "hello from" }, WS_A)));
    expect(raw).not.toContain(WS_B);
    expect(raw).not.toContain("conv_b1");
  });

  test("denies when no workspace is in scope", async () => {
    const result = await exec("search", { query: "hello" }, undefined);
    expect(result.isError).toBe(true);
  });
});

describe("conversations__stats — ambient workspace scoping", () => {
  test("counts only the focused workspace's conversations", async () => {
    const data = payload(await exec("stats", { period: "all" }, WS_A)) as {
      totalConversations?: number;
    };
    expect(data.totalConversations).toBe(2);
  });

  test("denies when no workspace is in scope", async () => {
    const result = await exec("stats", { period: "all" }, undefined);
    expect(result.isError).toBe(true);
  });
});

describe("the cross-workspace enumeration must be named out loud", () => {
  // `ConversationLocator.list` used to take an OPTIONAL `workspaceId`, so
  // forgetting it widened the read to every workspace — silently, and looking
  // identical to a scoped call. The scope is now a required discriminated
  // union, which turns the omission into a compile error and leaves the
  // owner-wide form greppable.
  test("a workspace scope covers only that workspace", async () => {
    const locator = new ConversationLocator(join(workDir, "workspaces"));
    const result = await locator.list(
      { kind: "workspace", workspaceId: WS_A },
      { limit: 100 },
      { userId: OWNER_ID },
    );
    expect(result.conversations.map((c) => c.id).sort()).toEqual(["conv_a1", "conv_a2"]);
  });

  test("all-workspaces is still available to internal callers, explicitly", async () => {
    const locator = new ConversationLocator(join(workDir, "workspaces"));
    const result = await locator.list(
      { kind: "all-workspaces" },
      { limit: 100 },
      { userId: OWNER_ID },
    );
    expect(result.conversations.map((c) => c.id).sort()).toEqual([
      "conv_a1",
      "conv_a2",
      "conv_b1",
      "conv_legacy",
      "conv_p1",
    ]);
  });

  test("the owner-wide form is used in exactly one place in src/", async () => {
    // If this count moves, a new cross-workspace enumeration was added and
    // wants the same scrutiny `skills__loading_log` got (#879).
    const proc = Bun.spawnSync([
      "grep",
      "-rn",
      '{ kind: "all-workspaces" }',
      "src/",
    ]);
    const hits = new TextDecoder()
      .decode(proc.stdout)
      .split("\n")
      .filter((l) => l.trim())
      // Drop the union's own declaration and prose about it — only real call
      // sites count.
      .filter((l) => !l.includes("conversation/types.ts"))
      .filter((l) => {
        const code = l.slice(l.indexOf(":", l.indexOf(":") + 1) + 1).trim();
        return !code.startsWith("*") && !code.startsWith("//");
      });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("skills.ts");
  });
});

describe("conversations index — concurrent cold reads", () => {
  test("two concurrent first reads both see a fully-built index", async () => {
    // The index is memoised on the source. Publishing it before `build()`
    // resolves lets a second caller read a half-built map and get a short
    // answer — which then loses the race against the first caller's response.
    //
    // Enough files that `build()` is still awaiting per-file reads when the
    // second call lands; with a handful the window closes before the race can
    // be observed and the test passes vacuously.
    for (let i = 0; i < 200; i++) {
      writeConv({ id: `conv_bulk${String(i).padStart(3, "0")}`, wsId: WS_A });
    }
    source = await createConversationsSource(makeRuntime(), new NoopEventSink());
    await source.start();

    const [a, b] = await Promise.all([
      exec("list", { limit: 1000 }, WS_A),
      exec("list", { limit: 1000 }, WS_A),
    ]);
    expect(idsOf(a)).toHaveLength(202);
    expect(idsOf(b)).toHaveLength(202);
  });

  test("concurrent reads in different workspaces do not bleed into each other", async () => {
    const [a, b] = await Promise.all([exec("list", {}, WS_A), exec("list", {}, WS_B)]);
    expect(idsOf(a)).toEqual(["conv_a1", "conv_a2"]);
    expect(idsOf(b)).toEqual(["conv_b1"]);
  });
});
