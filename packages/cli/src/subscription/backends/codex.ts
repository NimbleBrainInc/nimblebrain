/**
 * Codex as a backend: the `codex exec` CLI, signed in with ChatGPT, so its
 * calls bill the person's ChatGPT plan.
 *
 * - Every API key is removed from its environment, and the worker refuses to
 *   start unless `codex login status` says ChatGPT.
 * - The person's `config.toml` is ignored (`--ignore-user-config`; the login
 *   still comes from `CODEX_HOME`), so the only MCP server is the session's
 *   NimbleBrain tools.
 * - Codex has no switch for its shell. It runs read-only in an empty working
 *   directory with no approvals, and each command it runs is shown in the turn.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type * as acp from "@agentclientprotocol/sdk/unstable";
import { modelLabel } from "../command.ts";
import { classifyFailure } from "./failure.ts";
import { startTimeline, type Timeline } from "./timeline.ts";
import {
  type Account,
  type Backend,
  BackendRefused,
  emptyUsage,
  spawnFailure,
  subscriptionEnv,
  type TokenUsage,
  type TurnInput,
  type TurnResult,
} from "./types.ts";

const SERVER = "nimblebrain";

export function createCodexBackend(
  opts: { bin?: string; model?: string; log?: string; noteMs?: number } = {},
): Backend {
  const bin = opts.bin ?? "codex";
  return {
    id: "codex",
    label: "Codex",
    ...(opts.model ? { modelLabel: modelLabel(opts.model) } : {}),
    takesSystemPrompt: false,
    toolsAreNimbleBrainOnly: false,
    preflight: () => codexPreflight(bin),
    run: (input) => runCodex(bin, opts.model, input, opts.log, opts.noteMs),
  };
}

/** The command that says how Codex is signed in; `codexAccount` reads its output. */
export const CODEX_STATUS = ["login", "status"];

async function codexPreflight(bin: string): Promise<Account> {
  return codexAccount(await capture(bin, CODEX_STATUS).catch(() => undefined));
}

/**
 * The plan `codex login status` names (its stdout and stderr together), or
 * why a turn would not bill one: `out` undefined means Codex is not installed.
 */
export function codexAccount(out: string | undefined): Account {
  if (out === undefined) {
    throw new BackendRefused(
      "not_installed",
      "Codex is not installed. Install it (`npm i -g @openai/codex`), then run `codex login`.",
    );
  }
  if (/chatgpt/i.test(out))
    return { describe: "your ChatGPT plan (Sign in with ChatGPT, no API key)", plan: "ChatGPT" };
  if (/api key/i.test(out)) {
    throw new BackendRefused(
      "api_key",
      "Codex is signed in with an API key, which bills API pricing. Run `codex logout`, then `codex login` and choose Sign in with ChatGPT.",
    );
  }
  throw new BackendRefused(
    "not_signed_in",
    "Codex is not signed in. Run `codex login` and choose Sign in with ChatGPT.",
  );
}

/** The points of a Codex turn the timeline times, after `spawn`. */
export const CODEX_MARKS = [
  "thread",
  "turn",
  "first_item",
  "first_reasoning",
  "first_text",
  "first_tool",
  "result",
  "exit",
] as const;

async function runCodex(
  bin: string,
  model: string | undefined,
  input: TurnInput,
  log?: string,
  noteMs?: number,
): Promise<TurnResult> {
  const cwd = await mkdtemp(join(tmpdir(), "nb-codex-"));
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--sandbox",
    "read-only",
    "-C",
    cwd,
    "-c",
    'approval_policy="never"',
    // An internal session (a title, a summary) attaches no MCP server.
    ...(input.purpose === "internal" || input.mcpUrl === undefined
      ? []
      : ["-c", `mcp_servers.${SERVER}.url=${JSON.stringify(input.mcpUrl)}`]),
    ...(model ? ["-m", model] : []),
    "-",
  ];
  const timeline = startTimeline({
    backend: "codex",
    label: "Codex",
    model,
    purpose: input.purpose,
    marks: CODEX_MARKS,
    emit: input.emit,
    ...(noteMs ? { noteMs } : {}),
  });
  const child = spawn(bin, args, { cwd, env: subscriptionEnv(), stdio: ["pipe", "pipe", "pipe"] });
  const kill = () => child.kill("SIGTERM");
  input.signal.addEventListener("abort", kill, { once: true });
  child.stdin.end(input.prompt);
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });
  const exited = new Promise<number | null>((resolve) =>
    child.on("close", (code) => {
      timeline.mark("exit");
      resolve(code);
    }),
  );
  const failed = spawnFailure(child, "codex");

  const translate = codexTranslator(input.emit, timeline);
  try {
    await Promise.race([readCodex(child.stdout, translate), failed]);
    const code = await Promise.race([exited, failed]);
    if (input.signal.aborted) return { stopReason: "cancelled", ...translate.totals() };
    // A turn that completed after a retried error ("Reconnecting... 1/5") succeeded.
    if (translate.completed()) return { stopReason: "end_turn", ...translate.totals() };
    const text = `${stderr}\n${translate.failure() ?? ""}`;
    throw classifyFailure("codex", text, { exitCode: code, log });
  } finally {
    timeline.end();
    input.signal.removeEventListener("abort", kill);
    await rm(cwd, { recursive: true, force: true });
  }
}

/** Feeds each `--json` line to `translate`, until the end. */
async function readCodex(
  stdout: NodeJS.ReadableStream,
  translate: (event: CodexEvent) => void,
): Promise<void> {
  for await (const line of createInterface({ input: stdout })) {
    if (!line.trim()) continue;
    try {
      translate(JSON.parse(line) as CodexEvent);
    } catch {
      // A line that is not an event is Codex's own logging.
    }
  }
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  server?: string;
  tool?: string;
  arguments?: unknown;
  status?: string;
  command?: string;
  /** An `error` item's text, such as a transport fallback. */
  message?: string;
}

interface CodexEvent {
  type: string;
  item?: CodexItem;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  error?: { message?: string };
  message?: string;
}

type Emit = (update: acp.SessionUpdate) => void;

const isToolItem = (item: CodexItem | undefined): item is CodexItem =>
  item?.type === "mcp_tool_call" || item?.type === "command_execution";

/**
 * `codex exec --json` events as ACP session updates, and the turn's usage at
 * the end. Each event's timing goes to `timeline` when given.
 */
export function codexTranslator(emit: Emit, timeline?: Timeline) {
  let usage: TokenUsage = emptyUsage();
  let done = false;
  let failed: string | undefined;
  const translate = (event: CodexEvent) => {
    if (timeline) timeCodex(event, timeline);
    switch (event.type) {
      case "item.started":
        if (isToolItem(event.item)) emitToolCall(event.item, "in_progress", emit);
        return;
      case "item.completed":
        if (event.item) emitCompleted(event.item, emit);
        return;
      case "turn.completed":
        usage = codexUsage(event.usage);
        done = true;
        return;
      case "turn.failed":
      case "error":
        failed = event.error?.message ?? event.message ?? failed;
        return;
    }
  };
  return Object.assign(translate, {
    completed: () => done,
    failure: () => failed,
    totals: () => ({
      usage,
      calls: [{ model: "codex-subscription:codex", purpose: "turn" as const, usage }],
    }),
  });
}

/** Codex's retry line: `Reconnecting... 2/5 (stream disconnected)`. */
const RECONNECTING = /^Reconnecting\.\.\.\s*(\d+)\/(\d+)\s*(?:\((.*)\))?/;

/**
 * Where an event falls on the turn's timeline: its type, an item's type, and
 * Codex's own short error text (redacted), never a message or tool's content.
 */
function timeCodex(event: CodexEvent, timeline: Timeline): void {
  switch (event.type) {
    case "thread.started":
      timeline.mark("thread");
      break;
    case "turn.started":
      timeline.mark("turn");
      break;
    case "item.started":
    case "item.completed":
      timeItem(event.item, timeline);
      break;
    case "error":
      timeError(event.message ?? event.error?.message ?? "", timeline);
      break;
    case "turn.completed":
      timeline.mark("result");
      break;
    case "turn.failed":
      timeline.mark("result");
      timeline.event(`turn.failed ${event.error?.message ?? ""}`);
      break;
  }
}

const ITEM_FIRSTS: Record<string, string> = {
  reasoning: "first_reasoning",
  agent_message: "first_text",
  mcp_tool_call: "first_tool",
  command_execution: "first_tool",
};

/** The first item, and the first reasoning, message and tool call; an `error` item is a notice. */
function timeItem(item: CodexItem | undefined, timeline: Timeline): void {
  if (!item) return;
  if (item.type === "error") {
    if (item.message) timeline.event(`notice ${item.message}`);
    return;
  }
  timeline.mark("first_item");
  const first = ITEM_FIRSTS[item.type ?? ""];
  if (!first) return;
  timeline.mark(first);
  timeline.output();
}

/** `Reconnecting... 2/5 (reason)` is a retry; any other error is logged as one. */
function timeError(text: string, timeline: Timeline): void {
  const retry = text.match(RECONNECTING);
  if (!retry) {
    timeline.event(`error ${text}`);
    return;
  }
  const reason = retry[3] ? ` ${retry[3]}` : "";
  timeline.retry(`${retry[1]}/${retry[2]}${reason}`, `attempt ${retry[1]} of ${retry[2]}`);
}

/** A tool call starting, or its end. */
function emitToolCall(
  item: CodexItem,
  status: "in_progress" | "completed" | "failed",
  emit: Emit,
): void {
  if (!item.id) return;
  if (status !== "in_progress") {
    emit({ sessionUpdate: "tool_call_update", toolCallId: item.id, status });
    return;
  }
  const shell = item.type === "command_execution";
  emit({
    sessionUpdate: "tool_call",
    toolCallId: item.id,
    title: shell ? `shell: ${item.command ?? ""}` : (item.tool ?? "tool"),
    kind: shell ? "execute" : "other",
    status,
    rawInput: item.arguments,
  });
}

/** A finished item: a message, reasoning, or a tool call's end. */
function emitCompleted(item: CodexItem, emit: Emit): void {
  if (item.type === "agent_message" && item.text) {
    emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: item.text } });
  } else if (item.type === "reasoning" && item.text) {
    emit({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: item.text } });
  } else if (isToolItem(item)) {
    emitToolCall(item, item.status === "failed" ? "failed" : "completed", emit);
  }
}

function codexUsage(u: CodexEvent["usage"] = {}): TokenUsage {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cached_input_tokens ?? 0,
    cacheWriteTokens: 0,
    reasoningTokens: u.reasoning_output_tokens ?? 0,
  };
}

function capture(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: subscriptionEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const take = (d: Buffer) => {
      out += d.toString();
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", reject);
    child.on("close", () => resolve(out));
  });
}
