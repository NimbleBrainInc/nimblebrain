import type { McpSubcommand } from "./args.ts";
import type { describe } from "./help.ts";
import type {
  down,
  init,
  key,
  localModel,
  logs,
  telemetry,
  uninstall,
  up,
  update,
} from "./lifecycle.ts";
import type { DoctorAnswer } from "./main.ts";
import type { McpAnswers } from "./mcp.ts";
import type { open } from "./open.ts";
import type { status } from "./status.ts";

/**
 * What each command's `{ok: true}` answer carries, field by field, as
 * `help --json` publishes it. The fields are checked against the code that
 * builds each answer (`AnswerFieldsMatch`, below): a field a command answers
 * that is not described here, or one described here that no command answers,
 * fails the type-check. A field present only sometimes says when.
 */

/** The fields of every answer that carries an install's state (`status`, `init`, `up`, `update`). */
const STATE = {
  version: "The NimbleBrain runtime release installed, without the leading v",
  phase:
    "starting until the install's first start answers health, else ready; npx nimblebrain finishes a starting install, and only down, logs, uninstall, status and doctor act on one",
  cli_version: "This CLI's version; it moves independently of the runtime",
  health: "ok when NimbleBrain answers, else down",
  url: "Where the web UI and API answer, on 127.0.0.1",
  workspaces: "Each workspace as {id, name, mcp}, mcp being its MCP URL; empty while down",
  agent:
    "{connected, skill}: the coding agent init connected (or null), and the nimblebrain skill's name when that agent has it (else null)",
  model_key: "set or missing: whether the install's .env holds a model key (never the key)",
  host_loopback:
    "Whether this release can reach a server on this machine; mcp add needs it, update brings it",
  local_model: "The Ollama model NimbleBrain's agents run on, or null for a hosted model key",
  telemetry:
    "{state, locked?, ask?, set?}: on, off or undecided; locked says why no one can change it here; ask and set, only while undecided, are the question to pass to the person and the command that answers it",
  updates:
    "{cli?, runtime?}, each {current, latest}: what the last cached lookup found; absent when nothing is known or the check is off",
} as const;

const OLLAMA_STARTED = "The command that started Ollama, when this run started it";

export const ANSWER_FIELDS = {
  init: {
    ...STATE,
    already: "true when an install was already here; it was reported, not changed",
    manual: "The settings to add to the coding agent by hand, when connecting it failed",
    opened: "Whether the browser opened, when init tried (a new install, a person at a terminal)",
    ollama_started: OLLAMA_STARTED,
  },
  doctor: {
    checks: "Each check run, in order, as {check, ok, detail}",
    arch: "The CPU architecture Docker reports",
    ollama_started: `${OLLAMA_STARTED}; on a local model only`,
  },
  status: STATE,
  open: {
    url: "The web UI's URL, to open by hand when opened is false",
    opened: "Whether a browser was started",
  },
  key: {
    provider: "The provider the key was entered for",
    model_key: "set",
  },
  "local-model": {
    local_model: "The model NimbleBrain's agents now run on (nimblebrain-<model>)",
    ollama_started: OLLAMA_STARTED,
  },
  telemetry: { telemetry: STATE.telemetry },
  up: { ...STATE, ollama_started: OLLAMA_STARTED },
  down: { health: "down" },
  logs: { lines: "The runtime's last log lines, up to 100" },
  update: {
    ...STATE,
    already: "true when the install was already on that release",
    from: "The release moved from, as vX.Y.Z, when it moved",
    skill_update:
      "What happened to the connected agent's nimblebrain skill: updated, unchanged, not_installed or failed; absent with no agent",
  },
  uninstall: { removed: "true" },
  "mcp add": {
    serverName: "The name the server was added under",
    url: "The URL as given",
    dialed: "Where NimbleBrain, inside Docker, connects to it",
    placements: "Where the server's UI appears, from its Server Card",
    wsId: "The workspace it was added to",
    warning: "Why the server is not connected yet (it was added anyway), when it is not",
    notice: "Anything else NimbleBrain says about the server, when it says something",
  },
  "mcp list": {
    wsId: "The workspace listed",
    servers:
      "Each server as {serverName, displayName?, url?, state?, status?, statusReason?, toolCount?}",
  },
  "mcp remove": {
    serverName: "The server removed",
    wsId: "The workspace it was removed from",
  },
  help: {
    cli_version: "This CLI's version",
    commands: "Each command as {name, args, description, answer}",
    flags: "Each flag as {name, short?, takes, description, commands?}",
    errors: "Each error code as {code, fix, exit}",
  },
} as const satisfies Record<AnswerName, Record<string, string>>;

/** Each command as a person types it, `mcp` by subcommand, and `help`. */
export type AnswerName = Exclude<keyof Builders, "mcp"> | `mcp ${McpSubcommand}` | "help";

/** The function that builds each command's answer; `doctor`'s and `status`'s are wrapped by `main`. */
interface Builders {
  init: typeof init;
  doctor: () => Promise<DoctorAnswer>;
  status: typeof status;
  open: typeof open;
  key: typeof key;
  "local-model": typeof localModel;
  telemetry: typeof telemetry;
  up: typeof up;
  down: typeof down;
  logs: typeof logs;
  update: typeof update;
  uninstall: typeof uninstall;
  mcp: never;
}

type AnswerOf<N extends AnswerName> = N extends `mcp ${infer S extends McpSubcommand}`
  ? McpAnswers[S]
  : N extends "help"
    ? ReturnType<typeof describe>
    : N extends keyof Builders
      ? Awaited<ReturnType<Builders[N]>>
      : never;

/** Every key of every member of a union, where `keyof` gives only the shared ones. */
type KeysOf<T> = T extends unknown ? keyof T : never;

/** `main` adds `updates` to an answer that carries an install's state (`isStatusShaped`). */
type WithUpdates<T> = T extends {
  version: string;
  health: unknown;
  url: unknown;
  workspaces: unknown;
}
  ? "updates"
  : never;

type Answered<N extends AnswerName> = Exclude<KeysOf<AnswerOf<N>>, "ok"> | WithUpdates<AnswerOf<N>>;

type Mismatch = {
  [N in AnswerName]: {
    undescribed: Exclude<Answered<N>, keyof (typeof ANSWER_FIELDS)[N]>;
    unanswered: Exclude<keyof (typeof ANSWER_FIELDS)[N], Answered<N>>;
  };
};

type Exact<T extends { [N in AnswerName]: { undescribed: never; unanswered: never } }> = T;

/**
 * Fails the type-check when a command answers a field `ANSWER_FIELDS` does not
 * describe (`undescribed`), or `ANSWER_FIELDS` describes one it never answers
 * (`unanswered`); the error names the command and the field. A builder typed
 * as the loose `Ok` answers every string key, so it fails too: each keeps the
 * type its fields give it.
 */
export type AnswerFieldsMatch = Exact<Mismatch>;
