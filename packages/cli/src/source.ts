import {
  AGENT_RUNTIME_ENV,
  agentRuntimeOf,
  preflight,
  replaceWorker,
  SUBSCRIPTION_RUNTIMES,
  startWorker,
  stopWorker,
  type WorkerState,
  workerPlan,
  writeAgentRuntime,
} from "./agent-worker.ts";
import { SOURCE_LIST, SOURCES, type Source } from "./args.ts";
import { hasKey, keyProvider, keyVars, paths, setEnvLines, takesAgentRuntime } from "./compose.ts";
import type { Deps } from "./deps.ts";
import { LOCAL_MODEL_VARS, localModelOf, ollamaVersion, takesLocalModel } from "./local-model.ts";
import { movedLine, movePort, type PortMove } from "./ports.ts";
import { CliError } from "./result.ts";
import type { Account } from "./subscription/backends/types.ts";
import {
  DEFAULT_TURN_MODELS,
  modelLabel,
  type SubscriptionRuntime,
  WORKER_PORTS,
} from "./subscription/command.ts";

/**
 * What runs NimbleBrain's agents: one question with four answers (`SOURCES`).
 * `init` asks it, `use` answers it afterwards, `status` says which is in use.
 *
 * The runtime reads the answer from `.env` alone: `NB_AGENT_RUNTIME` names a
 * subscription's worker, else `NB_LOCAL_MODEL` a local model, else a model
 * key is the hosted provider's. A subscription keeps a saved key or local
 * model: a run with a spend budget runs on NimbleBrain's own engine, on that.
 */

/** The subscription sources, by the runtime that serves each. */
export const SUBSCRIPTION_SOURCES = {
  claude: "claude-code",
  codex: "codex",
} as const satisfies Partial<Record<Source, SubscriptionRuntime>>;
export type SubscriptionSource = keyof typeof SUBSCRIPTION_SOURCES;

export const isSubscription = (s: Source): s is SubscriptionSource =>
  s === "claude" || s === "codex";

/** The question, as `init` and `use` ask it and `model_source.ask` hands it on. */
export const SOURCE_QUESTION = "How should NimbleBrain's agents run?";

/** One answer to the question, as this machine offers it. */
export interface SourceOption {
  source: Source;
  /** For a person: "Your Claude Max subscription, through Claude Code". */
  label: string;
  /** Whether it can be chosen here; a subscription needs macOS and a release that takes it. */
  available: boolean;
  /** Whether it is ready to use now: signed in, a key saved, Ollama answering. */
  detected: boolean;
  /** What was found, or why it is unavailable; null when there is nothing to say. */
  note: string | null;
}

/** The question for an agent to pass on, when no person answered it (`init` under --yes, --json or no terminal). */
export interface SourceAsk {
  ask: string;
  options: SourceOption[];
  default: Source;
  set: string;
}

/** Which source an install runs on, and how a person reads it. */
export interface ModelSource {
  source: Source | null;
  label: string | null;
  /**
   * The model a subscription's turns run on, as `--model` named it (`sonnet`,
   * a full id); null for the vendor CLI's own default, or another source.
   */
  model: string | null;
}

/**
 * The source `.env` names: a subscription's worker first, since the runtime
 * makes it the default for every turn, then a local model, then a key.
 */
export function sourceOf(envText: string, composeText: string): Source | null {
  const runtime = agentRuntimeOf(envText).name;
  if (runtime === "claude-code") return "claude";
  if (runtime === "codex") return "codex";
  if (localModelOf(envText)) return "local";
  return hasKey(envText, keyVars(composeText)) ? "api" : null;
}

/** The install's source, read from `.env` and the running worker's record; runs nothing. */
export async function currentSource(deps: Deps, home: string): Promise<ModelSource> {
  const p = paths(home);
  const envText = (await deps.readText(p.env)) ?? "";
  const composeText = (await deps.readText(p.compose)) ?? "";
  const source = sourceOf(envText, composeText);
  if (source === null) return { source, label: null, model: null };
  const detail =
    source === "api"
      ? keyProvider(envText, composeText)
      : source === "local"
        ? localModelOf(envText)
        : await workerPlan(deps, home);
  const model = isSubscription(source) ? (agentRuntimeOf(envText).model ?? null) : null;
  const label = sourceLabel(source, detail ?? undefined);
  return { source, label: model ? `${label} (${modelLabel(model)})` : label, model };
}

/** How a person reads a source in use: "your Claude Max subscription through Claude Code". */
export function sourceLabel(source: Source, detail?: string): string {
  switch (source) {
    case "claude":
      return `your ${detail ?? "Claude"} subscription through Claude Code`;
    case "codex":
      return `your ${detail === undefined || detail === "ChatGPT" ? "ChatGPT plan" : detail} through Codex`;
    case "api":
      return detail ? `an API key (${detail})` : "an API key";
    case "local":
      return detail ? `a local model (${detail}) through Ollama` : "a local model through Ollama";
  }
}

/**
 * Each source as this machine offers it, in `SOURCES` order. Runs the vendor
 * CLIs' own sign-in checks (the worker's parsers, `preflight`) on macOS only,
 * and asks Ollama on 127.0.0.1; nothing leaves the machine.
 */
export async function detectSources(
  deps: Deps,
  envText: string,
  composeText: string,
): Promise<SourceOption[]> {
  const [claude, codex] = await Promise.all([
    subscriptionOption(deps, "claude", composeText),
    subscriptionOption(deps, "codex", composeText),
  ]);
  const provider = keyProvider(envText, composeText);
  const running = takesLocalModel(composeText) && (await ollamaVersion(deps)) !== undefined;
  return [
    claude,
    codex,
    {
      source: "api",
      label: "An API key for a hosted model (Anthropic, OpenAI, Google, …)",
      available: true,
      detected: provider !== null,
      note: provider ? `your ${provider} key is saved` : null,
    },
    {
      source: "local",
      label: "A local model through Ollama",
      available: takesLocalModel(composeText),
      detected: running,
      note: !takesLocalModel(composeText)
        ? "this release takes no local model"
        : running
          ? "Ollama is running"
          : null,
    },
  ];
}

const SUBSCRIPTION_LABELS: Record<SubscriptionSource, (plan?: string) => string> = {
  claude: (plan) => `Your ${plan ?? "Claude"} subscription, through Claude Code`,
  codex: () => "Your ChatGPT plan, through Codex",
};

/** What each sign-in refusal means, as a picker's note. */
const REFUSAL_NOTES: Record<string, (label: string) => string> = {
  AGENT_CLI_MISSING: (label) => `${label} is not installed`,
  AGENT_NOT_SIGNED_IN: () => "not signed in",
  AGENT_BILLS_API_KEY: () => "signed in with an API key, not a subscription",
};

async function subscriptionOption(
  deps: Deps,
  source: SubscriptionSource,
  composeText: string,
): Promise<SourceOption> {
  const label = SUBSCRIPTION_LABELS[source];
  const unavailable = (note: string): SourceOption => ({
    source,
    label: label(),
    available: false,
    detected: false,
    note,
  });
  // The worker runs as a launchd login item, and only Docker Desktop
  // forwards host.docker.internal to this machine's 127.0.0.1.
  if (deps.platform !== "darwin") return unavailable("macOS only for now");
  if (!takesAgentRuntime(composeText)) return unavailable("needs a newer NimbleBrain release");
  const runtime = SUBSCRIPTION_SOURCES[source];
  try {
    const account = await preflight(deps, runtime);
    return {
      source,
      label: label(account.plan),
      available: true,
      detected: true,
      note: "signed in",
    };
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    const note = REFUSAL_NOTES[err.code]?.(SUBSCRIPTION_RUNTIMES[runtime].label) ?? null;
    return { source, label: label(), available: true, detected: false, note };
  }
}

/** The default answer: a signed-in Claude subscription, else a signed-in ChatGPT plan, else an API key. */
export function defaultSource(options: SourceOption[]): Source {
  const ready = (s: Source) => options.some((o) => o.source === s && o.available && o.detected);
  if (ready("claude")) return "claude";
  if (ready("codex")) return "codex";
  return "api";
}

/** The question for an agent to relay, and the command that answers it on this install. */
export function sourceAsk(options: SourceOption[], cli: string): SourceAsk {
  return {
    ask: SOURCE_QUESTION,
    options,
    default: defaultSource(options),
    set: `${cli} use ${SOURCES.join("|")}`,
  };
}

/** The numbered list a person chooses from: available sources first, each with what was found. */
export function pickerLines(options: SourceOption[]): string[] {
  const offered = options.filter((o) => o.available);
  const width = Math.max(...offered.map((o) => o.label.length)) + 3;
  const lines = [
    SOURCE_QUESTION,
    ...offered.map((o, i) => {
      const note = o.note ? `(${o.note})` : "";
      return `  ${i + 1}) ${note ? o.label.padEnd(width) : o.label}${note}`.trimEnd();
    }),
  ];
  const off = options.filter((o) => !o.available);
  for (const o of off) lines.push(`  Not here: ${lowerFirst(o.label)} (${o.note})`);
  return lines;
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * Asks a person which source to run on: the list, then a number or a name,
 * Enter taking the default. An answer that is neither is asked again, twice.
 */
export async function pickSource(deps: Deps, options: SourceOption[]): Promise<Source> {
  const offered = options.filter((o) => o.available);
  const fallback = defaultSource(options);
  const def = Math.max(1, offered.findIndex((o) => o.source === fallback) + 1);
  for (const line of pickerLines(options)) deps.say(line);
  const names = offered.map((o) => o.source).join(", ");
  for (let tries = 0; tries < 3; tries++) {
    const answer = (await deps.prompt(`Choose 1-${offered.length}, or ${names} [${def}]: `))
      .trim()
      .toLowerCase();
    if (answer === "") return offered[def - 1]?.source ?? fallback;
    const byNumber = offered[Number(answer) - 1];
    if (/^\d+$/.test(answer) && byNumber) return byNumber.source;
    const byName = offered.find((o) => o.source === answer);
    if (byName) return byName.source;
    deps.say(`"${answer}" is not one of them.`);
  }
  throw new CliError("USAGE", `Choose one of ${names}.`);
}

/** `use` with no source and no person to ask. */
/** `--model` is a subscription's: refused before anything changes when `source` is not one. */
export function refuseModelFor(model: string | undefined, source: Source | undefined): void {
  if (model === undefined || (source !== undefined && isSubscription(source))) return;
  throw new CliError(
    "USAGE",
    source === "local"
      ? "--model is for claude and codex; a local model is named after use local, or with --local-model."
      : `--model is for claude and codex${source ? `, not ${source}` : "; pass --use claude or --use codex with it"}.`,
  );
}

export function noSourceNamed(): CliError {
  return new CliError("USAGE", `use takes ${SOURCE_LIST}, or asks which at a terminal.`);
}

/**
 * Puts the install on a subscription: refuses where the worker cannot run,
 * checks the vendor CLI's sign-in, starts the worker, and points `.env` at it.
 * Its turns run on `model`, else the runtime's default (`DEFAULT_TURN_MODELS`:
 * Sonnet for Claude Code, Codex's own for Codex). A saved key or local model
 * stays, for the runs that need NimbleBrain's own engine. The caller
 * recreates the runtime's container.
 */
export async function startSubscription(
  deps: Deps,
  home: string,
  source: SubscriptionSource,
  port?: number,
  model?: string,
): Promise<{
  worker: WorkerState;
  account: Account;
  runtime: SubscriptionRuntime;
  moved?: PortMove;
}> {
  const runtime = SUBSCRIPTION_SOURCES[source];
  const label = SUBSCRIPTION_RUNTIMES[runtime].label;
  if (deps.platform === "linux") {
    throw new CliError(
      "HOST_LOOPBACK_UNREACHABLE",
      `On Linux, NimbleBrain's container cannot reach an agent worker on this machine's 127.0.0.1, so it cannot run on ${label} yet.`,
    );
  }
  if (deps.platform !== "darwin") {
    throw new CliError(
      "PLATFORM_UNSUPPORTED",
      `The agent worker runs on macOS only, so NimbleBrain cannot run on ${label} here yet.`,
    );
  }
  const composeText = (await deps.readText(paths(home).compose)) ?? "";
  if (!takesAgentRuntime(composeText)) {
    throw new CliError(
      "RUNTIME_UNSUPPORTED",
      "This release's runtime takes no agent runtime from .env; a newer release does.",
    );
  }
  const account = await preflight(deps, runtime);
  // This install's own worker is stopped and its port let go before the port is judged, so
  // its own port never reads as busy; a port still taken puts the old worker back.
  return replaceWorker(deps, home, async () => {
    // A port a person named is kept, busy or not (`startWorker` refuses a busy one); a busy default moves.
    const moved =
      port === undefined ? await movePort(deps, home, WORKER_PORTS[runtime], "worker") : undefined;
    if (moved) deps.say(movedLine(deps, moved, "the agent worker"));
    const at = port ?? moved?.to ?? WORKER_PORTS[runtime];
    const turnModel = model ?? DEFAULT_TURN_MODELS[runtime];
    const worker = await startWorker(deps, home, runtime, at, account.plan, turnModel);
    await writeAgentRuntime(deps, home, runtime, at, turnModel);
    return { worker, account, runtime, moved };
  });
}

/**
 * Takes the install off a subscription: stops the worker and empties the
 * agent runtime from `.env`, and the local model too when `dropLocal` (an API
 * key's source). The caller recreates the runtime's container.
 */
export async function leaveSubscription(deps: Deps, home: string, dropLocal: boolean) {
  await stopWorker(deps, home);
  const p = paths(home);
  const cleared: Record<string, string> = {
    [AGENT_RUNTIME_ENV.runtime]: "",
    [AGENT_RUNTIME_ENV.url]: "",
    [AGENT_RUNTIME_ENV.model]: "",
  };
  if (dropLocal) for (const v of LOCAL_MODEL_VARS) cleared[v] = "";
  await deps.writeText(p.env, setEnvLines((await deps.readText(p.env)) ?? "", cleared), 0o600);
}
