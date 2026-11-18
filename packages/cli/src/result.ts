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
  RUNTIME_UNSUPPORTED:
    "Pass a newer runtime with --runtime, or leave it out to install the newest release.",
  NOT_RUNNING: "Run `npx nimblebrain up`, then run this again.",
  TELEMETRY_LOCKED:
    "Nothing to change: DO_NOT_TRACK or the install's configuration decides telemetry here.",
  LOCAL_MODEL_UNREACHABLE:
    "Install Ollama (https://ollama.com/download) and start it, then run this again.",
  LOCAL_MODEL_MISSING:
    "Download the model with `ollama pull <model>`, or check that Ollama has disk space, then run this again.",
  LOCAL_MODEL_NO_TOOLS:
    "Choose a model with tool calling, such as gemma4:e4b; https://docs.nimblebrain.ai/config/local-models/ lists the ones run with NimbleBrain.",
  LOCAL_CONTEXT_SMALL:
    "Run `npx nimblebrain local-model` to prepare the model again with a 32k context window.",
  INTERRUPTED:
    "Run `npx nimblebrain status` to see what is in place, then run the same command again.",
  UPDATE_REQUIRED:
    "Run `npx nimblebrain update`; this install's NimbleBrain cannot reach servers on this machine yet.",
  WORKSPACE_NOT_FOUND:
    "Run `npx nimblebrain status` for the workspace ids, then pass one with --workspace.",
  SERVER_NOT_FOUND: "Run `npx nimblebrain mcp list` for the server names in this workspace.",
  DIRECT_URL_NOT_ALLOWED:
    "Adding a server by URL needs a local install made by `npx nimblebrain`; run `npx nimblebrain update`, or add the server to the instance's connector catalog.",
  URL_NOT_LOOPBACK:
    "Run the server on this machine and pass its localhost, 127.0.0.1 or [::1] URL, such as http://127.0.0.1:8000/mcp.",
  URL_INVALID: "Pass the server's full MCP URL, such as http://127.0.0.1:8000/mcp.",
  INVALID_SERVER_NAME: "Pass another name with --name: lowercase letters, digits and hyphens.",
  NAME_TAKEN:
    "Pass another name with --name, or remove the existing one with `npx nimblebrain mcp remove <serverName>`.",
  NAME_IS_CATALOG_ENTRY: "Pass another name with --name; this one belongs to a catalog connector.",
  REQUEST_FAILED:
    "Run `npx nimblebrain logs` and look at the last error line, then run this again.",
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
