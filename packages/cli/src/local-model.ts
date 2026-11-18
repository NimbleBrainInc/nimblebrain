import type { Deps } from "./deps.ts";
import { CliError } from "./result.ts";

/**
 * A local model through Ollama, instead of a hosted key.
 *
 * The runtime reads the model from the install's `.env` (`NB_LOCAL_MODEL_URL`,
 * `NB_LOCAL_MODEL`, `NB_LOCAL_MODEL_CONTEXT`), which a release's Compose file
 * passes through. Setting one up is all HTTP against Ollama's own API, so the
 * CLI needs no `ollama` binary: check it answers, pull the model if it is
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
const CREATE_TIMEOUT_MS = 2 * 60 * 1000;

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

async function requireOllama(deps: Deps): Promise<string> {
  const res = await deps.getJson(`${OLLAMA_URL}/api/version`);
  const version = (res?.body as { version?: unknown } | undefined)?.version;
  if (res?.status !== 200 || typeof version !== "string") {
    throw new CliError("LOCAL_MODEL_UNREACHABLE", `Ollama does not answer at ${OLLAMA_URL}.`, {
      check: "ollama",
    });
  }
  return version;
}

/**
 * Prepares `model` on this machine's Ollama and returns the `.env` lines that
 * point the runtime at it. `pull` decides whether a missing model may be
 * downloaded; the caller asks the person first.
 */
export async function setupLocalModel(
  deps: Deps,
  model: string,
  pull: (model: string) => Promise<boolean>,
): Promise<Record<string, string>> {
  await requireOllama(deps);

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
 * against. Reports every check rather than stopping, and throws the first
 * failure's code.
 */
export async function checkLocalModel(deps: Deps, model: string): Promise<LocalCheck[]> {
  const checks: LocalCheck[] = [];
  const version = await requireOllama(deps).catch((err: CliError) => {
    checks.push({ check: "ollama", ok: false, detail: err.message });
    throw new CliError(err.code, err.message, { check: "ollama", checks });
  });
  checks.push({ check: "ollama", ok: true, detail: version });

  const found = await show(deps, model);
  const fail = (
    check: string,
    code: "LOCAL_MODEL_MISSING" | "LOCAL_MODEL_NO_TOOLS" | "LOCAL_CONTEXT_SMALL",
    detail: string,
  ): never => {
    checks.push({ check, ok: false, detail });
    throw new CliError(code, detail, { check, checks });
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
  return checks;
}
