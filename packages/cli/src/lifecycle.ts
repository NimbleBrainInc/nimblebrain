import {
  connectAgent,
  installSkill,
  refreshSkill,
  SERVER_NAME,
  type SkillRefresh,
} from "./agents.ts";
import { AGENTS, type Agent, DEFAULT_PORT, type Flags } from "./args.ts";
import {
  asksConsent,
  compose,
  composeExec,
  DEFAULT_PROJECT,
  fetchCompose,
  hasKey,
  INSTANCE_JSON,
  keyProvider,
  keyVars,
  paths,
  projectFor,
  providers,
  setEnvLines,
  startError,
  volumeOf,
} from "./compose.ts";
import { type Deps, invocation } from "./deps.ts";
import { doctor } from "./doctor.ts";
import {
  DEFAULT_LOCAL_MODEL,
  ensureOllama,
  localModelOf,
  setupLocalModel,
  takesLocalModel,
} from "./local-model.ts";
import { openBrowser } from "./open.ts";
import { compareVersions, runtimeTag } from "./release.ts";
import { CliError } from "./result.ts";
import { hasModelIn, type InstallState, readInstall, type StatusResult, status } from "./status.ts";
import {
  type Consent,
  envValues,
  field,
  idPath,
  installId,
  lockedHere,
  parseAnswer,
  QUESTION,
  type Recorder,
  recorder,
  reportId,
  reportPath,
  runtimeTelemetry,
  setRuntimeTelemetry,
} from "./telemetry.ts";

/** How long a pull plus first start may take, and how long health may take after it. */
const START_TIMEOUT_MS = 15 * 60_000;
const HEALTH_TIMEOUT_MS = 3 * 60_000;

export interface Ctx {
  deps: Deps;
  flags: Flags;
  home: string;
  /** This CLI's own version, which telemetry reports; it says nothing about the runtime (ADR-0064). */
  version: string;
  /** The command's argument: `telemetry`'s answer, or the `mcp` subcommand. */
  arg?: string;
  /** The `mcp` subcommand's operand: the URL to add or the server to remove. */
  operand?: string;
}

/** A person is there to answer, and did not ask for defaults or machine output. */
const asks = ({ deps, flags }: Pick<Ctx, "deps" | "flags">) =>
  deps.interactive && !flags.yes && !flags.json;

/** `[Y/n]`: Enter or an answer starting with y is yes. */
const yes = (answer: string) => /^(y|yes)?$/i.test(answer.trim());

/**
 * Whether to start a down Ollama with `command`: asked once at a terminal;
 * otherwise `unasked`, which is yes for the commands that set up or start
 * NimbleBrain and no for `doctor`, which only starts what a person agreed to.
 */
export function confirmOllamaStart(ctx: Pick<Ctx, "deps" | "flags">, unasked: boolean) {
  return async (command: string): Promise<boolean> => {
    if (!asks(ctx)) return unasked;
    const login = command.startsWith("brew services") ? " It then also starts at login." : "";
    return yes(
      await ctx.deps.prompt(`Ollama isn't running. Start it with \`${command}\`?${login} [Y/n] `),
    );
  };
}

/**
 * Check, write, start, wait, then connect. Safe to run again: an existing
 * install is reported, not touched. The model is asked for only when a
 * person is at the terminal; otherwise `init` still succeeds once everything
 * else is up, and its answer says `model_key: missing` with `local_model: null`,
 * for the person to run `key` or `local-model`. A running install is not a failure.
 */
export async function init(ctx: Ctx) {
  const { deps, flags, home } = ctx;
  if (await readInstall(deps, home)) return { ...(await status(deps, home)), already: true };

  // Asked before anything else, so a failed check reaches us when the person said yes.
  const consent = await chooseConsent(ctx);
  // Kept before the checks, so every attempt on this home is one install. Never
  // in a home holding files this CLI did not write; `install` refuses that home.
  const id = (await foreignFile(deps, home)) ? undefined : await installId(deps, home);
  const rec = recorder(deps, ctx.version, id ?? (await reportId(deps, home)));
  const begun = Date.now();
  rec.record("cli.init_started", { agent: flags.agent ?? null, interactive: deps.interactive });
  try {
    return await openWhenDone(ctx, await install(ctx, consent, rec, begun));
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    // Declining the start with no answer given changed nothing, so it leaves no report either.
    if (err.code !== "CANCELLED" || consent !== "undecided")
      await settleFailure(rec, home, consent, err);
    throw err.with({ telemetry: field(consent, invocation(deps, home), lockedHere(deps)) });
  }
}

/**
 * A fresh install that came up opens the web UI for a person at the terminal,
 * unless `--no-open`. Never under `--json` or with no terminal: an agent drives
 * those, and it opens the UI with `open` when the person asks. A rerun opens
 * nothing; `open` is the command for that.
 */
async function openWhenDone<
  T extends { health: string; url: string; model_key: string; local_model: string | null },
>(ctx: Ctx, result: T): Promise<T & { opened?: boolean }> {
  const { deps, flags } = ctx;
  if (!deps.interactive || flags.json || flags.noOpen) return result;
  // With no model, chat in the browser would fail; the next step is in the terminal.
  if (result.health !== "ok" || !hasModelIn(result)) return result;
  return { ...result, opened: await openBrowser(deps, result.url) };
}

/** Records why `init` stopped and settles the run. */
async function settleFailure(rec: Recorder, home: string, consent: Consent, err: CliError) {
  const check = typeof err.detail.check === "string" ? err.detail.check : undefined;
  rec.record(check ? "cli.doctor_failed" : "cli.init_failed", { error: err.code, check });
  await rec.settle(home, consent);
}

/**
 * The answer, in order: `--telemetry`, then the person at the terminal, else
 * undecided. Never asked when `DO_NOT_TRACK` is set or there is nowhere to send,
 * and never answered by `--yes`: no person saw the question.
 */
async function chooseConsent(ctx: Ctx): Promise<Consent> {
  if (lockedHere(ctx.deps)) return "off";
  if (ctx.flags.telemetry) return ctx.flags.telemetry;
  if (!asks(ctx)) return "undecided";
  const consent = parseAnswer(await ctx.deps.prompt(`${QUESTION} [Y/n] `));
  const cli = invocation(ctx.deps, ctx.home);
  ctx.deps.say(
    consent === "on"
      ? `Sending anonymous usage data. Turn it off any time: ${cli} telemetry off`
      : `No usage data will be sent. Turn it on any time: ${cli} telemetry on`,
  );
  return consent;
}

async function install(ctx: Ctx, consent: Consent, rec: Recorder, begun: number) {
  const { deps, flags, home } = ctx;
  const port = flags.port ?? DEFAULT_PORT;
  await doctor(deps, port);
  const project = await guardOurs(deps, home);
  const tag = await runtimeTag(deps, flags.runtime);
  const composeText = await fetchCompose(deps, tag);
  await confirmStart(ctx, tag, port);

  await writeInstallFiles(
    deps,
    home,
    project,
    tag,
    port,
    composeText,
    envValues(deps, lockedHere(deps) ? undefined : rec.id, consent, asksConsent(composeText)),
  );
  // Asked before the start: the runtime reads `.env` only when its container is created.
  const envText = (await deps.readText(paths(home).env)) ?? "";
  const hasModel = hasKey(envText, keyVars(composeText)) || localModelOf(envText) !== undefined;
  const local =
    flags.localModel ??
    (!hasModel && asks(ctx) && takesLocalModel(composeText)
      ? await chooseModelSource(deps)
      : undefined);
  let ollamaStarted: string | undefined;
  if (local) ollamaStarted = (await useLocalModel(ctx, composeText, local)).started;
  else if (!hasModel && asks(ctx)) await enterKey(ctx, false);
  return carryingStarted(ollamaStarted, async () => {
    deps.say(`Starting NimbleBrain ${tag}. The first start downloads about 2 GB of images.`);
    await start(deps, home, port);

    const state: InstallState = {
      version: tag.replace(/^v/, ""),
      port,
      project,
    };
    await writeState(deps, home, state);
    const manual = await connectChosenAgent(ctx, state);
    if (state.agent) rec.record("cli.agent_connected", { agent: state.agent });

    const result: StatusResult & { manual?: string; ollama_started?: string } = {
      ...(await status(deps, home)),
      manual,
      ollama_started: ollamaStarted,
    };
    const finalEnv = (await deps.readText(paths(home).env)) ?? "";
    rec.record("cli.init_completed", {
      duration_ms: Date.now() - begun,
      model_key: result.model_key,
      // A provider's name, never a model's: a local model is reported only as `ollama`.
      provider: localModelOf(finalEnv) ? "ollama" : keyProvider(finalEnv, composeText),
      agent: state.agent ?? null,
    });
    await rec.settle(home, consent);
    return { ...result };
  });
}

async function confirmStart(ctx: Ctx, tag: string, port: number): Promise<void> {
  if (!asks(ctx)) return;
  const answer = await ctx.deps.prompt(
    `Start NimbleBrain ${tag} at http://127.0.0.1:${port}? [Y/n] `,
  );
  if (/^n/i.test(answer)) throw new CliError("CANCELLED", "Nothing was installed.");
}

/**
 * Registers the first workspace with the agent named by `--agent` (or chosen
 * at the prompt), records the agent in the install's state, and installs the
 * skill for it. Returns the settings to add by hand when connecting failed.
 */
async function connectChosenAgent(ctx: Ctx, state: InstallState): Promise<string | undefined> {
  const { deps, flags, home } = ctx;
  const agent = flags.agent ?? (asks(ctx) ? await chooseAgent(deps) : undefined);
  if (!agent || agent === "none") return undefined;
  const first = (await status(deps, home)).workspaces[0];
  if (!first) return undefined;
  const conn = await connectAgent(deps, agent, first.mcp);
  if (conn.connected) {
    state.agent = conn.connected;
    await installSkill(deps, conn.connected);
    await writeState(deps, home, state);
  }
  return conn.manual;
}

/**
 * Starts NimbleBrain. On a local model, Ollama is checked first and started
 * when it is installed but down (after a reboot, say); NimbleBrain starts
 * either way, and an Ollama still down ends `up` with `LOCAL_MODEL_UNREACHABLE`
 * carrying the status, since every agent's message would fail.
 */
export async function up(ctx: Ctx) {
  const { deps, home } = ctx;
  const install = await requireInstall(ctx);
  const local = localModelOf((await deps.readText(paths(home).env)) ?? "");
  const ollama = local
    ? await ensureOllama(deps, confirmOllamaStart(ctx, true)).catch((err: unknown) => {
        if (err instanceof CliError) return err;
        throw err;
      })
    : undefined;
  const started =
    ollama instanceof CliError
      ? (ollama.detail.ollama_started as string | undefined)
      : ollama?.started;
  const result = await carryingStarted(started, async () => {
    await start(deps, home, install.port);
    return status(deps, home);
  });
  if (ollama instanceof CliError) {
    throw ollama.with({ ...result }, `NimbleBrain is running, but ${lowerFirst(ollama.message)}`);
  }
  return { ...result, ollama_started: ollama?.started };
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export async function down(ctx: Ctx) {
  await requireInstall(ctx);
  const res = await compose(ctx.deps, ctx.home, ["down"]);
  if (res.code !== 0) throw startError(res);
  return { ok: true as const, health: "down" };
}

export async function logs(ctx: Ctx) {
  // A start that failed leaves no install.json, and its error's fix names this command.
  if (!(await markedProject(ctx.deps, ctx.home))) await requireInstall(ctx);
  const res = await compose(ctx.deps, ctx.home, [
    "logs",
    "--no-color",
    "--tail",
    "100",
    "platform",
  ]);
  if (res.code !== 0) throw startError(res);
  return { ok: true as const, lines: res.stdout.split("\n").filter((l) => l.trim()) };
}

/**
 * Moves the install to the newest runtime release, or the one `--runtime`
 * names, keeping the data volume, then refreshes the connected agent's skill,
 * so everything the CLI installed is current. The CLI is versioned on its own
 * (ADR-0064), so updating the runtime needs no newer CLI. Refuses to move an
 * install backwards, since a release's data may not read on an older one. The
 * skill is refreshed on a current runtime too; its refresh never fails `update`.
 */
export async function update(ctx: Ctx) {
  const { deps, home } = ctx;
  const install = await requireInstall(ctx);
  const tag = await runtimeTag(deps, ctx.flags.runtime);
  const from = `v${install.version}`;
  const order = compareVersions(tag, from);
  if (order === 0) {
    const skill_update = await refreshAgentSkill(deps, install);
    return { ...(await status(deps, home)), already: true, ...skill_update };
  }
  if (order < 0) {
    throw new CliError(
      "USAGE",
      `${tag} is older than the installed ${from}; NimbleBrain does not move backwards.`,
    );
  }

  const composeText = await fetchCompose(deps, tag);
  await writeInstallFiles(deps, home, install.project, tag, install.port, composeText);
  deps.say(`Updating NimbleBrain ${from} → ${tag}.`);
  const pull = await compose(deps, home, ["pull"], START_TIMEOUT_MS);
  if (pull.code !== 0) throw startError(pull);
  await start(deps, home, install.port);
  await writeState(deps, home, { ...install, version: tag.replace(/^v/, "") });
  const skill_update = await refreshAgentSkill(deps, install);
  return { ...(await status(deps, home)), from, ...skill_update };
}

/** `skill_update` for the answer, when an agent is connected. */
async function refreshAgentSkill(
  deps: Deps,
  install: InstallState,
): Promise<{ skill_update?: SkillRefresh }> {
  if (!install.agent || install.agent === "none") return {};
  return { skill_update: await refreshSkill(deps, install.agent) };
}

/**
 * Removes the containers, images, the data volume and the files `init` wrote.
 * The install folder goes too when nothing else is left in it. Asks first.
 */
export async function uninstall(ctx: Ctx) {
  const { deps, flags, home } = ctx;
  const install = await requireInstall(ctx);
  if (!flags.yes) {
    if (!deps.interactive || flags.json) {
      throw new CliError(
        "CANCELLED",
        "Removing deletes every conversation; pass --yes to confirm.",
      );
    }
    const answer = await deps.prompt("Remove NimbleBrain and every conversation in it? [y/N] ");
    if (!/^y/i.test(answer)) throw new CliError("CANCELLED", "Nothing was removed.");
  }
  const res = await compose(deps, home, ["down", "-v", "--rmi", "all"], START_TIMEOUT_MS);
  if (res.code !== 0) throw startError(res);
  if (install.agent === "claude-code")
    await deps.exec("claude", ["mcp", "remove", "-s", "user", SERVER_NAME]);
  if (install.agent === "codex") await deps.exec("codex", ["mcp", "remove", SERVER_NAME]);
  for (const file of [...Object.values(paths(home)), reportPath(home), idPath(home)])
    await deps.remove(file);
  await deps.remove(home);
  return { ok: true as const, removed: true };
}

/**
 * Reports or changes whether the install sends anonymous telemetry. The
 * running runtime keeps the answer, so this and the web UI change the same
 * thing; changing it needs the runtime up. A report waiting from earlier runs
 * is sent on `on` and deleted on `off`.
 */
export async function telemetry(ctx: Ctx) {
  const { deps, home } = ctx;
  const install = await requireInstall(ctx);
  const url = `http://127.0.0.1:${install.port}`;
  if (ctx.arg !== "on" && ctx.arg !== "off") {
    return { ok: true as const, telemetry: (await status(deps, home)).telemetry };
  }
  const here = lockedHere(deps);
  if (here) {
    throw new CliError(
      "TELEMETRY_LOCKED",
      here === "do_not_track"
        ? "DO_NOT_TRACK is set, so telemetry stays off."
        : "This CLI has nowhere to send telemetry.",
    );
  }
  const rt = await runtimeTelemetry(deps, url);
  if (!rt)
    throw new CliError(
      "NOT_RUNNING",
      "NimbleBrain is not running, so it cannot record the answer.",
    );
  await setRuntimeTelemetry(deps, url, ctx.arg);
  // The answer the CLI holds in `.env` follows, so the two never disagree.
  const p = paths(home);
  await deps.writeText(
    p.env,
    setEnvLines((await deps.readText(p.env)) ?? "", { NB_TELEMETRY_CONSENT: ctx.arg }),
    0o600,
  );
  const rec = recorder(deps, ctx.version, await reportId(deps, home));
  await rec.settle(home, ctx.arg);
  return { ok: true as const, telemetry: field(ctx.arg, invocation(deps, home)) };
}

/** Takes the model key at a hidden prompt. A person runs this; an agent never handles the key. */
export async function key(ctx: Ctx) {
  if (!ctx.deps.interactive) {
    throw new CliError("NEEDS_TERMINAL", "`key` asks for a model key at a hidden prompt.");
  }
  await requireInstall(ctx);
  return enterKey(ctx, true);
}

async function enterKey(ctx: Ctx, restart: boolean) {
  const { deps, flags, home } = ctx;
  const offered = providers((await deps.readText(paths(home).compose)) ?? "");
  const names = Object.keys(offered);
  let provider = flags.provider;
  deps.say("NimbleBrain's own agents run on a model key you give it, billed by that provider.");
  if (!provider) {
    const answer = await deps.prompt(`Model provider (${names.join(", ")}) [anthropic]: `);
    provider = answer || "anthropic";
  }
  const variable = offered[provider];
  if (!variable)
    throw new CliError("USAGE", `Unknown provider "${provider}"; one of ${names.join(", ")}.`);
  const value = await deps.prompt(`${variable} (nothing is shown as you type): `, { hidden: true });
  if (!value) throw new CliError("CANCELLED", "No key was entered.");

  const p = paths(home);
  await deps.writeText(
    p.env,
    setEnvLines((await deps.readText(p.env)) ?? "", { [variable]: value }),
    0o600,
  );
  // `up` recreates the runtime container, which is what makes it read `.env` again; a restart does not.
  if (restart) {
    const install = await readInstall(deps, home);
    await start(deps, home, install?.port ?? DEFAULT_PORT);
  }
  return { ok: true as const, provider, model_key: "set" };
}

/**
 * Prepares a local model on this machine's Ollama and points the install's
 * `.env` at it, then starts the runtime again so its container reads it.
 */
export async function localModel(ctx: Ctx) {
  const install = await requireInstall(ctx);
  const composeText = (await ctx.deps.readText(paths(ctx.home).compose)) ?? "";
  const model = ctx.arg ?? ctx.flags.localModel ?? DEFAULT_LOCAL_MODEL;
  const { name, started } = await useLocalModel(ctx, composeText, model);
  // `up` recreates the runtime container, which is what makes it read `.env` again.
  await carryingStarted(started, () => start(ctx.deps, ctx.home, install.port));
  return { ok: true as const, local_model: name, ollama_started: started };
}

/** Runs what follows an Ollama start; an error from it still says what started Ollama. */
async function carryingStarted<T>(started: string | undefined, next: () => Promise<T>): Promise<T> {
  try {
    return await next();
  } catch (err) {
    if (err instanceof CliError && started) throw err.with({ ollama_started: started });
    throw err;
  }
}

/** Asks which model NimbleBrain's own agents run on: a local model's name, or undefined for a hosted key. */
async function chooseModelSource(deps: Deps): Promise<string | undefined> {
  deps.say(
    "NimbleBrain's own agents need a model: a hosted one with your API key, or a local one through Ollama (free, slower; https://docs.nimblebrain.ai/config/local-models/).",
  );
  const answer = (await deps.prompt("Model (hosted, local) [hosted]: ")).trim().toLowerCase();
  return answer === "local" ? DEFAULT_LOCAL_MODEL : undefined;
}

/**
 * Prepares `model` on Ollama (starting Ollama when it is installed but down)
 * and writes its `.env` lines; answers the name the runtime will use and the
 * command that started Ollama, if any.
 */
async function useLocalModel(
  ctx: Ctx,
  composeText: string,
  model: string,
): Promise<{ name: string; started?: string }> {
  const { deps, home } = ctx;
  if (!takesLocalModel(composeText)) {
    throw new CliError(
      "RUNTIME_UNSUPPORTED",
      "This release's runtime takes no local model; a newer release does.",
    );
  }
  const { values, started } = await setupLocalModel(deps, model, {
    start: confirmOllamaStart(ctx, true),
    pull: (m) => confirmPull(ctx, m),
  });
  const p = paths(home);
  await deps.writeText(p.env, setEnvLines((await deps.readText(p.env)) ?? "", values), 0o600);
  return { name: values.NB_LOCAL_MODEL ?? model, started };
}

/** Whether a missing model may be downloaded: asked at a terminal, taken as yes otherwise (`--yes`). */
async function confirmPull(ctx: Ctx, model: string): Promise<boolean> {
  if (!asks(ctx)) return true;
  return yes(await ctx.deps.prompt(`Download ${model} with Ollama? It is several GB. [Y/n] `));
}

async function chooseAgent(deps: Deps): Promise<Agent> {
  deps.say(
    "A coding agent you connect can use NimbleBrain's tools. NimbleBrain's own agents still run on the model key above.",
  );
  const answer = await deps.prompt(`Connect a coding agent? (${AGENTS.join(", ")}) [none]: `);
  return (AGENTS as readonly string[]).includes(answer) ? (answer as Agent) : "none";
}

async function start(deps: Deps, home: string, port: number): Promise<void> {
  const res = await compose(deps, home, ["up", "-d", "--no-build"], START_TIMEOUT_MS);
  if (res.code !== 0) throw startError(res);
  await waitHealthy(deps, port);
}

async function waitHealthy(deps: Deps, port: number): Promise<void> {
  const url = `http://127.0.0.1:${port}/v1/health`;
  for (let waited = 0; waited <= HEALTH_TIMEOUT_MS; waited += 2_000) {
    const res = await deps.getJson(url);
    if (res?.status === 200) return;
    await deps.sleep(2_000);
  }
  throw new CliError("HEALTH_TIMEOUT", "NimbleBrain did not report healthy within 3 minutes.");
}

/**
 * The chosen release's Compose file, the `dev` adapter, and `.env` with the
 * pinned release and port. `.env` keeps any key already in it; `instance.json` is
 * never overwritten, so a person who chose another adapter keeps it.
 */
async function writeInstallFiles(
  deps: Deps,
  home: string,
  project: string,
  tag: string,
  port: number,
  composeText: string,
  extra: Record<string, string> = {},
): Promise<void> {
  const p = paths(home);
  await deps.writeText(p.compose, composeText);
  if ((await deps.readText(p.instance)) === undefined)
    await deps.writeText(p.instance, INSTANCE_JSON);
  const env = setEnvLines((await deps.readText(p.env)) ?? "", {
    COMPOSE_PROJECT_NAME: project,
    NIMBLEBRAIN_TAG: tag,
    NIMBLEBRAIN_WEB_PORT: String(port),
    ...extra,
  });
  await deps.writeText(p.env, env, 0o600);
}

async function writeState(deps: Deps, home: string, state: InstallState): Promise<void> {
  await deps.writeText(paths(home).install, `${JSON.stringify(state, null, 2)}\n`);
}

async function requireInstall({ deps, home }: Ctx): Promise<InstallState> {
  const install = await readInstall(deps, home);
  if (!install) throw new CliError("NOT_INSTALLED", `No NimbleBrain install in ${home}.`);
  return install;
}

/**
 * Refuses to start over another install's containers or data, or over files
 * in the home that the CLI did not write (`uninstall` deletes them). A home,
 * project or volume counts as ours only when this home's `.env` names the
 * project, which is the mark a previous, unfinished `init` leaves: the project
 * this home gets, or the one an older CLI gave every home. Answers the project
 * the install uses.
 */
async function guardOurs(deps: Deps, home: string): Promise<string> {
  const project = projectFor(home);
  const marked = await markedProject(deps, home);
  if (marked) return marked;
  const file = await foreignFile(deps, home);
  if (file) throw new CliError("NOT_OURS", `${file} already exists and this CLI did not write it.`);
  const projects = await composeExec(deps, ["ls", "-a", "--format", "json"]);
  const taken = projects.code === 0 && listsProject(projects.stdout, project);
  const volumes = await deps.exec("docker", [
    "volume",
    "ls",
    "-q",
    "--filter",
    `name=^${volumeOf(project)}$`,
  ]);
  if (taken || volumes.stdout.trim() !== "") {
    throw new CliError(
      "NOT_OURS",
      `Docker already has a "${project}" project or volume that this install did not make.`,
    );
  }
  return project;
}

/** The project this home's `.env` marks as ours (see `guardOurs`), if it marks one. */
async function markedProject(deps: Deps, home: string): Promise<string | undefined> {
  const env = await deps.readText(paths(home).env);
  const marked = env?.match(/^COMPOSE_PROJECT_NAME=(.*?)\r?$/m)?.[1];
  return marked === projectFor(home) || marked === DEFAULT_PROJECT ? marked : undefined;
}

/** A file in the home that this CLI did not write, if there is one. */
async function foreignFile(deps: Deps, home: string): Promise<string | undefined> {
  if (await markedProject(deps, home)) return undefined;
  for (const file of Object.values(paths(home))) {
    if ((await deps.readText(file)) !== undefined) return file;
  }
  return undefined;
}

/** Whether `docker compose ls --format json` lists a project by exactly this name. */
function listsProject(stdout: string, project: string): boolean {
  try {
    const list = JSON.parse(stdout) as unknown;
    return Array.isArray(list) && list.some((p) => (p as { Name?: unknown })?.Name === project);
  } catch {
    return false;
  }
}
