/**
 * What every command answers, and the one place an error's code and fix live.
 *
 * A command returns `{ ok: true, ...fields }` or throws a `CliError`. `main`
 * turns either into one JSON object (with `--json`) or a few lines of text, and
 * into the exit code: 0 when ok, 1 when not, 2 for a usage error. An agent
 * branches on `error`, never on the wording, so a code is stable once
 * published and its `fix` is the sentence an agent repeats to a person.
 */

export const ERRORS = {
  USAGE: "Run `npx nimblebrain --help` for the commands and flags.",
  DOCKER_MISSING:
    "Install Docker Desktop or Docker Engine (https://docs.docker.com/get-docker/), then run this again.",
  DOCKER_NOT_RUNNING: "Start Docker Desktop (or the Docker service), then run this again.",
  DOCKER_PERMISSION:
    "Let this user use Docker (https://docs.docker.com/engine/install/linux-postinstall/), sign in again, then run this again.",
  COMPOSE_MISSING:
    "Install Docker Compose v2 (https://docs.docker.com/compose/install/) or update Docker Desktop, then run this again.",
  ARCH_UNSUPPORTED: "NimbleBrain publishes no image for this CPU architecture.",
  LOW_MEMORY: "Give Docker at least 2 GB of memory in its settings, then run this again.",
  PORT_IN_USE: "Stop whatever holds the port, or pass --port with a free one.",
  NOT_INSTALLED: "Run `npx nimblebrain` to install it.",
  NOT_OURS:
    "Another install holds this name or its data. Remove it yourself, or choose another --home.",
  NETWORK: "Check the network connection, then run the same command again.",
  MODEL_KEY_MISSING: "Run `npx nimblebrain key` in your own terminal to enter a model key.",
  HEALTH_TIMEOUT: "Run `npx nimblebrain logs` and look at the last error line.",
  AGENT_UNSUPPORTED: "Pass --agent claude-code, cursor, codex or none.",
  START_FAILED: "Run `npx nimblebrain logs` and look at the last error line, then run this again.",
  NEEDS_TERMINAL:
    "A person runs this in their own terminal; it asks for input no agent should give.",
  CANCELLED: "Nothing was changed. Run the command again to go ahead.",
  NOT_RUNNING: "Run `npx nimblebrain up`, then run this again.",
  TELEMETRY_LOCKED:
    "Nothing to change: DO_NOT_TRACK or the install's configuration decides telemetry here.",
  INTERRUPTED:
    "Run `npx nimblebrain status` to see what is in place, then run the same command again.",
} as const;

export type ErrorCode = keyof typeof ERRORS;

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly fix: string;
  /** Extra fields carried into the JSON, such as which check failed. */
  readonly detail: Record<string, unknown>;

  constructor(code: ErrorCode, message?: string, detail: Record<string, unknown> = {}) {
    super(message ?? code);
    this.code = code;
    this.fix = ERRORS[code];
    this.detail = detail;
  }
}

export type Ok = { ok: true } & Record<string, unknown>;

export interface Failure {
  ok: false;
  error: ErrorCode;
  message: string;
  fix: string;
  [field: string]: unknown;
}

export function failure(err: CliError): Failure {
  // Detail first: a failure that carries a status must not let its `ok: true` win.
  return { ...err.detail, ok: false, error: err.code, message: err.message, fix: err.fix };
}

export function exitCodeFor(result: Ok | Failure): number {
  if (result.ok) return 0;
  return result.error === "USAGE" ? 2 : 1;
}
