/**
 * How the agent worker is started and what it offers, kept apart from the
 * worker itself so a command can name it without loading the worker's code.
 */

/** The hidden argument that runs the worker instead of a command (`bin.ts`). */
export const WORKER_COMMAND = "__agent-worker";

/** The runtimes a worker serves, by the driver name the runtime knows them by. */
export type SubscriptionRuntime = "claude-code" | "codex";

/** Each runtime's worker port when `--port` names none. */
export const WORKER_PORTS: Record<SubscriptionRuntime, number> = {
  "claude-code": 27290,
  codex: 27291,
};

/** What the vendor CLI may call during a turn, for a person. */
export const TOOL_SURFACE: Record<SubscriptionRuntime, string> = {
  "claude-code": "only your NimbleBrain workspace's tools",
  codex: "your NimbleBrain workspace's tools, plus Codex's read-only shell (it has no off switch)",
};

/**
 * The model each runtime's turns run on when `use` names none: Claude Code on
 * Sonnet, which answers a chat turn faster than Opus, so chat feels quick;
 * `--model opus` trades that for depth. Codex on its own default (none
 * passed), since the models it offers change with the person's plan.
 */
export const DEFAULT_TURN_MODELS: Record<SubscriptionRuntime, string | undefined> = {
  "claude-code": "sonnet",
  codex: undefined,
};

/** Claude Code's aliases, by the name a person reads. */
const MODEL_NAMES: Record<string, string> = { sonnet: "Sonnet", opus: "Opus", haiku: "Haiku" };

/** A model as a person reads it: `sonnet` is "Sonnet"; a full id is itself. */
export function modelLabel(model: string): string {
  return MODEL_NAMES[model] ?? model;
}

/**
 * What a model id may be, as `--model` takes it: an alias or a full id, such
 * as `opus` or `claude-sonnet-4-5[1m]`. It is passed to the vendor CLI as its
 * own argument, never through a shell.
 */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*(\[[A-Za-z0-9]+\])?$/;
