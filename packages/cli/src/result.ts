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
    "This folder holds files the CLI did not write. Remove them yourself, or choose another --home.",
  INSTALL_INCOMPLETE:
    "Run `npx nimblebrain` to finish installing it, or `npx nimblebrain uninstall` to remove it.",
  NETWORK: "Check the network connection, then run the same command again.",
  HEALTH_TIMEOUT:
    "Run `npx nimblebrain logs` and look at the last error line, then run the command again; `npx nimblebrain` finishes an install whose first start did not.",
  AGENT_UNSUPPORTED: "Pass --agent claude-code, cursor, codex or none.",
  START_FAILED:
    "Run `npx nimblebrain logs` and look at the last error line, then run the command again; `npx nimblebrain` finishes an install whose first start did not.",
  HOME_NOT_SHARED:
    "Docker cannot read the install's folder. Share this folder with Docker, or move it into a folder Docker shares and pass that folder with --home, then run this again. To install somewhere else instead, run `npx nimblebrain uninstall` first; it deletes this install's data.",
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

/**
 * A code's fix on a machine the CLI recognized, where the one in `ERRORS` would
 * be too general. A closed set, so every fix a code can carry is listed here.
 */
export const FIX_VARIANTS = {
  DOCKER_MISSING: {
    mac_brew:
      "Install Docker Desktop with `brew install --cask docker`, open it once from Applications, then run this again.",
    mac: "Install Docker Desktop (https://docs.docker.com/desktop/setup/install/mac-install/), open it once, then run this again.",
  },
  DOCKER_NOT_RUNNING: {
    colima: "Start Colima with `colima start`, then run this again.",
  },
  COMPOSE_MISSING: {
    brew: "Install Compose with `brew install docker-compose`, then run this again.",
  },
  LOW_MEMORY: {
    colima:
      "Restart Colima with more memory: `colima stop && colima start --memory 4`, then run this again.",
    docker_desktop:
      "In Docker Desktop, open Settings > Resources, set Memory to at least 2 GB, apply, then run this again.",
  },
  LOCAL_MODEL_UNREACHABLE: {
    brew_install:
      "Install Ollama with `brew install ollama`, then run this again; it offers to start Ollama for you.",
    app: "Open the Ollama app, then run this again.",
    brew: "Run `brew services start ollama` (it then also starts at login), then run this again.",
    systemd: "Run `sudo systemctl start ollama`, then run this again.",
    serve: "Run `ollama serve` in another terminal, then run this again.",
  },
} as const;

type Variants = typeof FIX_VARIANTS;
export type FixVariant = { [C in keyof Variants]: keyof Variants[C] }[keyof Variants];

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly fix: string;
  /** Extra fields carried into the JSON, such as which check failed. */
  readonly detail: Record<string, unknown>;

  readonly variant: FixVariant | undefined;

  constructor(
    code: ErrorCode,
    message?: string,
    detail: Record<string, unknown> = {},
    variant?: FixVariant,
  ) {
    super(message ?? code);
    this.code = code;
    const variants = (FIX_VARIANTS as Partial<Record<ErrorCode, Record<string, string>>>)[code];
    this.fix = (variant && variants?.[variant]) || ERRORS[code];
    this.variant = variant;
    this.detail = detail;
  }

  /** The same error with more detail (and another message), keeping its code and fix. */
  with(detail: Record<string, unknown>, message = this.message): CliError {
    return new CliError(this.code, message, { ...this.detail, ...detail }, this.variant);
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
  return result.ok ? 0 : exitCodeOf(result.error);
}

/** The exit code a failure with this code ends with: 2 for a usage error, else 1. */
export function exitCodeOf(code: ErrorCode): 1 | 2 {
  return code === "USAGE" ? 2 : 1;
}
