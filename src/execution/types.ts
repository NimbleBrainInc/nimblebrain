/**
 * The agent runtime seam.
 *
 * `Runtime.startRun` decides a run: the workspace, the membership gate, the
 * composed prompt, the walled tool router, the history, the model and the
 * limits. An {@link AgentRuntime} executes what the door decided and reports
 * back through the same event sink every runtime writes to. It may narrow what
 * the run allows and never widens it, so the door stays the only place a run's
 * reach is decided (ADR-0021, ADR-0047).
 *
 * Nothing here names a protocol or a vendor. The native engine, an agent
 * reached over ACP, and a runtime that runs elsewhere are all implementations;
 * which one runs a run is installation configuration (`execution` in
 * `nimblebrain.json`), never the task author's or the model's choice.
 */

import type { LanguageModelV4Message } from "@ai-sdk/provider";
import type {
  EngineConfig,
  EngineResult,
  EventSink,
  ToolRouter,
  ToolSchema,
} from "../engine/types.ts";

/**
 * What a runtime does on its own, so the door can refuse a run it cannot hold
 * to its limits instead of running it on weaker terms.
 */
export interface RuntimeCapabilities {
  /**
   * The runtime checks every model call against the run's spend accounts
   * before it is sent (`EngineConfig.spend`). A run that names accounts is
   * refused by a runtime without it.
   */
  spendGate: boolean;
  /**
   * The runtime runs NimbleBrain's own loop policy: in-turn context windowing,
   * mid-turn compaction, tool promotion, the loop supervisor, and bound-skill
   * delivery (`EngineConfig.hooks`, `toolPromotion`, `connectorSkillCandidates`).
   * Without it the agent manages its own working context, and only the policy
   * at the tool boundary applies (`src/execution/tool-projection.ts`).
   */
  loopPolicy: boolean;
}

/**
 * One run, as the door resolved it. Every field is NimbleBrain's own type;
 * a runtime that speaks a protocol translates at its own edge.
 */
export interface ResolvedRun {
  /**
   * The door's run id. An external runtime stamps it on every event it emits;
   * the native engine still mints its own per-loop id for its events.
   */
  runId: string;
  /** The conversation the run belongs to, or `null` for a one-shot run. */
  conversationId: string | null;
  /** The system prompt the door composed (its cached prefix). */
  system: string;
  /**
   * The history the model is given, oldest first, ending with the message
   * that opened this run. The door owns it: it is read back from the
   * conversation log, windowed and compacted before any runtime sees it.
   */
  messages: LanguageModelV4Message[];
  /** The tools surfaced to the model at the start of the run. */
  tools: ToolSchema[];
  /**
   * The run's model, limits, thinking and cancellation signal, plus the native
   * loop's policy. A runtime without {@link RuntimeCapabilities.loopPolicy}
   * reads `model`, `maxIterations`, `maxOutputTokens`, `thinking` and `signal`
   * and nothing else.
   */
  config: EngineConfig;
}

/** How a runtime reaches the platform for the length of one run. */
export interface RunIO {
  /**
   * The run's walled, bounded router: every tool call goes through it, so the
   * workspace wall, `allowedTools`, the unattended policy and connector
   * permissions apply whichever runtime made the call.
   */
  tools: ToolRouter;
  /**
   * The run's sinks: the conversation log, the browser stream, telemetry. A
   * runtime emits the engine's event vocabulary here (`EngineEventPayloads`),
   * stamped with {@link ResolvedRun.runId}.
   */
  events: EventSink;
}

export interface AgentRuntime {
  /** The name `execution.runtimes` gives it. */
  readonly id: string;
  readonly capabilities: RuntimeCapabilities;
  /**
   * Execute one run to its end. Resolves with the run's outcome; rejects on a
   * failure, after emitting `run.error`, and on cancellation after emitting
   * `run.done` with stopReason `cancelled`, as the engine does.
   */
  execute(run: ResolvedRun, io: RunIO): Promise<EngineResult>;
}
