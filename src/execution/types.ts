/**
 * The agent runtime seam.
 *
 * `Runtime.startRun` decides a run: the workspace, the membership gate, the
 * composed prompt, the walled tool router, the history, the model and the
 * limits. An {@link AgentRuntime} executes what the door decided and reports
 * back through the same event sink every runtime writes to. It may narrow what
 * the run allows and never widens it, so the door stays the only place a run's
 * reach is decided (ADR-0021, ADR-0056).
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
import type { TokenUsage } from "../usage/types.ts";

/**
 * What a runtime does on its own, so the door can refuse a run it cannot hold
 * to its limits instead of running it on weaker terms.
 */
export interface RuntimeCapabilities {
  /**
   * The runtime checks every model call against the run's spend accounts
   * (`EngineConfig.spend`) and its run-wide input cap
   * (`EngineConfig.maxRunInputTokens`) before it is sent. A run that names
   * accounts or sets the cap is refused by a runtime without it.
   */
  spendGate: boolean;
  /**
   * Which model credential the runtime's agent takes (ADR-0057). `session`:
   * the door mints the turn's credential as the run starts
   * (`ResolvedRun.modelCredential`). `process`: the agent's worker was started
   * with a pool credential, so nothing is minted per turn. Absent, the
   * runtime takes none.
   */
  modelCredential?: "session" | "process";
}

/**
 * One run, as the door resolved it. Every field is NimbleBrain's own type;
 * a runtime that speaks a protocol translates at its own edge.
 */
export interface ResolvedRun {
  /** The door's run id. Every runtime stamps it on every event it emits. */
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
   * loop's policy (`hooks`, `toolPromotion`, the supervisor, bound skills). A
   * runtime that runs its own loop reads `model`, `maxIterations`,
   * `maxInputTokens`, `maxOutputTokens`, `thinking` and `signal`; of the
   * policy, only what applies at the tool boundary reaches it
   * (`src/execution/tool-projection.ts`).
   */
  config: EngineConfig;
  /**
   * Whether the run may fold its own history mid-turn, and with which model.
   * Absent, it may not: the door allows a fold only where there is a
   * conversation to bill the summary to and compaction is on.
   */
  compaction?: { model: string };
  /**
   * The turn's model credential, minted by the door when the run starts, for
   * a runtime that takes one per session (`RuntimeCapabilities.modelCredential`).
   * Held in memory only. Absent for any other runtime and where there is no
   * run key.
   */
  modelCredential?: string;
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
  /**
   * Bill a summary the runtime wrote to fold its history mid-turn, as the door
   * bills its own folds: to the conversation and the usage ledger.
   */
  billSummary(model: string, usage: TokenUsage, llmMs: number): void;
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
