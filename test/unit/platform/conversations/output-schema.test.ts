/**
 * The conversations tools' results pass their published output schemas when
 * read from a log that carries every event shape the reader projects.
 *
 * The SDK client validates each success result against its tool's output
 * schema, so a stored shape the schema does not admit fails the whole call for
 * that conversation. The fixture here carries what the thinner fixtures in the
 * sibling tests do not: reasoning, tool calls with resource links, attached
 * files, cache and reasoning token subtotals, a non-complete stop reason, and
 * a `skills.loaded` record written under an earlier scope vocabulary.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../../../src/adapters/noop-events.ts";
import type { ToolResult } from "../../../../src/engine/types.ts";
import { createConversationsSource } from "../../../../src/platform/conversations/source.ts";
import type {
  ConversationsExportOutput,
  ConversationsGetOutput,
  ConversationsListOutput,
  ConversationsSearchOutput,
  ConversationsStatsOutput,
} from "../../../../src/platform/schemas/conversations.ts";
import { runWithRequestContext } from "../../../../src/runtime/request-context.ts";
import type { Runtime } from "../../../../src/runtime/runtime.ts";
import type { McpSource } from "../../../../src/tools/mcp-source.ts";
import type { WorkspaceStore } from "../../../../src/workspace/workspace-store.ts";
import { makeIdentity } from "../../../helpers/identity.ts";
import { stub } from "../../../helpers/stub.ts";

const OWNER_ID = "usr_test";
const WS_ID = "ws_00a1b2c3d4e5f607";
const CONV_ID = "conv_rich000000000001";

let workDir: string;
let source: McpSource;

function writeRichConversation(): void {
  const dir = join(workDir, "workspaces", WS_ID, "conversations", OWNER_ID);
  mkdirSync(dir, { recursive: true });
  const runId = "run_rich";
  const events = [
    {
      id: CONV_ID,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      title: null,
      lastModel: null,
      ownerId: OWNER_ID,
      workspaceId: WS_ID,
      format: "events",
      model: "anthropic:claude-sonnet-4-6",
    },
    {
      ts: "2026-01-01T00:01:00.000Z",
      type: "user.message",
      content: [{ type: "text", text: "summarize the attached report" }],
      userId: OWNER_ID,
      files: [
        {
          id: "fl_report",
          filename: "report.pdf",
          mimeType: "application/pdf",
          size: 2048,
          extracted: true,
        },
      ],
    },
    { ts: "2026-01-01T00:01:01.000Z", type: "run.start", runId, model: "m1" },
    {
      ts: "2026-01-01T00:01:01.500Z",
      type: "skills.loaded",
      runId,
      skills: [
        // `bundle` is the scope vocabulary a record written before `provided`
        // carries; the reader keeps what the record says.
        {
          id: "skill://writer/SKILL.md",
          name: "writer",
          connector: "writer",
          layer: 3,
          scope: "bundle",
          version: "1",
          tokens: 120,
          contentHash: "abc",
          loadedBy: "tool_affinity",
          reason: "files__read",
        },
      ],
      totalTokens: 120,
    },
    {
      ts: "2026-01-01T00:01:02.000Z",
      type: "llm.response",
      runId,
      model: "m1",
      content: [
        { type: "reasoning", text: "Read the file first." },
        { type: "text", text: "Reading it." },
        {
          type: "tool-call",
          toolCallId: "tc_read",
          toolName: "files__read",
          input: JSON.stringify({ id: "fl_report" }),
        },
        // A stored input that parses to something other than an object.
        { type: "tool-call", toolCallId: "tc_null", toolName: "nb__status", input: "null" },
        // A tool name that is also an Object.prototype member, which `stats` counts.
        { type: "tool-call", toolCallId: "tc_proto", toolName: "toString", input: "{}" },
      ],
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
        reasoningTokens: 5,
      },
      llmMs: 300,
      finishReason: "tool-calls",
    },
    {
      ts: "2026-01-01T00:01:03.000Z",
      type: "tool.start",
      runId,
      name: "files__read",
      id: "tc_read",
    },
    {
      ts: "2026-01-01T00:01:04.000Z",
      type: "tool.done",
      runId,
      name: "files__read",
      id: "tc_read",
      ok: true,
      ms: 12,
      output: "Read report.pdf",
      resourceUri: "ui://files/viewer",
      resourceLinks: [
        { uri: "files://fl_report", name: "report.pdf", mimeType: "application/pdf" },
      ],
    },
    {
      ts: "2026-01-01T00:01:04.500Z",
      type: "tool.done",
      runId,
      name: "nb__status",
      id: "tc_null",
      ok: false,
      ms: 3,
      output: "failed",
    },
    {
      ts: "2026-01-01T00:01:04.700Z",
      type: "tool.done",
      runId,
      name: "toString",
      id: "tc_proto",
      ok: false,
      ms: 1,
      output: "unknown tool",
    },
    {
      ts: "2026-01-01T00:01:05.000Z",
      type: "llm.response",
      runId,
      // A model name that is also an Object.prototype member.
      model: "constructor",
      content: [{ type: "text", text: "Here is the summary." }],
      usage: { inputTokens: 50, outputTokens: 30 },
      llmMs: 200,
      finishReason: "stop",
    },
    {
      ts: "2026-01-01T00:01:06.000Z",
      type: "run.done",
      runId,
      stopReason: "max_iterations",
      totalMs: 500,
    },
    { ts: "2026-01-01T00:01:07.000Z", type: "metadata.title", title: "Report summary" },
  ];
  writeFileSync(
    join(dir, `${CONV_ID}.jsonl`),
    `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
}

function makeRuntime(): Runtime {
  return stub<Runtime>({
    getCurrentIdentity: () => makeIdentity({ id: OWNER_ID }),
    resolveRequestUserId: () => OWNER_ID,
    getWorkspaceStore: () =>
      stub<WorkspaceStore>({ getWorkspacesDir: () => join(workDir, "workspaces") }),
    onConversationsChanged: () => () => {},
    isTurnActive: () => false,
  });
}

/** Run a tool and return its structured result, failing on an error result. */
async function call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
  const result: ToolResult = await runWithRequestContext(
    { identity: makeIdentity({ id: OWNER_ID }), workspaceId: WS_ID },
    () => source.execute(tool, args),
  );
  const first = result.content[0];
  const text = first?.type === "text" ? first.text : "";
  if (result.isError) throw new Error(`${tool} failed: ${text}`);
  // The model reads the text; clients read `structuredContent`. Both say the same.
  expect(result.structuredContent).toEqual(JSON.parse(text));
  // No result names where the server keeps conversations: readers address one by id.
  expect(text).not.toContain(workDir);
  return result.structuredContent as T;
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "nb-conv-output-schema-"));
  writeRichConversation();
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

describe("conversations tools publish results their output schemas admit", () => {
  test("every tool declares an output schema", async () => {
    const tools = await source.tools();
    expect(tools.length).toBe(7);
    for (const tool of tools) expect(tool.outputSchema).toBeDefined();
  });

  test("get returns the full transcript", async () => {
    const data = await call<ConversationsGetOutput>("get", { id: CONV_ID, expand: "full" });
    expect(data.metadata.title).toBe("Report summary");
    expect(data.messages).toHaveLength(2);
    const [user, assistant] = data.messages;
    expect(user?.files?.[0]?.filename).toBe("report.pdf");
    expect(assistant?.stopReason).toBe("max_iterations");
    expect(assistant?.usage?.cacheWriteTokens).toBe(10);
    expect(assistant?.skillsLoaded?.skills[0]?.scope).toBe("bundle");
    expect(assistant?.blocks.map((b) => b.type)).toEqual(["reasoning", "text", "tool", "text"]);
    const [read, failed] = assistant?.toolCalls ?? [];
    expect(read?.resourceLinks?.[0]?.uri).toBe("files://fl_report");
    expect(read?.input).toEqual({ id: "fl_report" });
    expect(failed?.input).toEqual({});
    expect(failed?.status).toBe("error");
  });

  test("get's default window and metadata-only reads", async () => {
    const windowed = await call<ConversationsGetOutput>("get", { id: CONV_ID });
    expect(windowed.messages).toHaveLength(2);
    const meta = await call<ConversationsGetOutput>("get", { id: CONV_ID, expand: "metadata" });
    expect(meta.messages).toEqual([]);
  });

  test("list", async () => {
    const data = await call<ConversationsListOutput>("list", {});
    expect(data.conversations.map((c) => c.id)).toEqual([CONV_ID]);
    expect(data.conversations[0]?.active).toBe(false);
    expect(data.conversations[0]).not.toHaveProperty("filePath");
  });

  test("stats", async () => {
    const data = await call<ConversationsStatsOutput>("stats", { period: "all" });
    expect(data.totalConversations).toBe(1);
    expect(Object.entries(data.byModel)).toEqual([
      ["constructor", expect.objectContaining({ conversations: 1 })],
    ]);
    expect(data.topTools.map((t) => t.name).sort()).toEqual([
      "files__read",
      "nb__status",
      "toString",
    ]);
    expect(data.topTools.find((t) => t.name === "toString")?.callCount).toBe(1);
  });

  test("export as markdown and as JSON", async () => {
    const md = await call<ConversationsExportOutput>("export", { id: CONV_ID, format: "markdown" });
    expect(md.content).toContain("Report summary");
    const json = await call<ConversationsExportOutput>("export", { id: CONV_ID, format: "json" });
    expect(JSON.parse(json.content)).toHaveLength(2);
  });

  test("search", async () => {
    const data = await call<ConversationsSearchOutput>("search", { query: "summary" });
    expect(data.results.map((r) => r.id)).toEqual([CONV_ID]);
  });
});
