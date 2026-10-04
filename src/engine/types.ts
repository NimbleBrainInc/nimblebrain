import type { LanguageModelV4Message } from "@ai-sdk/provider";
import type { McpUiToolVisibility } from "@modelcontextprotocol/ext-apps";
import type { ContentBlock, TextContent, ToolAnnotations } from "@modelcontextprotocol/server";
import type { TokenUsage } from "../usage/types.ts";
import type { EngineEventPayloads } from "./schemas/events.ts";

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
 * connector able to set it could mute a curated overlay by name. `McpSource`
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
 * stricter one: a connector able to set this could mute another vendor's
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
  /**
   * The tool's `_meta` — MCP's free-form, reverse-DNS-keyed namespace. Carries
   * host conventions and the MCP Apps UI metadata (`ui.resourceUri`, which the
   * engine reads to mount an inline panel, and `ui.visibility`).
   *
   * Distinct from {@link ToolSchema.annotations}, which is the spec's own
   * closed set of behavioural hints. Both travel; neither is the other.
   */
  meta?: Record<string, unknown>;
  /**
   * MCP `annotations` (`ToolAnnotations`) — the spec's behavioural hints:
   * `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`,
   * `openWorldHint`.
   *
   * Hints, per the spec, and from an untrusted server: a `destructiveHint` is
   * what the tool *says* about itself, so read it to be more careful, never to
   * relax a check.
   */
  annotations?: ToolAnnotations;
  /**
   * MCP `outputSchema` — the JSON Schema a tool's `structuredContent` conforms
   * to when it declares one.
   */
  outputSchema?: Record<string, unknown>;
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
   * set it on their `ToolResult`, MCP connector results carry it from the wire.
   * It is NOT the tool's data payload (that's `content` / `structuredContent`)
   * — it's metadata *about* the result, keyed by reverse-DNS namespace per the
   * MCP convention (`io.modelcontextprotocol/...`, `ai.nimblebrain/...`).
   *
   * Forwarding lives at the two serialization boundaries, not per-source:
   * `defineInProcessApp` (every in-process tool, system tools included)
   * and `McpSource` (connector results, inline + task paths). A direct `ToolSource`
   * that returns a `ToolResult` with no boundary in between carries `_meta`
   * natively — no forwarding needed. So any tool, in-process or
   * connector, can opt into a `_meta` hint and have it reach the engine.
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
 * field (dropped at the boundary): the platform's own tools are in-process MCP
 * servers, so `_meta` is the only channel that reaches the engine.
 *
 * Host-owned: set by the platform's own in-process tools (`nb__search`) and
 * stripped from anything a connector returns (`hostOwnedMetaStripped`). Only the
 * tool knows what "no progress" means for its own result, which is why the flag
 * lives on the result and not in a host heuristic.
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
 * Host-owned, because the supervisor trusts it unconditionally: a connector able to
 * set it could exempt itself from the guard permanently.
 *
 * `McpSource` owns it on two channels, and both need closing because a connector
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
 * Who may reach a tool, per the MCP Apps spec's `_meta.ui.visibility`. Absent,
 * a tool is `["model", "app"]`. `"model"` makes it visible to and callable by
 * the agent; `"app"` makes it callable by a view of the same server.
 *
 * The spec binds a host on two paths, and each is enforced where the caller is
 * known:
 *
 *   - A tool without `"model"` is left out of every tool list that reaches a
 *     model: the chat list (`surfaceTools`), `nb__search`, the `/mcp`
 *     `tools/list`, the invalid-name recovery hint, and promotion. The engine,
 *     the host on the chat door, also refuses a model's call that names one.
 *     `/mcp` refuses an agent's call that names one: any call that is not an
 *     app's, which takes a first-party credential naming a source
 *     (`isAppCall` in `src/api/mcp-server.ts`). REST admits first-party
 *     credentials only, and the web shell's settings reach the platform's own
 *     UI-driven tools there.
 *   - A `tools/call` from an app is refused for a tool without `"app"`
 *     (`/mcp`, keyed on the source the iframe bridge names).
 *
 * It applies to every tool alike, a connector's over the wire or the
 * platform's own in-process ones, which declare `{ ui: { visibility: ["app"] } }`.
 * An entry that is not an array is read as absent, the spec's default.
 */
export function toolVisibility(tool: {
  meta?: Record<string, unknown>;
}): readonly McpUiToolVisibility[] {
  const ui = tool.meta?.ui as { visibility?: unknown } | undefined;
  const visibility = ui?.visibility;
  if (!Array.isArray(visibility)) return DEFAULT_TOOL_VISIBILITY;
  return visibility.filter((v): v is McpUiToolVisibility => v === "model" || v === "app");
}

const DEFAULT_TOOL_VISIBILITY: readonly McpUiToolVisibility[] = ["model", "app"];

/** True when the agent may see and call a tool (`"model"` in its visibility). */
export function isModelVisible(tool: { meta?: Record<string, unknown> }): boolean {
  return toolVisibility(tool).includes("model");
}

/** True when a view of the tool's own server may call it (`"app"` in its visibility). */
export function isAppCallable(tool: { meta?: Record<string, unknown> }): boolean {
  return toolVisibility(tool).includes("app");
}

export interface ToolPromotionResult {
  ok: boolean;
  toolName: string;
  changed: boolean;
  message: string;
  reason?: string;
}

export interface ToolPromotionControls {
  /**
   * Async because a name missing from the run's tool lookups triggers one
   * re-read of the router: a connector that was restarting when the run began
   * comes back mid-run, and `nb__search` (which reads live) can list its tools.
   */
  addTool(toolName: string): Promise<ToolPromotionResult>;
  removeTool(toolName: string): ToolPromotionResult;
}

/** Port 3: Observability event sink. */
export interface EventSink {
  emit(event: EngineEvent): void;
}

/** Every engine event type: the keys of `EngineEventPayloads`. */
export type EngineEventType = keyof EngineEventPayloads;

/**
 * An engine event: a `type` and the payload `EngineEventPayloads` declares for
 * it. Narrowing on `event.type` narrows `event.data`.
 */
export type EngineEvent = {
  [K in EngineEventType]: { type: K; data: EngineEventPayloads[K] };
}[EngineEventType];

/** The event of one type. */
export type EngineEventOf<K extends EngineEventType> = Extract<EngineEvent, { type: K }>;

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
    messages: LanguageModelV4Message[],
    opts: { iteration: number; signal?: AbortSignal },
  ) => Promise<LanguageModelV4Message[] | null>;

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
    messages: LanguageModelV4Message[],
    opts?: { overflowAttempt?: number },
  ) => LanguageModelV4Message[];

  /**
   * Gate or modify a model tool call before execution. Return null to skip the
   * tool. Called only with a call the engine has already coerced and validated
   * against the tool's schema, so a call the engine would refuse never reaches
   * it; whatever it returns is checked the same way again before dispatch.
   */
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

/** How the engine reaches a run's spend accounts. See `EngineConfig.spend`. */
export interface SpendGate {
  /**
   * Before a model call: the largest output, at most `maxOutputTokens`, the
   * accounts can pay for alongside `inputTokens`, reserved against them until
   * the call's `debit`. Refused, naming the account, when the input alone does
   * not fit or the output allowed falls below `minOutputTokens`.
   */
  check(call: {
    inputTokens: number;
    maxOutputTokens: number;
    minOutputTokens: number;
  }): { maxOutputTokens: number } | { accountId: string };
  /** After the call: release its reservation and debit its actual usage from every account. */
  debit(actual: TokenUsage): void;
}

/** Engine configuration per run. */
export interface EngineConfig {
  model: string;
  maxIterations: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  /**
   * Cap on the input tokens the whole run may spend, summed over every model
   * call, as the provider reports them (cache reads and writes included, so
   * it is a token cap, not a cost cap). `maxInputTokens` bounds one call's
   * context; this bounds the run. Before each call the engine projects that
   * call's input as the larger of its estimate of the prompt about to be sent
   * and the previous call's reported input, and ends the run with stopReason
   * `max_input_tokens` when the tokens already spent plus the projection would
   * pass the cap. The run ends within the cap unless the estimate undercounts
   * the prompt. Absent means no cap.
   */
  maxRunInputTokens?: number;
  /**
   * The run's spend accounts, as the runtime holds them. Before each model call
   * the engine asks `check` with the call's projected input (as for
   * `maxRunInputTokens`) and its output ceiling, and sends the call with its
   * `maxOutputTokens` clamped to what the accounts allow; a refusal ends the
   * run with stopReason `spend_limit`, naming the account, before the call is
   * sent. After each call the engine passes its actual usage to `debit`. The
   * engine never reads what an account is. Absent means no account.
   */
  spend?: SpendGate;
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
   * "Long-Running Tools (MCP Tasks)" section in src/tools/AGENTS.md for the contract.
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
  /**
   * Present when the body is fetched on demand (a server-published skill):
   * the engine calls it when the candidate fires, and surfaces nothing when it
   * resolves `null`. `body` is empty until then.
   */
  loadBody?: () => Promise<string | null>;
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
  scope: "org" | "workspace" | "user" | "provided";
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
 * Per-LLM-call finish reason (mirrors AI SDK V4 `LanguageModelV4FinishReason.unified`).
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
 *   - `max_input_tokens` — the next model call would take the run past
 *                          `EngineConfig.maxRunInputTokens`
 *   - `spend_limit`      — the run's spend accounts (`EngineConfig.spend`)
 *                          cannot pay for the next model call's input and a
 *                          minimal output; the account is
 *                          `EngineResult.spendAccountId`
 *   - `length`           — last LLM call hit `maxOutputTokens` mid-turn
 *   - `content_filter`   — last LLM call was blocked by provider moderation
 *   - `error`            — last LLM call's finish reason was `error`
 *   - `other`            — anything else (provider returned `other` / `unknown`)
 *   - `cancelled`        — the run's abort signal fired, whatever the cause
 *                          (the Stop button, a task cancel or timeout,
 *                          the per-run event cap, shutdown). It appears only
 *                          on the `run.done` event: the engine rethrows the
 *                          abort, so no EngineResult carries it.
 *
 * `error` here is the *finish-reason* error category, not a thrown engine
 * error — the latter emits `run.error` instead.
 *
 * Note the casing asymmetry vs `FinishReason`: the V4 spec uses
 * kebab-case (`content-filter`, `tool-calls`); our run-level union uses
 * snake_case to match the legacy `max_iterations` value already in
 * persisted JSONL. They're related but not identical — see
 * `deriveStopReason()` in engine.ts for the mapping.
 */
export type StopReason =
  | "complete"
  | "max_iterations"
  | "max_input_tokens"
  | "spend_limit"
  | "length"
  | "content_filter"
  | "error"
  | "other"
  | "cancelled";

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
  /**
   * Final LLM call's provider-native stop reason (`LanguageModelV4FinishReason.raw`,
   * e.g. Anthropic `end_turn` / `compaction`), or `NO_FINISH_PART_RAW` when the
   * stream ended without a finish part. Several raw values collapse to the
   * unified "other", so this is what names the actual cause. Absent when the
   * provider reported none.
   */
  finishReasonRaw?: string;
  /** The account that stopped the run, when `stopReason` is `spend_limit`. */
  spendAccountId?: string;
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
   * logical error the agent handled. The tasks executor reads this to
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
