/**
 * The conversations app door is walled to ONE workspace.
 *
 * Conversations are workspace-owned, so every read resolves inside exactly one
 * workspace — `RequestContext.workspaceId`, set by the door the request came
 * through, exactly as it works for `files__*` and `tasks__*` (see
 * `test/unit/platform/files/source.test.ts`).
 *
 * These tests pin the property that matters: the workspace a read lands in is
 * AMBIENT and validated, never a coordinate the caller supplies. A client that
 * omits it does not get a cross-workspace read, and a client that names another
 * workspace does not get that workspace.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../../../src/adapters/noop-events.ts";
import type { ToolResult } from "../../../../src/engine/types.ts";
import {
  ConversationIndex,
  type ReadScope,
} from "../../../../src/platform/conversations/index-cache.ts";
import { createConversationsSource } from "../../../../src/platform/conversations/source.ts";
import { handleExport } from "../../../../src/platform/conversations/tools/export.ts";
import { handleGet } from "../../../../src/platform/conversations/tools/get.ts";
import { handleList } from "../../../../src/platform/conversations/tools/list.ts";
import { handleSearch } from "../../../../src/platform/conversations/tools/search.ts";
import { handleStats } from "../../../../src/platform/conversations/tools/stats.ts";
import { handleUpdate } from "../../../../src/platform/conversations/tools/update.ts";
import {
  ConversationsListInput,
  ConversationsSearchInput,
  ConversationsStatsInput,
} from "../../../../src/platform/schemas/conversations.ts";
import { runWithRequestContext } from "../../../../src/runtime/request-context.ts";
import type { Runtime } from "../../../../src/runtime/runtime.ts";
import type { McpSource } from "../../../../src/tools/mcp-source.ts";
import type { WorkspaceStore } from "../../../../src/workspace/workspace-store.ts";
import { conversationEventLines, type FixtureTurn } from "../../../helpers/conversation-events.ts";
import { makeIdentity } from "../../../helpers/identity.ts";
import { stub } from "../../../helpers/stub.ts";

const OWNER_ID = "usr_test";
const PEER_ID = "usr_peer";
/** The owner's own workspace. */
const WS_PERSONAL = "ws_cccccccccccccccc";
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
    model: "anthropic:claude-sonnet-4-6",
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
    ...conversationEventLines([
      { role: "user", content: spec.message ?? `hello from ${spec.wsId}`, timestamp: ts },
    ] as FixtureTurn[]),
  ];
  writeFileSync(join(dir, `${spec.id}.jsonl`), `${lines.join("\n")}\n`);
}

function makeRuntime(): Runtime {
  return stub<Runtime>({
    getCurrentIdentity: () => makeIdentity({ id: OWNER_ID }),
    resolveRequestUserId: (identity?: { id: string }) => identity?.id ?? OWNER_ID,
    getWorkspaceStore: () =>
      stub<WorkspaceStore>({ getWorkspacesDir: () => join(workDir, "workspaces") }),
    onConversationsChanged: () => () => {},
    isTurnActive: () => false,
  });
}

/** Run a conversations tool with `wsId` as the request's focused workspace. */
function exec(
  tool: string,
  args: Record<string, unknown>,
  wsId: string | undefined,
): Promise<ToolResult> {
  return runWithRequestContext(
    {
      identity: makeIdentity({ id: OWNER_ID }),
      ...(wsId ? { workspaceId: wsId } : {}),
    },
    () => source.execute(tool, args),
  );
}

function payload(result: ToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("expected a text block");
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
  // List first, as the engine does: the SDK client validates a result against
  // its tool's output schema only once it holds the `tools/list` that declares it.
  await source.tools();
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
  test("ConversationsListInput has no workspaceId", () => {
    expect(Object.keys(ConversationsListInput.properties)).not.toContain("workspaceId");
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
    // e.g. a background job with no workspace bound. Deny rather than
    // guess a workspace — the same posture as `files__*`.
    const result = await exec("list", {}, undefined);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(payload(result))).toContain("workspace");
  });

  test("ownership still gates inside the focused workspace", async () => {
    expect(idsOf(await exec("list", {}, WS_A))).not.toContain("conv_peer");
  });

  test("a record with no line-1 workspace is listed by the directory it lives in", async () => {
    // `conv_legacy` carries no `workspaceId` on line 1 but sits in the personal
    // workspace's partition. The directory is the binding, so it lists there —
    // no "unstamped" concept and no client flag to get wrong.
    expect(idsOf(await exec("list", {}, WS_PERSONAL))).toEqual(["conv_legacy", "conv_p1"]);
    expect(idsOf(await exec("list", {}, WS_A))).not.toContain("conv_legacy");
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
    // Replace the primed source with one over the bigger fixture set. Stop the
    // old one first — `afterEach` only sees the replacement.
    await source.stop();
    source = await createConversationsSource(makeRuntime(), new NoopEventSink());
    await source.start();
    // List first, as the engine does: the SDK client validates a result against
    // its tool's output schema only once it holds the `tools/list` that declares it.
    await source.tools();

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

describe("by-id reads and writes are walled to the scope's workspace", () => {
  // The owner holds `conv_b1` in WS_B. A call scoped to WS_A must treat it
  // exactly as an id that does not exist: same error, nothing read, nothing
  // written. The index takes the workspace and the owner together, so neither
  // half can be left out.
  const SCOPE_A: ReadScope = { workspaceId: WS_A, userId: OWNER_ID };
  const B_FILE = () =>
    join(workDir, "workspaces", WS_B, "conversations", OWNER_ID, "conv_b1.jsonl");

  async function buildIndex(): Promise<ConversationIndex> {
    const index = new ConversationIndex();
    await index.build(join(workDir, "workspaces"));
    return index;
  }

  /** The handler's rejection message, or a failure if it resolved. */
  async function rejection(call: Promise<unknown>): Promise<string> {
    try {
      await call;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error("expected the call to reject");
  }

  test("index get with the right owner in another workspace returns undefined", async () => {
    const index = await buildIndex();
    expect(index.get("conv_b1", SCOPE_A)).toBeUndefined();
    expect(index.get("conv_b1", { workspaceId: WS_B, userId: OWNER_ID })).toBeDefined();
  });

  test("index get with the right workspace and another owner returns undefined", async () => {
    const index = await buildIndex();
    expect(index.get("conv_peer", SCOPE_A)).toBeUndefined();
  });

  test("get in workspace A of a conversation held in workspace B fails as not found", async () => {
    const index = await buildIndex();
    expect(await rejection(handleGet({ id: "conv_b1" }, index, SCOPE_A))).toBe(
      "Conversation not found: conv_b1",
    );
    expect(await rejection(handleGet({ id: "conv_none" }, index, SCOPE_A))).toBe(
      "Conversation not found: conv_none",
    );
  });

  test("export in workspace A of a conversation held in workspace B fails as not found", async () => {
    const index = await buildIndex();
    expect(await rejection(handleExport({ id: "conv_b1", format: "json" }, index, SCOPE_A))).toBe(
      "Conversation not found: conv_b1",
    );
    expect(await rejection(handleExport({ id: "conv_none", format: "json" }, index, SCOPE_A))).toBe(
      "Conversation not found: conv_none",
    );
  });

  test("update in workspace A of a conversation held in workspace B fails and writes nothing", async () => {
    const index = await buildIndex();
    const before = readFileSync(B_FILE(), "utf8");
    expect(
      await rejection(handleUpdate({ id: "conv_b1", title: "retitled" }, index, SCOPE_A)),
    ).toBe("Conversation not found: conv_b1");
    expect(
      await rejection(handleUpdate({ id: "conv_none", title: "retitled" }, index, SCOPE_A)),
    ).toBe("Conversation not found: conv_none");
    expect(readFileSync(B_FILE(), "utf8")).toBe(before);
  });

  test("the door's by-id tools answer another workspace's id exactly as a missing one", async () => {
    // Through the source, so the scope is the one the request carries rather
    // than one a test constructs.
    const args: Record<string, Record<string, unknown>> = {
      get: {},
      export: { format: "json" },
      update: { title: "retitled" },
    };
    for (const [tool, extra] of Object.entries(args)) {
      const held = await exec(tool, { ...extra, id: "conv_b1" }, WS_A);
      const missing = await exec(tool, { ...extra, id: "conv_none" }, WS_A);
      expect(held.isError).toBe(true);
      expect(missing.isError).toBe(true);
      expect(payload(held)).toEqual({ error: "Conversation not found: conv_b1" });
      expect(payload(missing)).toEqual({ error: "Conversation not found: conv_none" });
    }
    expect(readFileSync(B_FILE(), "utf8")).not.toContain("retitled");
  });
});

describe("list, search and stats handlers are walled to the scope's workspace", () => {
  const SCOPE_A: ReadScope = { workspaceId: WS_A, userId: OWNER_ID };

  async function buildIndex(): Promise<ConversationIndex> {
    const index = new ConversationIndex();
    await index.build(join(workDir, "workspaces"));
    return index;
  }

  test("index list in workspace A never includes workspace B's conversations", async () => {
    const index = await buildIndex();
    const ids = index.list(SCOPE_A, { limit: 100 }).conversations.map((c) => c.id);
    expect(ids.sort()).toEqual(["conv_a1", "conv_a2"]);
  });

  test("handleList in workspace A never includes workspace B's conversations", async () => {
    const index = await buildIndex();
    const page = await handleList({ limit: 100 }, index, SCOPE_A);
    expect(page.conversations.map((c) => c.id).sort()).toEqual(["conv_a1", "conv_a2"]);
    expect(page.totalCount).toBe(2);
  });

  test("handleSearch in workspace A never matches workspace B's transcripts", async () => {
    const index = await buildIndex();
    const result = await handleSearch({ query: WS_B }, index, SCOPE_A);
    expect(result.results).toEqual([]);
    const all = await handleSearch({ query: "hello from" }, index, SCOPE_A);
    expect(all.results.map((r) => r.id).sort()).toEqual(["conv_a1", "conv_a2"]);
  });

  test("handleStats in workspace A counts only workspace A's conversations", async () => {
    const index = await buildIndex();
    const stats = await handleStats({ period: "all" }, index, SCOPE_A);
    expect(stats.totalConversations).toBe(2);
  });
});
