import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { FeatureFlags } from "../config/features.ts";
import type { ConfirmationGate } from "../config/privilege.ts";
import type { SecretsConfig } from "../config/secrets.ts";
import type { TasksConfig } from "../config/tasks.ts";
import type { ConnectorsConfig } from "../connectors/providers/config.ts";
import type { EventSink, ThinkingEffort } from "../engine/types.ts";
import type { ContentPart, FileReference } from "../files/types.ts";
import type { IdentityProvider, UserIdentity } from "../identity/provider.ts";
import type { UserStore } from "../identity/user.ts";
import type { ProvidersConfig } from "../model/registry.ts";
import type { NotificationsPollConfig } from "../notifications/poll-config.ts";
import type { TokenUsage } from "../usage/types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { AdmissionLease } from "./admission.ts";
import type { RunTrigger } from "./run-spec.ts";
import type { SpendAccount } from "./spend.ts";

/** Model slot configuration. Each slot maps to a provider:model-id string. */
export interface ModelSlots {
  /** Primary model for chat and general requests. */
  default: string;
  /** Cheap/fast model for auto-title and both history folds. */
  fast: string;
}

/** The runtime's identity stores, handed to `RuntimeConfig.identityProvider`. */
export interface IdentityStores {
  workDir: string;
  userStore: UserStore;
  workspaceStore: WorkspaceStore;
}

export interface RuntimeConfig {
  /**
   * One model that serves every model string, in place of the provider
   * registry. For tests and embedders that bring their own adapter; it has no
   * `nimblebrain.json` form. Slots, policy and provider listings still read
   * `models` and `providers`.
   */
  languageModel?: LanguageModelV4;

  /** Provider configuration. Absent means Anthropic, keyed from the environment. */
  providers?: ProvidersConfig["providers"];

  /** Allow HTTP (non-TLS) remote connector connections. Dev only. */
  allowInsecureRemotes?: boolean;

  /** Directories to scan for skill files. */
  skillDirs?: string[];

  /**
   * Slots the operator set. Partial because setting one slot is not setting
   * the other — the resolved view where both are always present is
   * `Runtime.configuredModelSlots()`. If this were the full `ModelSlots`,
   * writing one slot would force a value into the other, and that invented
   * value would read back as a deliberate choice.
   */
  models?: Partial<ModelSlots>;
  /**
   * Which models this organization permits, as qualified `provider:id`
   * strings. Absent or empty means permissive — every chat-capable model from
   * every configured provider — so an existing deployment changes nothing and
   * an org opts *into* restriction.
   *
   * Distinct from the provider allowlist, which says what this deployment can
   * *reach*. This says what it permits of what it can reach, and can only
   * subtract: naming a model whose provider has no key does not make it
   * reachable.
   */
  modelPolicy?: { allowed?: string[] };

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
   * Extended-thinking mode, honored on any model the catalog flags
   * reasoning-capable and translated into that provider's own dialect. A model
   * without the flag is sent nothing, whatever this says.
   *
   *   - `off`        — do not reason. Cheapest; no reasoning content.
   *   - `adaptive`   — model decides per call, at no stated depth.
   *   - `enabled`    — reason on every turn, at `thinkingEffort`.
   *
   * If unset, reasoning-capable models default to `enabled` at
   * `DEFAULT_THINKING_EFFORT` and everything else to no thinking at all.
   *
   * `off` is not enforceable everywhere. Anthropic's adaptive-only models
   * (Opus 4.7/4.8, Sonnet 5, Opus 5) have no "do not reason" state, and the
   * AI SDK validates `thinking.type=disabled` and then never sends it — so
   * the model applies its own default, which for the 5-series is to reason.
   * See the config reference.
   */
  thinking?: "off" | "adaptive" | "enabled";

  /**
   * How hard to think when reasoning is on. The portable knob: every
   * reasoning-capable provider can express a depth, whereas a token budget
   * is specific to the two that meter thinking in tokens.
   *
   * Applies to `thinking: "enabled"` and to the platform default path.
   * Ignored for `off` and `adaptive` (adaptive states no depth by
   * definition). Defaults to `DEFAULT_THINKING_EFFORT`.
   */
  thinkingEffort?: ThinkingEffort;

  /**
   * Explicit token budget for thinking, for operators who want to meter it
   * in tokens rather than name a depth. Counts toward `maxOutputTokens`;
   * Anthropic requires a minimum of 1,024.
   *
   * Only meaningful on providers that meter thinking in tokens (Anthropic
   * models up to 4.6, Gemini 2.5). On effort-shaped providers — including
   * Gemini 3, which takes a level rather than a budget — it is ignored in
   * favor of `thinkingEffort`: a budget cannot be converted into a depth
   * without inventing precision the number does not carry.
   *
   * Prefer `thinkingEffort` unless you specifically need a token cap.
   */
  thinkingBudgetTokens?: number;

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

  /** Feature flags to enable/disable capabilities. All default to true. */
  features?: FeatureFlags;

  /**
   * Managed-connector providers (Composio and Smithery today). A provider is registered —
   * and its routes, probe, and vendor SDK reached — only when its block is
   * declared here; only the broker credential also reads `<VENDOR>_API_KEY` when the block
   * is absent. See `src/connectors/providers/config.ts`.
   */
  connectors?: ConnectorsConfig;

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

  /**
   * Durable usage ledger — one JSONL line per priced LLM call, under
   * `{workDir}/usage/`. See `src/usage/ledger.ts`.
   */
  usage?: {
    ledger?: {
      /** Default true. False disables the write path; the reader still reads. */
      enabled?: boolean;
      /** Months of history to keep. Default 24; 0 keeps everything. */
      retentionMonths?: number;
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

  /**
   * Builds the identity provider, for an in-process caller that supplies its
   * own (a test). It is handed the runtime's own stores, the ones a provider
   * built from `instance.json` gets. Omitted, the runtime builds the one
   * `<workDir>/instance.json` names. The HTTP server authenticates with
   * whichever one the runtime holds.
   */
  identityProvider?: (stores: IdentityStores) => IdentityProvider;

  /**
   * Which backend holds this deployment's secrets, and that backend's own
   * settings. Omit for the default: one plaintext file per secret under
   * `workDir`. See {@link SecretsConfig}.
   */
  secrets?: SecretsConfig;

  /** Anonymous telemetry configuration. */
  telemetry?: {
    /** Enable anonymous telemetry. Default: true. */
    enabled?: boolean;
  };

  /** Legacy tenant defaults; `preferences` takes precedence over both. */
  home?: {
    /** Legacy fallback for `preferences.displayName`. */
    userName?: string;
    /** IANA timezone (e.g., "Pacific/Honolulu"). Empty uses system timezone. */
    timezone?: string;
  };

  /**
   * Notifications — how the runtime reads the outboxes connectors declare.
   *
   * Only the poll's pacing is configurable. What an outbox contains, and who
   * is allowed to declare one, are the server's and the operator's decisions
   * respectively; what it *costs* is the runtime's, and this is where an
   * operator moves that cost. See `src/notifications/poll-config.ts`.
   */
  notifications?: {
    poll?: NotificationsPollConfig;
  };

  /**
   * Tasks — how many runs the process holds in flight and waiting, and
   * the ceilings on any one run. See `src/config/tasks.ts`.
   */
  tasks?: TasksConfig;

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
  /** UI state pushed by the app via Synapse `updateModelContext()`. */
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
   * viewing, plumbed from the workspace in the chat URL). Drives the
   * deterministic, workspace-scoped **briefing**: the Installed Apps
   * section and the org/workspace instruction overlays reflect THIS
   * workspace, identical for every member (no per-user generation).
   *
   * It is ALSO the tool scope: a session is walled to this one workspace —
   * its tools plus the caller's identity tools, all bare, via
   * `listToolsForWorkspace(workspaceId)`. There is no cross-workspace union.
   * Required at runtime, under every identity provider: a request naming
   * none is refused, and the runtime never chooses a workspace for it.
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
   * deadline (e.g. the tasks executor's `Promise.race` against
   * `maxRunDurationMs`) ORPHAN the in-flight LLM/tool work — the chat
   * keeps running, finishes, writes the conversation to disk, but the
   * caller never sees the result. Production proof: a task's
   * runs completed in 6-7m while the 5m
   * Promise.race silently abandoned them, leaving fake `timeout` run
   * records and ~$X of wasted LLM spend per missed run.
   *
   * Cooperative: the engine checks the signal between iterations and the
   * current tool call may run to completion before the loop exits. Long-
   * running tools honor the signal via the contract in src/tools/AGENTS.md
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
   * Tool calls executed during this run. `name` is the wire form the model
   * called: bare `<source>__<tool>`, with the caller's personal connectors
   * carrying the reserved `my_` marker. Stored raw; display name and friendly
   * name are rendered on the fly. The workspace is NOT in the name — it is the
   * session's, resolved from the conversation. There is no top-level
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
 * the agent runs without a user present (scheduled tasks, eval
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
 *                             focused-workspace briefing). `nb__search`
 *                             discovers the rest of that one bound
 *                             workspace on demand — there is no
 *                             cross-workspace union, and Layer 3 connector
 *                             skills come from the bound workspace only.
 *
 * Each call is a one-shot run owned by `identity` that produces a
 * deliverable — NOT a conversation. There is no continuation and no
 * resume; the returned `TaskResult.runId` is a traceability anchor for
 * the run's persisted result. Conversation history loading, content-parts,
 * file refs, and SSE streaming UI affordances are chat concerns and
 * intentionally absent here.
 */
export interface TaskRequest {
  /** The task description. Goes in as the user message. */
  prompt: string;
  /**
   * What woke the agent. `schedule` is a tasks cron tick, `manual` an
   * operator pressing Run now; the default `api` covers a caller driving the
   * runtime directly (embedded, CLI, evals). `chat` is not reachable here —
   * that trigger has its own door.
   *
   * The door stamps it on the run's `agent.turn` span, which is where a
   * scheduled run is told apart from an operator's one after the fact.
   */
  trigger?: Exclude<RunTrigger, "chat">;
  /**
   * Identity the task runs under. Resolution mirrors `ChatRequest.identity`:
   * it MUST be set; a task without one is refused. The scheduler builds a
   * minimal identity from the task's `ownerId` field.
   */
  identity?: UserIdentity;
  /**
   * The workspace the task runs in. Drives the active tool set (that
   * workspace's tools + identity tools; `nb__search` discovers the rest of
   * that one workspace, NOT a cross-workspace union) and the workspace
   * briefing layer in the system prompt. Required at runtime, as for
   * `ChatRequest.workspaceId`: a task naming none is refused.
   */
  workspaceId?: string;
  model?: string;
  maxIterations?: number;
  /**
   * Input tokens the whole run may spend, summed over every model call. Before
   * each call the run ends with stopReason `max_input_tokens` if that call's
   * projected input would pass it (see `EngineConfig.maxRunInputTokens`).
   * Absent = no cap.
   */
  maxRunInputTokens?: number;
  /**
   * The spend accounts the run draws on: opaque ids the caller chose, each with
   * a unit and the amount remaining. Runs in flight that name the same id share
   * one balance. Each model call's output is clamped to what they allow, and
   * the run ends with stopReason `spend_limit` before a call they cannot pay
   * for (`src/runtime/spend.ts`). Absent = no account.
   */
  spendAccounts?: SpendAccount[];
  /** Glob patterns filtering which tools are available. Matches use the same logic as chat. */
  allowedTools?: string[];
  /**
   * Arbitrary metadata. The tasks executor stamps `source` and
   * `taskId` here so the run is correlated to its task in logs
   * and audit. Pass-through; the runtime does not persist a conversation.
   */
  metadata?: Record<string, unknown>;
  /**
   * Cancellation signal forwarded into the engine and threaded down to
   * every tool call. Same morning-brief contract as `ChatRequest.signal`:
   * without it, callers racing the task against an external deadline
   * (notably the tasks executor's `Promise.race` against
   * `maxRunDurationMs`) orphan in-flight LLM/tool work.
   *
   * A run still waiting for a run slot leaves the queue when it fires, and
   * the call rejects with an `AbortError`.
   */
  signal?: AbortSignal;
  /**
   * The run's id, when the caller named it before the run started: a caller
   * that hands out a handle for the run (a task id) mints the id first, so the
   * handle and the run's own records share it. Absent: the door mints one.
   */
  runId?: string;
  /**
   * An opaque key for run admission (`src/runtime/admission.ts`): a call whose
   * key already holds a slot or waits for one is refused. The runtime never
   * interprets it. Ignored when `admission` is passed.
   */
  admissionKey?: string;
  /**
   * A slot the caller already holds from `Runtime.getRunAdmission()`, for a
   * caller that must know at request time whether its run started or queued
   * and re-check its own state when the slot is granted. The run uses it
   * instead of acquiring one, and releases it when it ends. A lease the pool
   * does not hold is ignored, and the run acquires its own.
   */
  admission?: AdmissionLease;
}

/**
 * Result shape for `runtime.executeTask()`.
 *
 * Modeled on `ChatResult` but with chat-specific fields removed:
 *  - No `skillName` — task mode does not perform skill matching on the
 *    prompt; connector-affined skills still surface via Layer 3.
 *  - `response` renamed to `output` to reflect the deliverable contract.
 *  - `runId` is a traceability anchor — the id of the run, under which the
 *    caller (the tasks app) persists the run result (output +
 *    activity log + output-file refs). No conversation is created.
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
  /** Traceability anchor — the id of this run. The caller persists the run's
   *  result (output, activity log, output-file refs) under this id. */
  runId: string;
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
  /**
   * The last model call's unified finish reason and provider-native stop
   * reason. See `EngineResult.finishReason` / `finishReasonRaw`. Together they
   * let the caller explain a `stopReason` of "other", which several distinct
   * provider outcomes share.
   */
  finishReason?: string;
  finishReasonRaw?: string;
  /** The account that stopped the run, when `stopReason` is `spend_limit`. */
  spendAccountId?: string;
  usage: TurnUsage;
}
