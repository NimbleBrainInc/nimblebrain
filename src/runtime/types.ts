import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { FeatureFlags } from "../config/features.ts";
import type { ConfirmationGate } from "../config/privilege.ts";
import type { ConversationStore } from "../conversation/types.ts";
import type { EventSink } from "../engine/types.ts";
import type { ContentPart, FileReference } from "../files/types.ts";
import type { UserIdentity } from "../identity/provider.ts";
import type { ProvidersConfig } from "../model/registry.ts";
import type { TokenUsage } from "../usage/types.ts";

/** Model slot configuration. Each slot maps to a provider:model-id string. */
export interface ModelSlots {
  /** Primary model for chat and general requests. */
  default: string;
  /** Cheap/fast model for briefings, auto-title, skill matching. */
  fast: string;
  /** Most capable model for complex analysis and planning. */
  reasoning: string;
}

/** Named agent profile for multi-agent delegation via nb__delegate. */
export interface AgentProfile {
  description: string;
  systemPrompt: string;
  tools: string[];
  maxIterations?: number;
  model?: string;
}

export interface RuntimeConfig {
  /** Model provider configuration. */
  model?:
    | { provider: "anthropic"; apiKey?: string }
    | { provider: "openai"; apiKey?: string; baseURL?: string }
    | { provider: "google"; apiKey?: string }
    | { provider: "custom"; adapter: LanguageModelV3 };

  /** Multi-provider configuration. Takes precedence over `model` when set. */
  providers?: ProvidersConfig["providers"];

  /** Allow HTTP (non-TLS) remote bundle connections. Dev only. */
  allowInsecureRemotes?: boolean;

  /** Directories to scan for skill files. */
  skillDirs?: string[];

  /** Conversation storage. Default: in-memory. */
  store?:
    | { type: "jsonl"; dir: string }
    | { type: "memory" }
    | { type: "custom"; adapter: ConversationStore };

  /** Role-based model slots. Takes precedence over `defaultModel`. */
  models?: ModelSlots;

  /** @deprecated Use models.default instead. Kept for backward compat. */
  defaultModel?: string;

  /** Max agentic iterations per request. Capped at 25. Default: 10. */
  maxIterations?: number;

  /** Max input tokens per request. Default: 500_000. */
  maxInputTokens?: number;

  /**
   * Max output tokens per LLM call. When unset, resolves to the model's
   * catalog output ceiling (e.g. 128k for Opus 4.6+, 64k for Sonnet 4.6) —
   * see `resolveMaxOutputTokens`. The static 16_384 is only the last-resort
   * fallback for a model that isn't in the catalog. Pinning a value here
   * caps DOWN from the catalog ceiling.
   */
  maxOutputTokens?: number;

  /**
   * Extended-thinking mode. Currently maps to Anthropic's `thinking`
   * provider option; non-Anthropic providers ignore it.
   *
   *   - `off`        — never request thinking. Cheapest; no reasoning content.
   *   - `adaptive`   — model decides per call.
   *   - `enabled`    — always think, with optional `thinkingBudgetTokens` cap.
   *
   * If unset, the platform defaults to `enabled` (with a budget capped at
   * roughly half of `maxOutputTokens`) for catalog-flagged reasoning-capable
   * models and `off` otherwise. The default was changed from `adaptive`
   * after production showed Opus 4.7 routinely consumed the entire output
   * budget on internal reasoning, producing empty user-visible turns on
   * long-context tasks.
   */
  thinking?: "off" | "adaptive" | "enabled";

  /**
   * Token budget when `thinking === "enabled"`. Counts toward
   * `maxOutputTokens`. Ignored for `off`/`adaptive`. Anthropic requires
   * a minimum of 1,024 tokens.
   */
  thinkingBudgetTokens?: number;

  /** Max conversation history messages to keep. Default: 40. */
  maxHistoryMessages?: number;

  /** Max chars for a single tool result. 0 disables. Default: 1_000_000. */
  maxToolResultSize?: number;

  /** Event sinks for observability. */
  events?: EventSink[];

  /** Structured logging configuration. Enabled by default. */
  logging?: {
    /** Log directory. Default: workDir + "/logs". */
    dir?: string;
    /** Disable structured logging entirely. Default: false. */
    disabled?: boolean;
    /** Logging verbosity level. "debug" persists verbose fields. Default: "normal". */
    level?: "normal" | "debug";
    /** Auto-delete log files older than N days on startup. No cleanup when omitted. */
    retentionDays?: number;
  };

  /** HTTP server configuration. */
  http?: {
    /** Port number. Default: 27247. */
    port?: number;
    /** Host to bind to. Default: "127.0.0.1". */
    host?: string;
  };

  /** Named agent profiles for multi-agent delegation. */
  agents?: Record<string, AgentProfile>;

  /** Feature flags to enable/disable capabilities. All default to true. */
  features?: FeatureFlags;

  /** Confirmation gate for privileged operations and credential prompts. */
  confirmationGate?: ConfirmationGate;

  /**
   * MCP session metadata store. Controls how sessions for `/mcp` are tracked
   * across the cluster. Defaults to `memory` (process-local) — fine for any
   * single-replica deploy. Set `type: "redis"` with a `redis.url` for
   * multi-replica deploys; the registry shares session metadata across
   * processes. See `src/api/session-store/`.
   */
  sessionStore?: {
    type?: "memory" | "redis";
    /** Idle TTL in seconds. Default: 28800 (8 h). */
    ttlSeconds?: number;
    redis?: {
      url?: string;
      keyPrefix?: string;
    };
  };

  /** Path to nimblebrain.json. The Helm-managed seed file. Overwritten on every deploy. */
  configPath?: string;

  /**
   * Path to nimblebrain.overrides.json. The user-managed override file written
   * by `set_model_config`. Preserved across deploys (init container leaves it
   * alone). Loaded by `loadConfig` and 1-level deep-merged over the seed —
   * override values win. Defaults to a sibling of `configPath` (`<dir>/
   * nimblebrain.overrides.json`).
   */
  configOverridePath?: string;

  /**
   * Working directory for all runtime state (conversations, skills, cache).
   * Defaults to ~/.nimblebrain. Set to an isolated path for testing.
   * Subdirectories: conversations/, skills/, cache/
   */
  workDir?: string;

  /** Anonymous telemetry configuration. */
  telemetry?: {
    /** Enable anonymous telemetry. Default: true. */
    enabled?: boolean;
  };

  /** Home dashboard configuration. */
  home?: {
    /** Enable the Home dashboard. Default: true. */
    enabled?: boolean;
    /** Model for briefing generation. Null uses "fast" model slot. */
    model?: string | null;
    /** User's first name for the greeting. Default: "there". */
    userName?: string;
    /** IANA timezone (e.g., "Pacific/Honolulu"). Empty uses system timezone. */
    timezone?: string;
    /** Briefing cache TTL in minutes. Default: 5. */
    cacheTtlMinutes?: number;
  };

  /** File context configuration. */
  files?: {
    maxFileSize?: number;
    maxTotalSize?: number;
    maxFilesPerMessage?: number;
    maxExtractedTextSize?: number;
  };

  /** User preferences for personalization. */
  preferences?: {
    /** Display name. Falls back to home.userName. */
    displayName?: string;
    /** IANA timezone. Falls back to home.timezone. */
    timezone?: string;
    /** BCP 47 locale. Default: "en-US". */
    locale?: string;
    /** Color theme. Default: "system". */
    theme?: "system" | "light" | "dark";
  };
}

/** Identifies which app (and its backing MCP server) originated a chat request. */
export interface AppContext {
  appName: string;
  serverName: string;
  /** UI state pushed by the app via Synapse `setVisibleState()`. */
  appState?: {
    state: Record<string, unknown>;
    summary?: string;
    updatedAt: string;
  };
}

export interface ChatRequest {
  message: string;
  conversationId?: string;
  model?: string;
  maxIterations?: number;
  /**
   * The workspace the chat is *focused* on (the `/w/:slug` the user is
   * viewing, plumbed from the `X-Workspace-Id` header). Drives the
   * deterministic, workspace-scoped **briefing**: the Installed Apps
   * section and the org/workspace instruction overlays reflect THIS
   * workspace, identical for every member (no per-user generation).
   *
   * It is ALSO the tool scope: a session is walled to this one workspace —
   * its tools (namespaced) plus the caller's identity tools, via
   * `listToolsForWorkspace(workspaceId)`. There is no cross-workspace union.
   * Absent → the chat isn't focused on a workspace (e.g. the home control
   * panel); it falls back to the personal workspace, which is then the room.
   */
  workspaceId?: string;
  /**
   * When set, the chat is scoped to a specific app.
   *
   * The chat surface is identity-bound but WALLED to one workspace. Tools come
   * from `listToolsForWorkspace(workspaceId)` (that workspace + identity tools)
   * and each tool call routes through the orchestrator's parsed-namespace path,
   * which denies any other workspace. The `workspaceId` field above is both the
   * tool scope and the *focused* workspace for the deterministic briefing
   * (apps + overlays). Per-call workspace attribution lives on the tool's
   * namespace prefix.
   */
  appContext?: AppContext;
  /** Additional content parts from file uploads (text extracts, images). */
  contentParts?: ContentPart[];
  /** File references for conversation metadata (stored alongside the message). */
  fileRefs?: FileReference[];
  /** Arbitrary metadata stored in the conversation's JSONL first line. Pass-through, no validation. */
  metadata?: Record<string, unknown>;
  /** Glob patterns filtering which tools are available. Matches use same logic as skill allowed-tools. */
  allowedTools?: string[];
  /** Authenticated user identity for this request. Set by API middleware. */
  identity?: UserIdentity;
  /**
   * Cancellation signal forwarded to the engine and threaded down to every
   * tool call via `EngineConfig.signal`. When aborted, the agent loop stops
   * before its next iteration; in-flight task-augmented MCP tools receive
   * `tasks/cancel`; inline tool calls abort their RPC.
   *
   * Without this, callers racing `runtime.chat()` against an external
   * deadline (e.g. the automations executor's `Promise.race` against
   * `maxRunDurationMs`) ORPHAN the in-flight LLM/tool work — the chat
   * keeps running, finishes, writes the conversation to disk, but the
   * caller never sees the result. Production proof: `morning-brief-6am-pt`
   * runs in ws_nimblebrain_shared completed in 6-7m while the 5m
   * Promise.race silently abandoned them, leaving fake `timeout` run
   * records and ~$X of wasted LLM spend per missed run.
   *
   * Cooperative: the engine checks the signal between iterations and the
   * current tool call may run to completion before the loop exits. Long-
   * running tools honor the signal via the contract in CLAUDE.md
   * §"Long-Running Tools (MCP Tasks)".
   */
  signal?: AbortSignal;
}

/**
 * Detailed usage breakdown for a single chat turn.
 *
 * Carries the canonical TokenUsage plus runtime-added fields. NO costUsd —
 * cost is a derived value computed at the API boundary from
 * `cost(model, usage)`. Storing it here would invite the same drift bug
 * that double-billed cache tokens (issue #140): a stored derived value
 * that consumers forgot to refresh when its inputs changed.
 */
export interface TurnUsage extends TokenUsage {
  model: string;
  llmMs: number;
  iterations: number;
}

export interface ChatResult {
  response: string;
  conversationId: string;
  skillName: string | null;
  /**
   * Tool calls executed during this run. `name` is the canonical
   * namespaced form `ws_<id>-<source>__<tool>` — Q2 of
   * `STAGE_2_DESIGN_DECISIONS.md`: store the raw namespaced form;
   * render display-name + friendly name on the fly. Per-turn workspace
   * attribution lives here on each call's name, NOT on a top-level
   * `ChatResult.workspaceId` field (removed by T006 — different tool
   * calls in the same turn can land in different workspaces, so a
   * single result-level workspaceId would be misleading).
   */
  toolCalls: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    output: string;
    ok: boolean;
    ms: number;
    /** Structured failure reason when `ok === false`. See ToolCallRecord.errorReason. */
    errorReason?: string;
  }>;
  stopReason: string;
  /** Detailed usage breakdown for this turn. */
  usage: TurnUsage;
}

/**
 * Request shape for `runtime.executeTask()` — the unattended agent
 * invocation primitive that sits beside `runtime.chat()`. Use this when
 * the agent runs without a user present (scheduled automations, eval
 * runs, future webhook triggers). The runtime owns the framing contract
 * (no greetings, deliverable output, no follow-up questions) via the
 * task-mode system prompt; callers supply only the task description.
 *
 * Two ways to scope tool reach (mirrors chat's active-vs-discoverable
 * pattern — progressive disclosure keeps the active set under
 * `maxActiveTools`):
 *  - `workspaceId` set      → active tools are that workspace's tools
 *                             + identity tools; the system prompt's
 *                             workspace briefing names that workspace.
 *  - `workspaceId` omitted  → active tools are the owner's personal-
 *                             workspace tools + identity tools (no
 *                             focused-workspace briefing). The full
 *                             cross-workspace tool union is the
 *                             DISCOVERABLE corpus reached on demand via
 *                             `nb__search`, not the active toolset.
 *                             (Bundle workflow guidance via Layer 3
 *                             DOES aggregate across every workspace the
 *                             owner can see, so a discovered tool's
 *                             usage skill is available when it lands.)
 *
 * Each call writes a FRESH conversation owned by `identity`. There is no
 * continuation, no `conversationId` to resume — the returned
 * `TaskResult.conversationId` is for traceability only. Conversation
 * history loading, content-parts, file refs, and SSE streaming UI
 * affordances are chat concerns and intentionally absent here.
 */
export interface TaskRequest {
  /** The task description. Goes in as the user message. */
  prompt: string;
  /**
   * Identity the task runs under. Resolution mirrors `ChatRequest.identity`:
   * if an identity provider is configured, this MUST be set; in dev mode
   * an unset identity falls back to `DEV_IDENTITY`. The scheduler builds
   * a minimal identity from the automation's `ownerId` field.
   */
  identity?: UserIdentity;
  /**
   * Focused workspace (optional). When set, drives the active tool set
   * (that workspace's tools + identity tools) and the focused-workspace
   * briefing layer in the system prompt. When omitted, the active tool
   * set is the owner's personal-workspace tools + identity tools; the
   * full cross-workspace tool union is the discoverable corpus via
   * `nb__search`, NOT the active toolset (progressive disclosure, same
   * shape as chat at the identity-level home). The focused-workspace
   * briefing layer is skipped — `TASK_IDENTITY` carries the framing.
   */
  workspaceId?: string;
  model?: string;
  maxIterations?: number;
  maxInputTokens?: number;
  /** Glob patterns filtering which tools are available. Matches use the same logic as chat. */
  allowedTools?: string[];
  /** Arbitrary metadata stored on the conversation's first line. Pass-through. */
  metadata?: Record<string, unknown>;
  /**
   * Cancellation signal forwarded into the engine and threaded down to
   * every tool call. Same morning-brief contract as `ChatRequest.signal`:
   * without it, callers racing the task against an external deadline
   * (notably the automations executor's `Promise.race` against
   * `maxRunDurationMs`) orphan in-flight LLM/tool work.
   */
  signal?: AbortSignal;
}

/**
 * Result shape for `runtime.executeTask()`.
 *
 * Modeled on `ChatResult` but with chat-specific fields removed:
 *  - No `skillName` — task mode does not perform skill matching on the
 *    prompt; bundle-affined skills still surface via Layer 3.
 *  - `response` renamed to `output` to reflect the deliverable contract.
 *  - `conversationId` is purely a traceability anchor: the fresh
 *    conversation that backs this task. The "Open conversation →" UI
 *    affordance reaches it.
 *
 * Always returned on completion — including timeout, max_iterations,
 * and content_filter stops. Pre-execution failures (identity bad,
 * recursive-tool guard, validation) throw synchronously; once the
 * engine starts, every observable outcome returns a `TaskResult` with
 * `stopReason` telling the caller what happened. Silent abandonment
 * is the worst failure mode (see `ChatRequest.signal` docstring).
 */
export interface TaskResult {
  /** The deliverable — the agent's final assistant message text. */
  output: string;
  /** Traceability anchor — the fresh conversation backing this task. */
  conversationId: string;
  /** Tool calls executed during this run. Same shape as ChatResult.toolCalls. */
  toolCalls: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    output: string;
    ok: boolean;
    ms: number;
    /** Structured failure reason when `ok === false`. See ToolCallRecord.errorReason. */
    errorReason?: string;
  }>;
  stopReason: string;
  usage: TurnUsage;
}
