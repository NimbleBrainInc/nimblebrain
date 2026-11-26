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
  /**
   * Who counts the runtime's model calls. `measured`: NimbleBrain, from the
   * calls it makes itself. `reported`: the agent, whose count the door
   * records as its own, naming the runtime on each usage ledger line
   * (ADR-0056).
   */
  usage: "measured" | "reported";
  /**
   * The runtime starts a run with the door's surfaced tools (`ResolvedRun.tools`)
   * and lets the model add a proxied one with `nb__manage_tools`. Without it,
   * the run is offered every tool it may call from the start (the tool
   * projection), so the door composes no guidance about promoting one.
   */
  promotesTools: boolean;
  /**
   * The model id the runtime's runs are recorded under, for an agent that
   * brings its own model and its own access to it (a vendor's CLI signed in to
   * a person's subscription), so the run's model names nothing it calls.
   * Such a runtime also executes the door's own model work (a title, a
   * history fold's summary) as runs, because nothing else can spend that
   * access (`Runtime.completeOnRuntime`). Absent: the runtime calls the run's
   * model, and the door calls it too.
   */
  ownModel?: string;
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
  /**
   * The door's own model work (a title, a history summary), not a turn: no
   * tools, one iteration, no conversation (`src/runtime/aux-run.ts`). A
   * runtime may run it on a cheaper path (a faster model, no tool connection).
   */
  internal?: boolean;
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

/** What a runtime's agent says about itself when asked, for a person to read. */
export interface RuntimeDescription {
  /** The plan its model calls are billed to (`Claude Max`), when it bills one. */
  plan?: string;
  /** The model its turns run on, as a person names it (`Sonnet`), when it chooses its own. */
  model?: string;
}

export interface AgentRuntime {
  /** The name `execution.runtimes` gives it. */
  readonly id: string;
  /** The name a person knows it by (`Claude Code`); absent, its id. */
  readonly title?: string;
  readonly capabilities: RuntimeCapabilities;
  /**
   * Ask the runtime's agent to describe itself, for a runtime whose agent runs
   * elsewhere. Rejects when the agent does not answer, so the caller can say
   * so before a run fails on it.
   */
  probe?(): Promise<RuntimeDescription>;
  /**
   * Execute one run to its end. Resolves with the run's outcome; rejects on a
   * failure, after emitting `run.error`, and on cancellation after emitting
   * `run.done` with stopReason `cancelled`, as the engine does.
   */
  execute(run: ResolvedRun, io: RunIO): Promise<EngineResult>;
}
