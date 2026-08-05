/**
 * `conversations__*` previews are capped on the wire, not in the index.
 *
 * `preview` is a conversation's first user message. These are tool responses —
 * the text lands in the agent's context window and its token budget — so one
 * conversation opened by pasting a long document would otherwise carry that
 * whole document into every call, and `list` returns 20 of them by default.
 *
 * The cap has to sit at the wire. The index's stored preview backs
 * case-insensitive substring matching for `list?search=`, so truncating at
 * production would silently narrow recall — which is why `home__activity` caps
 * in its collector rather than in the index, and why this does the same.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../../../src/adapters/noop-events.ts";
import { PREVIEW_MAX_CHARS } from "../../../../src/conversation/preview.ts";
import type { ToolResult } from "../../../../src/engine/types.ts";
import { runWithRequestContext } from "../../../../src/runtime/request-context.ts";
import type { Runtime } from "../../../../src/runtime/runtime.ts";
import type { McpSource } from "../../../../src/tools/mcp-source.ts";
import { createConversationsSource } from "../../../../src/tools/platform/conversations.ts";

const OWNER_ID = "usr_test";
const WS_ID = "ws_preview000000";

/** A term buried far past any sane preview cap, used to prove search still reaches it. */
const DEEP_TERM = "needle_past_the_cap";
const LONG_MESSAGE = `${"pasted document ".repeat(120)}${DEEP_TERM}${" trailing".repeat(40)}`;

let workDir: string;
let source: McpSource;

function writeConv(id: string, firstMessage: string): void {
  const dir = join(workDir, "workspaces", WS_ID, "conversations", OWNER_ID);
  mkdirSync(dir, { recursive: true });
  const meta = {
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    title: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    lastModel: null,
    ownerId: OWNER_ID,
    workspaceId: WS_ID,
  };
  const lines = [
    JSON.stringify(meta),
    JSON.stringify({ role: "user", content: firstMessage, timestamp: "2026-01-01T00:01:00.000Z" }),
    JSON.stringify({ role: "assistant", content: "ack", timestamp: "2026-01-01T00:02:00.000Z" }),
  ];
  writeFileSync(join(dir, `${id}.jsonl`), `${lines.join("\n")}\n`);
}

function makeRuntime(): Runtime {
  return {
    getCurrentIdentity: () => ({ id: OWNER_ID }),
    resolveRequestUserId: () => OWNER_ID,
    getWorkspaceStore: () => ({ getWorkspacesDir: () => join(workDir, "workspaces") }),
    onConversationsChanged: () => {},
  } as unknown as Runtime;
}

function exec(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  return runWithRequestContext(
    { identity: { id: OWNER_ID } as never, workspaceId: WS_ID },
    () => source.execute(tool, args),
  );
}

function payload(result: ToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected a text block");
  return JSON.parse(first.text) as Record<string, unknown>;
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "nb-preview-cap-"));
  writeConv("conv_long", LONG_MESSAGE);
  source = await createConversationsSource(makeRuntime(), new NoopEventSink());
  await source.start();
});

afterEach(async () => {
  await source.stop();
  rmSync(workDir, { recursive: true, force: true });
});

describe("preview is capped on every tool that puts it on the wire", () => {
  test("list", async () => {
    const data = payload(await exec("list", {})) as {
      conversations: Array<{ preview: string }>;
    };
    const preview = data.conversations[0]?.preview ?? "";
    expect(preview.length).toBeGreaterThan(0);
    expect(preview.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
    expect(preview.length).toBeLessThan(LONG_MESSAGE.length);
  });

  test("fork", async () => {
    const data = payload(await exec("fork", { id: "conv_long" })) as { preview?: string };
    expect(data.preview?.length ?? 0).toBeGreaterThan(0);
    expect(data.preview?.length ?? 0).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
  });

  test("update", async () => {
    const data = payload(await exec("update", { id: "conv_long", title: "renamed" })) as {
      preview?: string;
    };
    expect(data.preview?.length ?? 0).toBeGreaterThan(0);
    expect(data.preview?.length ?? 0).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
  });
});

describe("the cap is at the wire, so recall is unaffected", () => {
  test("list?search= still matches a term past the cap", async () => {
    // The stored preview backs this substring match. If the cap were applied at
    // the index instead, this term would be gone and the row would not match.
    const data = payload(await exec("list", { search: DEEP_TERM })) as {
      conversations: Array<{ id: string }>;
    };
    expect(data.conversations.map((c) => c.id)).toEqual(["conv_long"]);
  });

  test("full-text search still reaches the same term", async () => {
    const data = payload(await exec("search", { query: DEEP_TERM })) as {
      results: Array<{ id: string }>;
    };
    expect(data.results.map((r) => r.id)).toEqual(["conv_long"]);
  });
});
