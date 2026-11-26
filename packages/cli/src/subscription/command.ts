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
