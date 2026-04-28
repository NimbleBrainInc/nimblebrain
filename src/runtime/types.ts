import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { FeatureFlags } from "../config/features.ts";
import type { ConfirmationGate } from "../config/privilege.ts";
import type { ConversationStore } from "../conversation/types.ts";
import type { EventSink } from "../engine/types.ts";
import type { ContentPart, FileReference } from "../files/types.ts";
import type { ProvidersConfig } from "../model/registry.ts";

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

  /** Max output tokens per LLM call. Default: 16_384. */
  maxOutputTokens?: number;

  /**
   * Extended-thinking mode. Currently maps to Anthropic's `thinking`
   * provider option; non-Anthropic providers ignore it.
   *
   *   - `off`        — never request thinking. Cheapest; no reasoning content.
   *   - `adaptive`   — model decides per call (Anthropic's recommended default
   *                    for reasoning-capable models like Opus 4.7 / Sonnet 4.6).
   *   - `enabled`    — always think, with optional `thinkingBudgetTokens` cap.
   *
   * If unset, the platform defaults to `adaptive` for catalog-flagged
   * reasoning-capable models and `off` otherwise.
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

  /** Path to nimblebrain.json. Used for config persistence. */
  configPath?: string;

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
  /** Workspace scope for this request. Resolved by middleware from header, conversation, or default. */
  workspaceId?: string;
  /** When set, the chat is scoped to a specific app. */
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
  identity?: import("../identity/provider.ts").UserIdentity;
}

/** Detailed usage breakdown for a single chat turn. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  model: string;
  llmMs: number;
  iterations: number;
}

export interface ChatResult {
  response: string;
  conversationId: string;
  /** Workspace ID this chat was scoped to, if any. */
  workspaceId?: string;
  skillName: string | null;
  toolCalls: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    output: string;
    ok: boolean;
    ms: number;
  }>;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
  /** Detailed usage breakdown for this turn. */
  usage: TurnUsage;
}
