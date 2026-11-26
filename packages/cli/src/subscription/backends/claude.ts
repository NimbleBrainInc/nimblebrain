/**
 * Claude Code as a backend: the unmodified `claude` binary in print mode,
 * signed in as the person, so its calls bill their Claude subscription.
 *
 * - Never `--bare`: bare mode reads only `ANTHROPIC_API_KEY` and never the
 *   claude.ai login, which would move the turn onto API pricing.
 * - Every API key is removed from its environment (`subscriptionEnv`), and the
 *   turn is stopped at once if Claude Code reports any key source but `none`.
 * - Its only tools are the session's NimbleBrain tools: built-in tools off
 *   (`--tools ""`), only the given MCP server (`--strict-mcp-config`), no
 *   settings, hooks, plugins or CLAUDE.md from the person's machine
 *   (`--setting-sources ""`, an empty working directory).
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type * as acp from "@agentclientprotocol/sdk/unstable";
import { classifyFailure, TurnFailed } from "./failure.ts";
import {
  type Account,
  type Backend,
  BackendRefused,
  emptyUsage,
  type ReportedCall,
  spawnFailure,
  subscriptionEnv,
  type TokenUsage,
  type TurnInput,
  type TurnResult,
} from "./types.ts";

/** The name the session's NimbleBrain server is given inside Claude Code. */
const SERVER = "nimblebrain";

export function createClaudeBackend(
  opts: { bin?: string; model?: string; log?: string } = {},
): Backend {
  const bin = opts.bin ?? "claude";
  return {
    id: "claude-code",
    label: "Claude Code",
    takesSystemPrompt: true,
    toolsAreNimbleBrainOnly: true,
    preflight: () => claudePreflight(bin),
    run: (input) => runClaude(bin, opts.model, input, opts.log),
  };
}

interface AuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  subscriptionType?: string;
  planTier?: string;
}

/** The command that says how Claude Code is signed in; `claudeAccount` reads its output. */
export const CLAUDE_STATUS = ["auth", "status", "--json"];

async function claudePreflight(bin: string): Promise<Account> {
  return claudeAccount(await capture(bin, CLAUDE_STATUS).catch(() => undefined));
}

/**
 * The subscription `claude auth status --json` names, or why the turn would
 * not bill one: `out` undefined means Claude Code is not installed. Only a
 * claude.ai login with a subscription passes; any other method is an API key.
 */
export function claudeAccount(out: string | undefined): Account {
  if (out === undefined) {
    throw new BackendRefused(
      "not_installed",
      "Claude Code is not installed. Install it from https://claude.com/claude-code, then run `claude` and sign in.",
    );
  }
  let status: AuthStatus;
  try {
    status = JSON.parse(out) as AuthStatus;
  } catch {
    throw new BackendRefused(
      "unreadable",
      "Could not read `claude auth status`. Update Claude Code.",
    );
  }
  if (!status.loggedIn) {
    throw new BackendRefused(
      "not_signed_in",
      "Claude Code is not signed in. Run `claude` and sign in with your Claude account.",
    );
  }
  if (status.authMethod !== "claude.ai" || !status.subscriptionType) {
    throw new BackendRefused(
      "api_key",
      `Claude Code is signed in with ${status.authMethod ?? "an API key"}, which bills API pricing. Run \`claude /login\` and choose your Claude subscription.`,
    );
  }
  const plan = status.subscriptionType.charAt(0).toUpperCase() + status.subscriptionType.slice(1);
  return {
    describe: `your Claude ${plan} subscription (claude.ai login, no API key)`,
    plan: `Claude ${plan}`,
  };
}

/** The print-mode arguments: stream JSON, the session's server only, nothing of the person's. */
function claudeArgs(input: TurnInput, model: string | undefined): string[] {
  const mcpConfig = { mcpServers: { [SERVER]: { type: "http", url: input.mcpUrl } } };
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--mcp-config",
    JSON.stringify(mcpConfig),
    "--strict-mcp-config",
    "--tools",
    "",
    "--allowedTools",
    `mcp__${SERVER}`,
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
    ...(input.system ? ["--system-prompt", input.system] : []),
    ...(model ? ["--model", model] : []),
  ];
}

async function runClaude(
  bin: string,
  model: string | undefined,
  input: TurnInput,
  log?: string,
): Promise<TurnResult> {
  const cwd = await mkdtemp(join(tmpdir(), "nb-claude-"));
  const child = spawn(bin, claudeArgs(input, model), {
    cwd,
    env: subscriptionEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const kill = () => child.kill("SIGTERM");
  input.signal.addEventListener("abort", kill, { once: true });
  child.stdin.end(input.prompt);
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });
  const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
  const failed = spawnFailure(child, "claude");

  const translate = claudeTranslator(input.emit);
  try {
    const refused = await Promise.race([readClaude(child.stdout, translate, kill), failed]);
    const code = await Promise.race([exited, failed]);
    if (refused) throw new TurnFailed("api_key", refused);
    if (input.signal.aborted) return { stopReason: "cancelled", ...translate.totals() };
    const stop = claudeStop(translate.result(), translate.apiError(), { code, stderr, log });
    return { stopReason: stop, ...translate.totals() };
  } finally {
    input.signal.removeEventListener("abort", kill);
    await rm(cwd, { recursive: true, force: true });
  }
}

/**
 * Feeds each stream-json line to `translate`, until the end or a line that
 * would bill an API key, which kills the turn. That refusal, if any.
 */
async function readClaude(
  stdout: NodeJS.ReadableStream,
  translate: (message: ClaudeMessage) => void,
  kill: () => void,
): Promise<string | undefined> {
  for await (const line of createInterface({ input: stdout })) {
    const message = parseLine(line);
    if (!message) continue;
    const refused = apiKeyRefusal(message);
    if (refused) {
      kill();
      return refused;
    }
    translate(message);
  }
  return undefined;
}

function parseLine(line: string): ClaudeMessage | undefined {
  if (!line.trim()) return undefined;
  try {
    return JSON.parse(line) as ClaudeMessage;
  } catch {
    return undefined;
  }
}

/**
 * The turn's stop reason from Claude Code's `result` line. Throws why it
 * failed (`classifyFailure`): an `is_error` result, whose text and the
 * assistant's `error` field say why, or no result at all, where stderr does.
 */
function claudeStop(
  result: ClaudeMessage | undefined,
  apiError: string | undefined,
  exit: { code: number | null; stderr: string; log?: string },
): acp.StopReason {
  if (!result || (result.is_error && result.subtype === "success")) {
    const text = `${exit.stderr}\n${result?.result ?? ""}`;
    throw classifyFailure("claude", text, { apiError, exitCode: exit.code, log: exit.log });
  }
  return result.subtype === "error_max_turns" ? "max_turn_requests" : "end_turn";
}

/**
 * Claude Code names how it authenticated on its first line. Anything but
 * `none` is an API key (from the environment, a helper or settings), which
 * bills API pricing: the turn stops before its first model call finishes.
 */
function apiKeyRefusal(message: ClaudeMessage): string | undefined {
  if (message.type !== "system" || message.subtype !== "init") return undefined;
  if (message.apiKeySource === "none" || message.apiKeySource === undefined) return undefined;
  return `Claude Code would bill an API key (source: ${message.apiKeySource}) instead of your subscription. Remove that key, or run \`claude /login\`.`;
}

interface ClaudeMessage {
  type: string;
  subtype?: string;
  apiKeySource?: string;
  model?: string;
  event?: { type: string; delta?: { type: string; text?: string; thinking?: string } };
  message?: { content?: ClaudeBlock[] };
  result?: string;
  is_error?: boolean;
  /** On an assistant message the API refused: `authentication_failed`, `rate_limit`, … */
  error?: string;
  usage?: ClaudeUsage;
  modelUsage?: Record<string, ClaudeModelUsage>;
}

interface ClaudeBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ClaudeModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/** Claude Code's stream-json lines as ACP session updates, and the turn's usage at the end. */
export function claudeTranslator(emit: (update: acp.SessionUpdate) => void) {
  let final: ClaudeMessage | undefined;
  let apiError: string | undefined;
  const translate = (message: ClaudeMessage) => {
    if (message.type === "stream_event") emitDelta(message, emit);
    else if (message.type === "assistant") {
      if (typeof message.error === "string") apiError = message.error;
      emitToolCalls(message, emit);
    } else if (message.type === "user") emitToolResults(message, emit);
    else if (message.type === "result") final = message;
  };
  return Object.assign(translate, {
    result: () => final,
    apiError: () => apiError,
    totals: () => claudeTotals(final),
  });
}

/** A streamed text or thinking delta. */
function emitDelta(message: ClaudeMessage, emit: (update: acp.SessionUpdate) => void): void {
  const delta = message.event?.type === "content_block_delta" ? message.event.delta : undefined;
  if (delta?.type === "text_delta" && delta.text) {
    emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: delta.text } });
  } else if (delta?.type === "thinking_delta" && delta.thinking) {
    emit({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: delta.thinking } });
  }
}

/** Each tool the assistant called. */
function emitToolCalls(message: ClaudeMessage, emit: (update: acp.SessionUpdate) => void): void {
  for (const block of message.message?.content ?? []) {
    if (block.type !== "tool_use" || !block.id) continue;
    emit({
      sessionUpdate: "tool_call",
      toolCallId: block.id,
      title: toolTitle(block.name ?? "tool"),
      kind: "other",
      status: "in_progress",
      rawInput: block.input,
    });
  }
}

/** Each tool call's result. */
function emitToolResults(message: ClaudeMessage, emit: (update: acp.SessionUpdate) => void): void {
  for (const block of message.message?.content ?? []) {
    if (block.type !== "tool_result" || !block.tool_use_id) continue;
    emit({
      sessionUpdate: "tool_call_update",
      toolCallId: block.tool_use_id,
      status: block.is_error ? "failed" : "completed",
    });
  }
}

/** The turn's usage, and each model's calls, from Claude Code's `result` line. */
function claudeTotals(final: ClaudeMessage | undefined): {
  usage: TokenUsage;
  calls: ReportedCall[];
} {
  const calls: ReportedCall[] = Object.entries(final?.modelUsage ?? {}).map(([model, u]) => ({
    model: `claude-code-subscription:${model}`,
    purpose: "turn",
    usage: {
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      cacheReadTokens: u.cacheReadInputTokens ?? 0,
      cacheWriteTokens: u.cacheCreationInputTokens ?? 0,
    },
  }));
  const u = final?.usage;
  const usage: TokenUsage = u
    ? {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      }
    : emptyUsage();
  return { usage, calls };
}

/** `mcp__nimblebrain__nb__status` → `nb__status`: the projected tool's own name. */
function toolTitle(name: string): string {
  const prefix = `mcp__${SERVER}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function capture(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: subscriptionEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("error", reject);
    child.on("close", () => resolve(out));
  });
}
