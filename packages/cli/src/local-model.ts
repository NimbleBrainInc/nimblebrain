import type { Deps } from "./deps.ts";
import { CliError, type FixVariant } from "./result.ts";

/**
 * A local model through Ollama, instead of a hosted key.
 *
 * The runtime reads the model from the install's `.env` (`NB_LOCAL_MODEL_URL`,
 * `NB_LOCAL_MODEL`, `NB_LOCAL_MODEL_CONTEXT`), which a release's Compose file
 * passes through. Setting one up is all HTTP against Ollama's own API, so the
 * CLI never runs the `ollama` binary (a down Ollama is started the way it was
 * installed, `ensureOllama`): check it answers, pull the model if it is
 * missing, refuse one without tool calling, and create a copy of it with a
 * fixed context window, because Ollama otherwise picks one from GPU memory (4k
 * on smaller machines) and silently cuts a longer prompt.
 */

/** Ollama as this machine reaches it. */
export const OLLAMA_URL = "http://127.0.0.1:11434";
/** Ollama as the runtime's container reaches it. */
export const OLLAMA_FROM_CONTAINER = "http://host.docker.internal:11434/v1";
/** The smallest model tested end to end on NimbleBrain's tasks (docs: Local Models). */
export const DEFAULT_LOCAL_MODEL = "gemma4:e4b";
/** The context window the CLI fixes on the model it creates, in tokens. */
export const LOCAL_CONTEXT = 32_768;

const PULL_TIMEOUT_MS = 60 * 60 * 1000;
/** How long a started Ollama may take to answer. */
const OLLAMA_START_TIMEOUT_MS = 30_000;
const CREATE_TIMEOUT_MS = 2 * 60 * 1000;

/** The `.env` names the runtime reads a local model from. */
export const LOCAL_MODEL_VARS = ["NB_LOCAL_MODEL_URL", "NB_LOCAL_MODEL", "NB_LOCAL_MODEL_CONTEXT"];

/** Whether a release's Compose file passes a local model through to the runtime. */
export function takesLocalModel(composeText: string): boolean {
  return composeText.includes("NB_LOCAL_MODEL_URL");
}

/** The name of the copy the CLI creates: `gemma4:e4b` becomes `nimblebrain-gemma4-e4b`. */
export function nimblebrainModelName(model: string): string {
  return `nimblebrain-${model.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
}

/** The local model an install's `.env` names, or undefined. Reads names and that one value only. */
export function localModelOf(envText: string): string | undefined {
  const line = envText.split("\n").find((l) => l.startsWith("NB_LOCAL_MODEL="));
  const value = line?.slice("NB_LOCAL_MODEL=".length).trim();
  return value ? value : undefined;
}

interface ShowAnswer {
  capabilities?: string[];
  parameters?: string;
}

async function show(deps: Deps, model: string): Promise<ShowAnswer | undefined> {
  const res = await deps.postJson(`${OLLAMA_URL}/api/show`, { model });
  return res?.status === 200 ? (res.body as ShowAnswer) : undefined;
}

/** The `num_ctx` a model was created with, from `/api/show`'s parameters text. */
export function numCtxOf(parameters: string | undefined): number | undefined {
  const match = parameters?.match(/^num_ctx\s+(\d+)/m);
  return match ? Number(match[1]) : undefined;
}

/** Ollama's version when it answers on this machine, else undefined. */
export async function ollamaVersion(deps: Deps): Promise<string | undefined> {
  const res = await deps.getJson(`${OLLAMA_URL}/api/version`);
  const version = (res?.body as { version?: unknown } | undefined)?.version;
  return res?.status === 200 && typeof version === "string" ? version : undefined;
}

/**
 * How this machine's Ollama was installed, as far as the CLI can tell without
 * running it, and so how to start it: the macOS app, a Homebrew formula
 * (whose service also starts it at login), the Linux install script's systemd
 * unit, or a bare `ollama` binary, which the CLI never starts: a process it
 * spawned would end with the session and at the next reboot.
 */
export interface OllamaInstall {
  kind: "app" | "brew" | "systemd" | "binary" | "none";
  /** The command that starts it, when the CLI may run it. */
  start?: string[];
  /** The fix when it stays down. */
  fix?: FixVariant;
}

const SYSTEMD_UNITS = [
  "/etc/systemd/system/ollama.service",
  "/usr/lib/systemd/system/ollama.service",
];

export async function findOllama(deps: Deps): Promise<OllamaInstall> {
  const apps = ["/Applications", `${deps.home}/Applications`].map(
    (dir) => `${dir}/Ollama.app/Contents/Info.plist`,
  );
  if (deps.platform === "darwin" && (await anyFile(deps, apps)))
    return { kind: "app", start: ["open", "-g", "-a", "Ollama"], fix: "app" };
  if (deps.platform === "linux" && (await anyFile(deps, SYSTEMD_UNITS)))
    return {
      kind: "systemd",
      start: ["systemctl", "start", "--no-ask-password", "ollama"],
      fix: "systemd",
    };
  const brew = await deps.exec("brew", ["list", "--versions", "ollama"]);
  if (brew.code === 0 && brew.stdout.trim())
    return { kind: "brew", start: ["brew", "services", "start", "ollama"], fix: "brew" };
  if (await deps.which("ollama")) return { kind: "binary", fix: "serve" };
  return { kind: "none", fix: brew.missing ? undefined : "brew_install" };
}

async function anyFile(deps: Deps, files: string[]): Promise<boolean> {
  for (const file of files) if ((await deps.readText(file)) !== undefined) return true;
  return false;
}

/**
 * Ollama's version once it answers. When it does not and the person installed
 * it in a way the CLI recognizes, `confirm` decides whether to start it with
 * that install's own command; the CLI then waits for it to answer. It never
 * installs Ollama: a missing one is `LOCAL_MODEL_UNREACHABLE` naming the step.
 * `started` is the command the CLI ran, for the caller's answer.
 */
export async function ensureOllama(
  deps: Deps,
  confirm: (command: string) => Promise<boolean>,
): Promise<{ version: string; started?: string }> {
  const running = await ollamaVersion(deps);
  if (running) return { version: running };

  const install = await findOllama(deps);
  const down = (message: string, extra: Record<string, unknown> = {}) =>
    new CliError(
      "LOCAL_MODEL_UNREACHABLE",
      message,
      { check: "ollama", ollama: install.kind, ...extra },
      install.fix,
    );
  if (!install.start) {
    throw down(
      install.kind === "none"
        ? `Ollama does not answer at ${OLLAMA_URL}, and it does not look installed.`
        : `Ollama does not answer at ${OLLAMA_URL}.`,
    );
  }
  const command = install.start.join(" ");
  if (!(await confirm(command))) {
    throw down(`Ollama is installed but not running at ${OLLAMA_URL}; it was not started.`);
  }
  deps.say(`Starting Ollama: ${command}`);
  const [cmd = "", ...args] = install.start;
  const res = await deps.exec(cmd, args, { timeoutMs: 60_000 });
  if (res.code !== 0 || res.missing) {
    const why = res.stderr.trim().split("\n")[0];
    throw down(`\`${command}\` did not start Ollama${why ? `: ${why}` : "."}`);
  }
  for (let waited = 0; waited < OLLAMA_START_TIMEOUT_MS; waited += 1_000) {
    await deps.sleep(1_000);
    const version = await ollamaVersion(deps);
    if (version) {
      deps.say(`Ollama ${version} is running.`);
      if (deps.platform === "linux")
        deps.say(
          "On Linux, NimbleBrain's container reaches Ollama only when it listens beyond 127.0.0.1 (OLLAMA_HOST=0.0.0.0).",
        );
      return { version, started: command };
    }
  }
  throw down(
    `Ollama was started with \`${command}\` but did not answer at ${OLLAMA_URL} within 30 seconds.`,
    { ollama_started: command },
  );
}

/** What the caller decides for the person: whether to start Ollama, and to download a missing model. */
export interface LocalAsks {
  start: (command: string) => Promise<boolean>;
  pull: (model: string) => Promise<boolean>;
}

/**
 * Prepares `model` on this machine's Ollama, starting Ollama first when it is
 * installed but down (`ensureOllama`), and returns the `.env` lines that point
 * the runtime at it, with the command that started Ollama, if any. A failure
 * after a start still says what was started.
 */
export async function setupLocalModel(
  deps: Deps,
  model: string,
  asks: LocalAsks,
): Promise<{ values: Record<string, string>; started?: string }> {
  const { started } = await ensureOllama(deps, asks.start);
  try {
    return { values: await prepareModel(deps, model, asks.pull), started };
  } catch (err) {
    if (err instanceof CliError && started) throw err.with({ ollama_started: started });
    throw err;
  }
}

async function prepareModel(
  deps: Deps,
  model: string,
  pull: (model: string) => Promise<boolean>,
): Promise<Record<string, string>> {
  let found = await show(deps, model);
  if (!found) {
    if (!(await pull(model))) {
      throw new CliError("LOCAL_MODEL_MISSING", `Ollama has no model "${model}".`, {
        check: "model",
      });
    }
    deps.say(`Downloading ${model} with Ollama. A model is several GB; this can take a while.`);
    const pulled = await deps.postJson(
      `${OLLAMA_URL}/api/pull`,
      { model, stream: false },
      PULL_TIMEOUT_MS,
    );
    found = pulled?.status === 200 ? await show(deps, model) : undefined;
    if (!found) {
      throw new CliError("LOCAL_MODEL_MISSING", `Ollama could not download "${model}".`, {
        check: "model",
      });
    }
  }
  if (!found.capabilities?.includes("tools")) {
    throw new CliError(
      "LOCAL_MODEL_NO_TOOLS",
      `${model} does not support tool calling, which NimbleBrain's agents need.`,
      { check: "tools" },
    );
  }

  const name = nimblebrainModelName(model);
  const created = await deps.postJson(
    `${OLLAMA_URL}/api/create`,
    { model: name, from: model, parameters: { num_ctx: LOCAL_CONTEXT }, stream: false },
    CREATE_TIMEOUT_MS,
  );
  if (created?.status !== 200) {
    throw new CliError("LOCAL_MODEL_MISSING", `Ollama could not prepare ${name} from ${model}.`, {
      check: "model",
    });
  }
  return {
    NB_LOCAL_MODEL_URL: OLLAMA_FROM_CONTAINER,
    NB_LOCAL_MODEL: name,
    NB_LOCAL_MODEL_CONTEXT: String(LOCAL_CONTEXT),
  };
}

export interface LocalCheck {
  check: string;
  ok: boolean;
  detail: string;
}

/**
 * What `doctor` adds for an install on a local model: Ollama answers, has the
 * model, the model calls tools, and its window is the one the runtime budgets
 * against. Stops at the first failure and throws its code with the checks so
 * far. `start` decides whether a down Ollama is started (`ensureOllama`).
 */
export async function checkLocalModel(
  deps: Deps,
  model: string,
  start: (command: string) => Promise<boolean>,
): Promise<{ checks: LocalCheck[]; started?: string }> {
  const checks: LocalCheck[] = [];
  const { version, started } = await ensureOllama(deps, start).catch((err: unknown) => {
    if (!(err instanceof CliError)) throw err;
    checks.push({ check: "ollama", ok: false, detail: err.message });
    throw err.with({ check: "ollama", checks });
  });
  checks.push({
    check: "ollama",
    ok: true,
    detail: started ? `${version} (started: ${started})` : version,
  });

  const found = await show(deps, model);
  const fail = (
    check: string,
    code: "LOCAL_MODEL_MISSING" | "LOCAL_MODEL_NO_TOOLS" | "LOCAL_CONTEXT_SMALL",
    detail: string,
  ): never => {
    checks.push({ check, ok: false, detail });
    throw new CliError(code, detail, { check, checks, ollama_started: started });
  };
  if (!found) fail("model", "LOCAL_MODEL_MISSING", `Ollama has no model "${model}".`);
  checks.push({ check: "model", ok: true, detail: model });
  if (!found?.capabilities?.includes("tools"))
    fail("tools", "LOCAL_MODEL_NO_TOOLS", `${model} does not support tool calling.`);
  checks.push({ check: "tools", ok: true, detail: "tool calling" });
  const ctx = numCtxOf(found?.parameters);
  if (ctx === undefined || ctx < LOCAL_CONTEXT)
    fail(
      "context",
      "LOCAL_CONTEXT_SMALL",
      `${model} has a context window of ${ctx ?? "Ollama's default"}, below ${LOCAL_CONTEXT}.`,
    );
  checks.push({ check: "context", ok: true, detail: `${ctx} tokens` });
  return { checks, started };
}
