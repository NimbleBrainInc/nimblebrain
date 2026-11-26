/**
 * A backend is one vendor's own agent CLI (`claude`, `codex`), run as the
 * person signed in to it, so its model calls are billed to their subscription.
 * The worker never sees or forwards a model credential: the CLI reads its own
 * login, and the backend refuses to run when the CLI would bill an API key.
 */

import type { ChildProcess } from "node:child_process";
import type * as acp from "@agentclientprotocol/sdk/unstable";
import { classifyFailure, cliMissing, type Vendor } from "./failure.ts";

/** Token counts, in NimbleBrain's usage shape (`src/usage/types.ts`). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/** One model call the turn made, as the runtime's driver reads it. */
export interface ReportedCall {
  /** Not a catalog model id, so the runtime's ledger prices it at $0: the subscription pays. */
  model: string;
  purpose: "turn";
  usage: TokenUsage;
}

/** What the CLI is signed in as, from its own status command. */
export interface Account {
  /** One line for a person: "Claude Max subscription (claude.ai login)". */
  describe: string;
  /** The plan alone, for a person: "Claude Max", "ChatGPT". */
  plan: string;
}

export interface TurnInput {
  /** The whole turn as text: the door's history and latest message. */
  prompt: string;
  /** The door's system prompt, for a backend that takes one. */
  system?: string;
  /**
   * `turn` for a chat turn or a run; `internal` for the door's own model work
   * (a conversation's title, a history summary), which needs no tool and runs
   * on the backend's fast model with no MCP server attached.
   */
  purpose: SessionPurpose;
  /** The loopback MCP endpoint that serves this session's NimbleBrain tools; absent for `internal`. */
  mcpUrl?: string;
  signal: AbortSignal;
  /** Stream one ACP session update to the runtime. */
  emit(update: acp.SessionUpdate): void;
}

/** What a session is for, from `session/new`'s `_meta` (`SESSION_META_KEY`); absent is `turn`. */
export type SessionPurpose = "turn" | "internal";

export interface TurnResult {
  stopReason: acp.StopReason;
  usage: TokenUsage;
  calls: ReportedCall[];
}

export interface Backend {
  id: "claude-code" | "codex";
  /** For a person: "Claude Code", "Codex". */
  label: string;
  /** The model its turns run on, as a person reads it ("Sonnet"); absent when the CLI's own default. */
  modelLabel?: string;
  /** Whether the CLI takes a system prompt that replaces its own. */
  takesSystemPrompt: boolean;
  /**
   * Whether the CLI's only tools are the session's NimbleBrain tools. Codex
   * keeps a read-only shell that cannot be switched off.
   */
  toolsAreNimbleBrainOnly: boolean;
  /** Confirm the CLI is installed and signed in to a subscription, not an API key. Throws why not. */
  preflight(): Promise<Account>;
  run(input: TurnInput): Promise<TurnResult>;
}

/** Why a backend will not run: each is a different thing for the person to do. */
export type Refusal = "not_installed" | "not_signed_in" | "api_key" | "unreadable";

/** Thrown for a reason a person can act on; the message says what to do. */
export class BackendRefused extends Error {
  readonly reason: Refusal;
  constructor(reason: Refusal, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** The keys a CLI would bill instead of the subscription, removed from every child's environment. */
export const API_KEY_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
];

/** `env` (default the worker's own) without any API key, so the CLI falls back to its own login. */
export function subscriptionEnv(from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(from)) {
    if (value !== undefined && !API_KEY_VARIABLES.includes(key)) env[key] = value;
  }
  return env;
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/**
 * Rejects when `child` could not be started: `cli_missing` when its binary is
 * not found, else `cli_failed`, so a turn that races it fails instead of
 * waiting on output that never comes. Never resolves; handled here, so a
 * failure after the turn ended is not unhandled.
 */
export function spawnFailure(child: ChildProcess, vendor: Vendor): Promise<never> {
  const failed = new Promise<never>((_, reject) => {
    child.once("error", (err: NodeJS.ErrnoException) =>
      reject(
        err.code === "ENOENT"
          ? cliMissing(vendor)
          : classifyFailure(vendor, `could not be started: ${err.message}`),
      ),
    );
  });
  failed.catch(() => {});
  return failed;
}
