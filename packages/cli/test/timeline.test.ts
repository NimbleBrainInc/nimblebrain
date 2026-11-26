/**
 * Each turn's timeline in the worker's log, and the note a person gets while
 * the first token is late, against fake vendor executables that print the
 * lines Claude Code and Codex print, with pauses between them.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk/unstable";
import { createClaudeBackend } from "../src/subscription/backends/claude.ts";
import { createCodexBackend } from "../src/subscription/backends/codex.ts";
import type { SessionPurpose, TurnInput } from "../src/subscription/backends/types.ts";

const dir = mkdtempSync(join(tmpdir(), "nb-timeline-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
/** A fake CLI that prints each line in `steps`, pausing for each number (seconds). */
function stepBin(steps: Array<object | number>): string {
  const bin = join(dir, `bin-${n++}`);
  const body = steps
    .map((s) => (typeof s === "number" ? `sleep ${s}` : `printf '%s\\n' '${JSON.stringify(s)}'`))
    .join("\n");
  writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function turn(purpose: SessionPurpose = "turn") {
  const updates: acp.SessionUpdate[] = [];
  const input: TurnInput = {
    prompt: "a secret prompt",
    system: "be brief",
    purpose,
    ...(purpose === "turn" ? { mcpUrl: "http://127.0.0.1:1/mcp/token" } : {}),
    signal: new AbortController().signal,
    emit: (u) => updates.push(u),
  };
  return { input, updates };
}

/** The worker's log lines while a test runs (it logs on stderr). */
let logged: string[] = [];
const write = process.stderr.write.bind(process.stderr);
beforeEach(() => {
  logged = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    logged.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});
afterEach(() => {
  process.stderr.write = write;
});
const timelineOf = () => logged.find((l) => l.includes("] timeline "));

const thoughts = (updates: acp.SessionUpdate[]) =>
  updates.flatMap((u) =>
    u.sessionUpdate === "agent_thought_chunk" && u.content.type === "text" ? [u.content.text] : [],
  );

const CLAUDE_INIT = { type: "system", subtype: "init", apiKeySource: "none" };
const REQUESTING = { type: "system", subtype: "status", status: "requesting" };
const RETRY = {
  type: "system",
  subtype: "api_retry",
  attempt: 2,
  max_retries: 10,
  retry_delay_ms: 2000,
  error_status: 529,
  error: "overloaded",
};
const MESSAGE_START = { type: "stream_event", event: { type: "message_start" } };
const delta = (type: "text_delta" | "thinking_delta", text: string) => ({
  type: "stream_event",
  event: {
    type: "content_block_delta",
    delta: type === "text_delta" ? { type, text } : { type, thinking: text },
  },
});
const RATE_LIMIT = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    rateLimitType: "seven_day",
    unifiedWindows: { seven_day: { utilization: 0.27, status: "allowed" } },
  },
};
const RESULT = { type: "result", subtype: "success", result: "the answer text", usage: {} };

describe("the Claude Code timeline", () => {
  test("logs one line per turn: seconds to each point, the retries, the rate limit", async () => {
    const bin = stepBin([
      CLAUDE_INIT,
      REQUESTING,
      RETRY,
      MESSAGE_START,
      delta("thinking_delta", "private thought"),
      delta("text_delta", "the answer text"),
      RATE_LIMIT,
      RESULT,
    ]);
    await createClaudeBackend({ bin, model: "sonnet" }).run(turn().input);
    const line = timelineOf() ?? "";
    expect(line).toMatch(
      /^\[\d\d:\d\d:\d\d\] timeline turn claude-code sonnet: spawn 0\.0 init \d+\.\d request \d+\.\d message_start \d+\.\d first_thinking \d+\.\d first_text \d+\.\d first_tool - result \d+\.\d exit \d+\.\d \| events: \d+\.\d retry 2\/10 overloaded 529 next in 2\.0s \| rate_limit: allowed seven_day 0\.27\n$/,
    );
    for (const secret of ["secret prompt", "private thought", "answer text", "token"]) {
      expect(line).not.toContain(secret);
    }
  });

  test("an internal run is timed on Haiku, with no retry or rate limit said as none", async () => {
    const bin = stepBin([CLAUDE_INIT, REQUESTING, delta("text_delta", "A title"), RESULT]);
    await createClaudeBackend({ bin, model: "sonnet" }).run(turn("internal").input);
    expect(timelineOf()).toContain("timeline internal claude-code haiku: spawn 0.0 init ");
    expect(timelineOf()).toEndWith("| events: none | rate_limit: -\n");
  });

  test("a failed turn is timed too, with the API's error", async () => {
    const bin = stepBin([
      CLAUDE_INIT,
      { type: "assistant", error: "rate_limit", message: { content: [] } },
      { type: "result", subtype: "success", is_error: true, result: "limit" },
    ]);
    await createClaudeBackend({ bin })
      .run(turn().input)
      .catch(() => {});
    expect(timelineOf()).toContain("api_error rate_limit");
    expect(timelineOf()).toContain("result success is_error");
  });
});

describe("the note while the first token is late", () => {
  test("a turn that shows nothing is told it is waiting, until the first output, then never again", async () => {
    const bin = stepBin([CLAUDE_INIT, REQUESTING, 1.2, delta("text_delta", "Hi"), 0.9, RESULT]);
    const { input, updates } = turn();
    await createClaudeBackend({ bin, noteMs: 400 }).run(input);
    const notes = thoughts(updates);
    expect(notes.length).toBeGreaterThanOrEqual(2);
    for (const note of notes)
      expect(note).toMatch(/^Waiting for Claude Code to start answering \(\d+s\)…\n$/);
    const first = updates.findIndex((u) => u.sessionUpdate === "agent_message_chunk");
    expect(updates.slice(first + 1).some((u) => u.sessionUpdate === "agent_thought_chunk")).toBe(
      false,
    );
  });

  test("names the retry the stream reported", async () => {
    const bin = stepBin([CLAUDE_INIT, REQUESTING, RETRY, 0.9, delta("text_delta", "Hi"), RESULT]);
    const { input, updates } = turn();
    await createClaudeBackend({ bin, noteMs: 400 }).run(input);
    expect(thoughts(updates)[0]).toMatch(
      /^Claude Code is retrying the API request \(attempt 2 of 10, \d+s so far\)…\n$/,
    );
  });

  test("an internal run gets no note: no one watches it", async () => {
    const bin = stepBin([CLAUDE_INIT, 0.4, delta("text_delta", "A title"), RESULT]);
    const { input, updates } = turn("internal");
    await createClaudeBackend({ bin, noteMs: 100 }).run(input);
    expect(thoughts(updates)).toEqual([]);
  });

  test("Codex gets the same note, naming its reconnect", async () => {
    const bin = stepBin([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      { type: "error", message: "Reconnecting... 2/5 (stream disconnected)" },
      0.9,
      { type: "item.completed", item: { id: "i", type: "agent_message", text: "Hi" } },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    const { input, updates } = turn();
    await createCodexBackend({ bin, noteMs: 400 }).run(input);
    expect(thoughts(updates)[0]).toMatch(
      /^Codex is retrying the API request \(attempt 2 of 5, \d+s so far\)…\n$/,
    );
  });
});

describe("the Codex timeline", () => {
  test("logs its events: the thread, the turn, retries, notices, the first items", async () => {
    const bin = stepBin([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      { type: "error", message: "Reconnecting... 1/5 (stream disconnected)" },
      {
        type: "item.completed",
        item: {
          id: "e",
          type: "error",
          message: "Falling back from WebSockets to HTTPS transport.",
        },
      },
      { type: "item.completed", item: { id: "r", type: "reasoning", text: "private thought" } },
      { type: "item.completed", item: { id: "m", type: "agent_message", text: "the answer" } },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    await createCodexBackend({ bin, model: "gpt-x" }).run(turn().input);
    const line = timelineOf() ?? "";
    expect(line).toMatch(
      /^\[\d\d:\d\d:\d\d\] timeline turn codex gpt-x: spawn 0\.0 thread \d+\.\d turn \d+\.\d first_item \d+\.\d first_reasoning \d+\.\d first_text \d+\.\d first_tool - result \d+\.\d exit \d+\.\d \| events: \d+\.\d retry 1\/5 stream disconnected, \d+\.\d notice Falling back from WebSockets to HTTPS transport\. \| rate_limit: -\n$/,
    );
    expect(line).not.toContain("private thought");
    expect(line).not.toContain("the answer");
  });

  test("a failed turn names why, without credentials", async () => {
    const bin = stepBin([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.failed", error: { message: "401 Unauthorized sk-proj-abcdefghijklmnop" } },
    ]);
    await createCodexBackend({ bin })
      .run(turn().input)
      .catch(() => {});
    const line = timelineOf() ?? "";
    expect(line).toContain("timeline turn codex default:");
    expect(line).toContain("turn.failed 401 Unauthorized [redacted]");
    expect(line).not.toContain("sk-proj");
  });
});
