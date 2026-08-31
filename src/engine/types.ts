import type { LanguageModelV3Message } from "@ai-sdk/provider";
import type { ContentBlock, TextContent } from "@modelcontextprotocol/sdk/types.js";
import type { TokenUsage } from "../usage/types.ts";

export type { ContentBlock, TextContent };

/**
 * Metadata marker stamped on the synthetic message the reconstructor builds
 * from a `connector.skill.injected` event. The engine reads it on replay
 * (`history.some(m => m.metadata?.synthetic === CONNECTOR_SKILL_SYNTHETIC)`) to
 * detect an already-surfaced connector overlay and never re-inject it. Lives
 * here — the dependency-safe shared home — because both the engine (producer of
 * the dedup contract) and the conversation reconstructor (which stamps it) need
 * it, and `engine/` must not import `conversation/`.
 */
export const CONNECTOR_SKILL_SYNTHETIC = "connector_skill_injected";

/**
 * Metadata marker stamped on the reconstructed tool-result message of a
 * `nb__use_skill` activation (from its `skill.activated` event). Same dedup
 * contract as {@link CONNECTOR_SKILL_SYNTHETIC}: the runtime and the engine's
 * history-scan fallback treat a skill delivered this way as already-delivered,
 * so the surface-once overlay path never re-injects a body the model already
 * holds via activation. Compaction folds the tool message like any other, so
 * one re-delivery after a fold is possible — matching overlay semantics.
 */
export const SKILL_ACTIVATED_SYNTHETIC = "skill_activated";

/**
 * Reverse-DNS `_meta` key a skill-activation tool result carries to tell the
 * engine "this result delivered skill X's full body". Value shape:
 * `{ skillName: string; scope: string; tokens: number }`.
 *
 * On seeing it, the engine emits `skill.activated` (persisted into the
 * conversation log for telemetry + cross-turn dedup) and adds the name to the
 * run's injected-skill set so the surface-once overlay path won't deliver the
 * same guidance twice in one run.
 *
 * Host-owned: the engine trusts it to suppress future guidance delivery, so a
 * bundle able to set it could mute a curated overlay by name. `McpSource`
 * strips it from results arriving over a real wire; only in-process platform
 * sources (the `skills` source) may carry it through.
 */
export const SKILL_ACTIVATED_META_KEY = "ai.nimblebrain/skill-activated";

/**
 * `_meta` marker: this tool call muted a skill for THIS CONVERSATION. The
 * engine turns it into a persisted `skill.suppression` event, which the next
 * turn's composition reads.
 *
 * Host-owned for the same reason as the activation marker above, and a
 * stricter one: a bundle able to set this could mute another vendor's
 * always-on guidance — the consistency gate, the safety rules — by name, for
 * the rest of the conversation, invisibly. `McpSource` strips it from anything
 * arriving over a real wire; only in-process platform sources may carry it.
 */
export const SKILL_SUPPRESSION_META_KEY = "ai.nimblebrain/skill-suppression";

/** Port 2: Tool routing abstraction. */
export interface ToolRouter {
  availableTools(): Promise<ToolSchema[]>;
  /**
   * Execute a tool call. The optional `signal` propagates run-scoped
   * cancellation from the engine down to the tool implementation. For
   * task-augmented MCP tools it becomes `tasks/cancel`; for inline tools
   * it's an `AbortSignal` forwarded on the request.
   *
   * Identity context flows through `runWithRequestContext`'s
   * AsyncLocalStorage — sources that need the caller's identity read it
   * there. No principal argument is threaded through the router.
   */
  execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult>;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** MCP tool annotations (_meta). Includes UI metadata like resourceUri. */
  annotations?: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError: boolean;
  /**
   * Free-form out-of-band metadata, mirroring MCP's `CallToolResult._meta`.
   * Round-trips across the tool boundary in both directions: in-process tools
   * set it on their `ToolResult`, MCP bundle results carry it from the wire.
   * It is NOT the tool's data payload (that's `content` / `structuredContent`)
   * — it's metadata *about* the result, keyed by reverse-DNS namespace per the
   * MCP convention (`io.modelcontextprotocol/...`, `ai.nimblebrain/...`).
   *
   * Forwarding lives at the two serialization boundaries, not per-source:
   * `defineInProcessApp` (every in-process tool, incl. system tools + delegate)
   * and `McpSource` (bundle results, inline + task paths). A direct `ToolSource`
   * that returns a `ToolResult` with no boundary in between carries `_meta`
   * natively — no forwarding needed. So any tool, in-process or
   * bundle, can opt into a `_meta` hint and have it reach the engine.
   */
  _meta?: Record<string, unknown>;
}

/**
 * Reverse-DNS `_meta` key a tool sets (to `true`) to mark its result as making
 * no forward progress — e.g. a discovery search that matched nothing, or a
 * lookup against unchanged state.
 *
 * The loop supervisor collapses consecutive non-advancing results from the
 * same tool to one fingerprint and trips regardless of how input or output
 * varied between calls — the counterpart to the input-aware success
 * fingerprint, which treats a varied input as progress and so never trips a
 * flailing discovery loop (model varies the query every call, same dead end).
 *
 * It rides in `_meta` — the MCP-blessed channel for metadata-about-a-result —
 * rather than `structuredContent` (the tool's data) or a bespoke top-level
 * field (dropped at the boundary). Any tool, in-process or bundle, can set it.
 */
export const NON_ADVANCING_META_KEY = "ai.nimblebrain/non-advancing";

/**
 * Reverse-DNS `_meta` key marking an error result as an INFRASTRUCTURE failure —
 * the call never reached the tool's logic, or its answer never made it back.
 * Transport loss, a gateway throttle, a session that rolled.
 *
 * The loop supervisor excludes these from its strike count. Its whole premise is
 * that a repeated identical error means the tool is deterministically refusing
 * the work, so calling it again is futile — true for a schema rejection or a
 * permanent 4xx, and false for every failure in this class. An infrastructure
 * error carries no information about whether the tool would do the work; it says
 * the request didn't arrive. Retrying is the correct response, and the
 * supervisor's response (disable the tool for the rest of the run) is the one
 * thing that guarantees the work cannot finish.
 *
 * It matters most in exactly the case that trips the guard fastest: the ERROR
 * fingerprint deliberately ignores input, so N calls with N distinct arguments
 * that all fail the same infrastructural way collapse to one fingerprint and
 * trip after three.
 *
 * Host-owned, because the supervisor trusts it unconditionally: a bundle able to
 * set it could exempt itself from the guard permanently. That is the asymmetry
 * with `NON_ADVANCING_META_KEY` above, which IS safe to accept from a bundle —
 * setting that one makes the guard stricter; this one makes it weaker.
 *
 * `McpSource` owns it on two channels, and both need closing because a bundle
 * controls both:
 *
 *   - the `_meta` key, stripped from anything arriving over the wire;
 *   - the DECISION, which additionally refuses any `McpError` — three of the
 *     allowlisted classes are matched by regex over the server's own error text,
 *     so a JSON-RPC error the server authored never earns the marker however its
 *     message is spelled.
 *
 * That second condition is a denylist of one type, not a proof of transport
 * origin. Residual, deliberately accepted: a bare `Error` carrying server text
 * still qualifies — `startToolAsTask` re-throws a task-creation failure that way
 * (#838). An allowlist over throw types would drop `fetch failed` and reset
 * sockets, which is a worse trade.
 */
export const INFRA_ERROR_META_KEY = "ai.nimblebrain/infra-error";

/**
 * Annotation marking a tool as a UI-driven affordance, not an agent capability.
 * An internal tool is stripped from every LLM tool listing — chat
 * (`surfaceTools`) and `/mcp` (`tools/list`) alike — and refused for promotion,
 * yet stays callable by name (so the web shell's REST calls still work). Single
 * source of the key: use {@link isInternalTool} to read it and this const as the
 * annotation key to set it, so a rename can never split the read/write sites.
 */
export const INTERNAL_TOOL_ANNOTATION = "ai.nimblebrain/internal";

/** True when a tool carries {@link INTERNAL_TOOL_ANNOTATION}. */
export function isInternalTool(tool: { annotations?: Record<string, unknown> }): boolean {
  return Boolean(tool.annotations?.[INTERNAL_TOOL_ANNOTATION]);
}

export interface ToolPromotionResult {
  ok: boolean;
  toolName: string;
  changed: boolean;
  message: string;
  reason?: string;
}

export interface ToolPromotionControls {
  addTool(toolName: string): ToolPromotionResult;
  removeTool(toolName: string): ToolPromotionResult;
}

/** Port 3: Observability event sink. */
export interface EventSink {
  emit(event: EngineEvent): void;
}

export type EngineEventType =
  | "chat.start"
  | "run.start"
  | "text.delta"
  | "reasoning.delta"
  | "tool.preparing"
  | "tool.preparing.done"
  | "tool.start"
  | "tool.done"
  | "tool.progress"
  | "tool.promoted"
  | "tool.released"
  | "llm.done"
  /**
   * A provider LLM call failed terminally — the call threw and the in-call
   * retry was exhausted (or a context overflow could not be recovered).
   * NOT emitted for user-initiated cancellations (abort). Payload: { runId,
   * model }. Observe-only signal for the LLM error-rate metric; the error
   * itself still propagates and ends the run as `run.error`.
   */
  | "llm.error"
  | "run.done"
  | "run.error"
  | "skills.loaded"
  /**
   * A curated connector-skill overlay was surfaced into the conversation for
   * the first time, triggered by a matching connector tool call. The
   * reconstructor turns this into a synthetic message carrying the skill
   * body, placed after the tool results of the iteration that triggered it, so
   * the guidance rides the cached, append-only history and is in context for
   * the model's next action instead of re-entering the system prefix. Emitted
   * at most once per (conversation, skill). Payload: { runId, toolName,
   * skillName, skillBody, scope }.
   */
  | "connector.skill.injected"
  /**
   * A catalog skill's full body was delivered to the model via the
   * `nb__use_skill` activation tool. The body itself persists as the tool
   * result (`tool.done`), so — unlike `connector.skill.injected` — the
   * reconstructor synthesizes NO extra message for this event; it only stamps
   * the dedup marker on the reconstructed tool result. Emitted at most once
   * per (conversation, skill). Payload: { runId, toolCallId, skillName,
   * scope, tokens }.
   */
  | "skill.activated"
  | "skill.suppression"
  | "context.assembled"
  /**
   * Emitted when a model call is rejected for exceeding the context window
   * and the engine re-windows history with a tighter budget before retrying.
   * Payload: { runId, attempt, previousMessageCount, errorMessage }.
   */
  | "context.overflow_recovery"
  /**
   * Emitted when a turn is cut off at the model's output ceiling
   * (`finishReason: "length"`) with no pending tool call and the engine
   * auto-resumes it from the partial text rather than ending the run.
   * Payload: { runId, continuation } where `continuation` is the 1-based
   * resume count (bounded by MAX_LENGTH_CONTINUATIONS).
   */
  | "context.length_continuation"
  | "bundle.installed"
  | "bundle.uninstalled"
  | "bundle.upgraded"
  /**
   * Per-principal connection state change for a remote URL bundle.
   * Payload: { wsId, serverName, principalId, state, authorizationUrl? }.
   * Workspace-scoped bundles emit one event stream (principalId = "_workspace");
   * member-scoped bundles emit one stream per active member.
   */
  | "connection.state_changed"
  | "data.changed"
  | "conversation.title"
  | "config.changed"
  | "skill.created"
  | "skill.updated"
  | "skill.deleted"
  | "file.created"
  | "file.deleted"
  | "bridge.tool.call"
  | "bridge.tool.done"
  | "http.error"
  | "audit.auth_failure"
  | "audit.permission_denied";

/**
 * Generic event envelope. Per-event-type payload schemas are declared in
 * `./schemas/events.ts` (TypeBox + `Static<typeof X>` types). Code that
 * needs the precise payload shape can import the typed payload directly
 * (`SkillsLoadedPayload`, `DataChangedPayload`, etc.) and narrow on
 * `event.type` before access. Tightening `data` here to a discriminated
 * union over those payloads is a follow-up — it requires auditing every
 * consumer to add the corresponding `event.type === "..."` narrowing.
 */
export interface EngineEvent {
  type: EngineEventType;
  data: Record<string, unknown>;
}

/** Hooks for intercepting the engine loop at 5 strategic points. */
export interface EngineHooks {
  /**
   * Replace the run's accumulated history between iterations. Called with the
   * messages the engine is about to send; returning `null` leaves the history
   * untouched, returning an array replaces it for the rest of the run.
   *
   * Distinct from `transformContext`, which shapes ONE call and is discarded
   * afterwards — a rewrite here is durable, so what the caller drops is gone
   * from every later iteration of this run. The engine is deliberately
   * incurious about why: it owns the loop, the caller owns context policy (the
   * runtime folds an over-budget history into a summary through this seam).
   *
   * Two properties the engine does rely on. The returned array must be a valid
   * message sequence — no tool call left without its result — because it is
   * sent as-is. And a rewrite changes the cached prefix, so a caller that
   * rewrites every iteration pays a full cache write every iteration; rewrites
   * are expected to be rare and deliberate.
   *
   * `opts.signal` is the run's own signal. The engine awaits this hook, so a
   * hook that makes a network call has to honor it or a cancelled turn waits
   * for that call to finish.
   */
  rewriteHistory?: (
    messages: LanguageModelV3Message[],
    opts: { iteration: number; signal?: AbortSignal },
  ) => Promise<LanguageModelV3Message[] | null>;

  /**
   * Modify messages before LLM call (e.g., windowing, context injection).
   *
   * `opts.overflowAttempt` is set by the engine when re-invoking after a
   * provider-reported context-overflow error. `0` (or undefined) is the
   * first attempt; positive values are recovery retries — the hook is
   * expected to return more aggressively trimmed messages each step.
   * Hooks that don't care about recovery can ignore the second argument.
   */
  transformContext?: (
    messages: LanguageModelV3Message[],
    opts?: { overflowAttempt?: number },
  ) => LanguageModelV3Message[];

  /** Gate or modify tool calls before execution. Return null to skip the tool. */
  beforeToolCall?: (call: ToolCall) => ToolCall | null | Promise<ToolCall | null>;

  /** Modify or log tool results after execution. */
  afterToolCall?: (call: ToolCall, result: ToolResult) => ToolResult | Promise<ToolResult>;

  /** Transform system prompt before LLM call. */
  transformPrompt?: (prompt: string) => string;
}

/**
 * Provider-neutral reasoning depth — how hard the model should think,
 * expressed independently of how any one provider spells it.
 *
 * This is the platform's canonical currency for thinking. Providers that
 * take an effort tier natively receive it directly; providers that take a
 * token budget have one sized from it. The reverse (deriving a tier from a
 * budget) is not done, because a budget the operator never set has no
 * intent in it to recover.
 *
 * The ladder is Anthropic's, which is the widest of the providers in use.
 * `max` has no OpenAI equivalent and clamps to `xhigh` there.
 */
export type ThinkingEffort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Where a resolved depth came from. Three states because two consumers ask
 * different questions of it, and collapsing them to one boolean gets one of
 * them wrong:
 *
 *   - `operator`  — the operator named this tier (`thinkingEffort`). Only this
 *                   may override a provider's own default, so only this steps
 *                   to a neighbouring level when the model lacks the tier.
 *   - `mode`      — the operator configured thinking (`thinking`, or a bare
 *                   `thinkingBudgetTokens`) but named no depth. Their intent is
 *                   real and worth reporting when it can't be honored, but the
 *                   tier attached to it is still the platform's, so it must not
 *                   displace what the provider would do on its own.
 *   - `platform`  — nothing was configured. Silent, and never overriding.
 */
export type EffortSource = "operator" | "mode" | "platform";

/**
 * Depth used when reasoning is on but the operator named no tier.
 *
 * `medium` rather than the top of the ladder: the default applies to every
 * turn on a reasoning model, including trivial ones, and the deepest tiers
 * cost real latency and tokens. An operator who wants more says so.
 */
export const DEFAULT_THINKING_EFFORT: ThinkingEffort = "medium";

/**
 * Provider-neutral extended-thinking config. The engine translates this to
 * per-provider options at call time in `buildThinkingProviderOptions`.
 *
 * Four arms, because providers genuinely differ in what they accept:
 *   - `off`      — do not reason. Not enforceable on every model; see the
 *                  engine's Anthropic branch.
 *   - `adaptive` — the model decides per call. No depth expressed.
 *   - `effort`   — reason at a named depth. The portable arm, and the one the
 *                  platform default path produces. `source` says where the
 *                  depth came from: a tier the operator didn't name must never
 *                  override a provider's own default, or it becomes the same
 *                  "directive from a number nobody chose" this shape exists to
 *                  remove.
 *   - `enabled`  — reason within an explicit token budget. The budget is only
 *                  meaningful on providers that meter thinking in tokens, so
 *                  this arm carries `effort` too: it is what the effort-shaped
 *                  providers use, and it keeps a chosen depth from being
 *                  silently voided by setting a budget alongside it.
 *
 * Resolution priority is handled upstream (see resolveThinking in
 * src/runtime/resolve-thinking.ts); the engine receives an already-
 * resolved value or `undefined` for "let the provider default decide".
 */
export type ResolvedThinking =
  | { mode: "off" }
  | { mode: "adaptive" }
  | { mode: "effort"; effort: ThinkingEffort; source: EffortSource }
  | { mode: "enabled"; budgetTokens: number; effort: ThinkingEffort; source: EffortSource };

/** Engine configuration per run. */
export interface EngineConfig {
  model: string;
  maxIterations: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  /**
   * Resolved thinking option for this call. Optional; absent means the
   * engine doesn't request thinking (provider default behavior).
   */
  thinking?: ResolvedThinking;
  hooks?: EngineHooks;
  /**
   * AbortSignal for run cancellation.
   *
   * Propagated down through `ToolRouter.execute(call, signal)` to the
   * underlying tool source. For task-augmented MCP tools this becomes
   * `tasks/cancel` on the server; for inline tools the SDK aborts the
   * in-flight RPC. Long-running tools MUST honor this signal — see the
   * "Long-Running Tools (MCP Tasks)" section in CLAUDE.md for the contract.
   */
  signal?: AbortSignal;
  /**
   * Maximum char size of a single tool result's ContentBlock[].
   * Results exceeding this are replaced with an isError summary before
   * event emission, hooks, or history accumulation.
   * Set to 0 to disable. Defaults to 1_000_000 (1M chars).
   */
  maxToolResultSize?: number;
  /**
   * Pre-computed run-scope telemetry the runtime hands to the engine so the
   * engine can emit it tied to the same `runId` as `run.start`. The engine
   * fires these immediately after `run.start` and before the first LLM call,
   * so the conversation log records what the prompt looked like.
   *
   * Phase 2: `skills.loaded` and `context.assembled` payloads. Future phases
   * may add more entries here without touching the engine signature.
   */
  runMetadata?: RunMetadata;
  /**
   * Connector-skill overlay candidates for this run. Curated usage
   * guidance for connectors the platform doesn't control, loaded as
   * `scope: connector` and surfaced ONCE into the conversation history on the
   * first matching tool call — never into the cached system prefix. The engine
   * matches each candidate's `toolAffinity` globs against the called tool name;
   * on the first match (per conversation, deduped via history inspection) it
   * emits `connector.skill.injected` and appends the body to the live history
   * after that iteration's tool results; the reconstructor rebuilds it in the
   * same position. Empty / absent = the feature is off for this run.
   */
  connectorSkillCandidates?: ConnectorSkillCandidate[];
  /**
   * Names of connector overlays already surfaced earlier in this conversation,
   * so the engine never re-injects them (cross-run dedup). The runtime
   * computes this from the UN-rehydrated reconstructed history: the synthetic
   * marker lives in message `metadata`, which `rehydrateUserResources` strips
   * before the engine sees the messages, so the engine's own history scan can't
   * be the sole source on the real chat path. The scan remains a fallback for
   * callers that pass metadata-bearing messages directly (the engine+store test).
   */
  alreadyInjectedConnectorSkills?: string[];
  toolPromotion?: {
    isToolEligible(tool: ToolSchema): boolean;
    registerControls(controls: ToolPromotionControls): () => void;
  };
  /**
   * Cap on the active tool list during this run, including agent-promoted
   * tools. When `addTool` would push past this cap, the least-recently-used
   * agent-promoted tool is evicted (initial tools passed to `run()` are
   * never evicted). Defaults to `DEFAULT_MAX_DIRECT_TOOLS` from `limits.ts`
   * — the same invariant `surfaceTools` enforces at run start.
   */
  maxActiveTools?: number;
}

/**
 * A connector-skill overlay considered for surface-once-into-history during a
 * run. The runtime loads these from the workspace's `connector-skills/`
 * candidate store (NOT `/skills`) and hands them to the engine via
 * {@link EngineConfig.connectorSkillCandidates}. They are NEVER composed into
 * the system prompt — the engine surfaces a matched candidate into the
 * conversation history exactly once.
 */
export interface ConnectorSkillCandidate {
  /** Skill name — matches the materialized overlay's manifest `name`. */
  name: string;
  /** Manifest `description` — the skill-catalog line for this overlay. */
  description?: string;
  /** The overlay body (markdown) to surface into history, verbatim. */
  body: string;
  /** Scope label for containment / telemetry. Always `"connector"` in v1. */
  scope: string;
  /** Tool-affinity globs (e.g. `["<server>__*"]`); the first match triggers surfacing. */
  toolAffinity: string[];
}

/**
 * Pre-emit telemetry attached to an engine run. The runtime computes this
 * before calling `engine.run()`; the engine emits matching events after
 * `run.start`. Shared between `EngineConfig` and the runtime helpers
 * (`buildSkillsLoadedPayload` / `buildContextAssembledPayload`) so any
 * shape drift is a type error rather than silent disagreement.
 */
export interface RunMetadata {
  skillsLoaded?: SkillsLoadedPayload;
  contextAssembled?: ContextAssembledPayload;
}

export interface SkillsLoadedPayload {
  skills: SkillsLoadedEntry[];
  totalTokens: number;
}

export interface ContextAssembledPayload {
  sources: ContextAssembledSource[];
  excluded: ContextAssembledSource[];
  totalTokens: number;
  modelMaxContext?: number;
  headroomTokens?: number;
}

/**
 * Per-skill telemetry attached to a `skills.loaded` event. Re-exported
 * from `src/conversation/types.ts` so emitters and persisters reference
 * one definition; drift surfaces as a type error.
 *
 * `contentHash` is the SHA-256 (hex) of the skill body that was composed
 * into the prompt. Lets debug tools detect mutation between when the
 * skill loaded and when an operator inspects it:
 *   - hash matches current source → display body verbatim, full fidelity
 *   - hash differs → look up against `_versions/` snapshots to find the
 *     body that actually loaded, or surface a "this skill changed since"
 *     warning if no matching snapshot exists.
 *
 * Cheap (~64 bytes per skill per turn); decoupled from the body itself
 * so event size stays bounded.
 */
export interface SkillsLoadedEntry {
  id: string;
  /**
   * The skill's own name, for display. Always set by
   * `buildSkillsLoadedPayload`; optional because events recorded before the
   * field existed are read back through this same type — read it through
   * `skillDisplayName` (`src/skills/display-name.ts`), never bare.
   *
   * Carried on the event so no consumer derives a name from `id`: a connector
   * skill's id is its `skill://…/SKILL.md` entrypoint, whose last path segment
   * is the literal `SKILL`.
   */
  name?: string;
  /**
   * The MCP server that published this skill, when it came from one. Absent for
   * filesystem skills (org / workspace / user tiers), which have no publisher.
   */
  connector?: string;
  /**
   * The loading mechanism's layer: `0` = always-on context, `3` = tool-affinity
   * (the conditional channel), `4` = trigger match. Historical events only ever
   * carried `3`; the read path treats this additively so they still parse.
   */
  layer: 0 | 3 | 4;
  scope: "org" | "workspace" | "user" | "bundle";
  version: string;
  tokens: number;
  /** SHA-256 hex of the skill body composed into the prompt. */
  contentHash: string;
  loadedBy: "always" | "tool_affinity" | "trigger";
  reason: string;
}

/**
 * One entry in `context.assembled.sources` / `excluded`. Required `tokens`
 * + free-form discriminators (`count`, `messages`, etc.) per source
 * kind. Tightening the engine payload to this shape (vs `Record<string,
 * unknown>`) prevents emitters from accidentally shipping rows without a
 * token count.
 */
export interface ContextAssembledSource {
  kind: string;
  count?: number;
  tokens: number;
  toolSetHash?: string;
  version?: string | number;
  userId?: string;
  /** `history`: how many messages the windowed history holds. */
  messages?: number;
  /**
   * `history`, as recorded before `messages` existed. Carried the same message
   * count under a name that read as conversational turns; kept so historical
   * events still render. Emitters set `messages`.
   */
  turns?: number;
  compacted?: boolean;
}

/**
 * Per-LLM-call finish reason (mirrors AI SDK V3 `LanguageModelV3FinishReason.unified`).
 * Persisted on `llm.response` events so post-hoc analysis can tell a clean
 * stop from a length-truncated turn from a content-filter rejection.
 */
export type FinishReason = "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";

/**
 * Run-level stop reason. Derived from the agent loop's exit condition
 * combined with the final LLM call's finish reason:
 *
 *   - `complete`         — model said done (finish=stop) with no pending tools
 *   - `max_iterations`   — agent loop hit its iteration cap
 *   - `length`           — last LLM call hit `maxOutputTokens` mid-turn
 *   - `content_filter`   — last LLM call was blocked by provider moderation
 *   - `error`            — last LLM call's finish reason was `error`
 *   - `other`            — anything else (provider returned `other` / `unknown`)
 *
 * `error` here is the *finish-reason* error category, not a thrown engine
 * error — the latter still emits `run.error` instead.
 *
 * Note the casing asymmetry vs `FinishReason`: the V3 spec uses
 * kebab-case (`content-filter`, `tool-calls`); our run-level union uses
 * snake_case to match the legacy `max_iterations` value already in
 * persisted JSONL. They're related but not identical — see
 * `deriveStopReason()` in engine.ts for the mapping.
 */
export type StopReason =
  | "complete"
  | "max_iterations"
  | "length"
  | "content_filter"
  | "error"
  | "other";

/** Result returned from a single engine run. */
export interface EngineResult {
  output: string;
  toolCalls: ToolCallRecord[];
  iterations: number;
  /** Cumulative token usage across all LLM calls in this run. */
  usage: TokenUsage;
  /** Cumulative LLM latency across all calls in this run. */
  llmMs: number;
  stopReason: StopReason;
  /** Final LLM call's finish reason. Useful for diagnosing why the loop ended. */
  finishReason?: FinishReason;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output: string;
  ok: boolean;
  ms: number;
  /**
   * Structured error reason when `ok === false`, lifted from the tool
   * result's `structuredContent.reason`. Lets downstream consumers
   * distinguish a tool call that could not be ROUTED (a connector missing
   * from the workspace, disconnected, or in a workspace the caller can't
   * reach — `unknown_tool_source`, `workspace_access_denied`, …; see
   * `src/orchestrator/error-mapping.ts`) from a tool that ran and returned a
   * logical error the agent handled. The automations executor reads this to
   * de-mask runs that "completed" only by writing around an unreachable
   * connector. Absent when the call succeeded or carried no structured reason.
   */
  errorReason?: string;
  resourceUri?: string;
  /**
   * MCP `resource_link` content blocks surfaced by the tool result.
   * Distinct from `resourceUri`: this is a per-call, spec-defined pointer
   * to resources the client should fetch via `resources/read`.
   */
  resourceLinks?: Array<{
    uri: string;
    name?: string;
    mimeType?: string;
    description?: string;
  }>;
}
