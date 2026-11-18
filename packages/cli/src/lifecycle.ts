import { connectAgent, installSkill, SERVER_NAME } from "./agents.ts";
import { AGENTS, type Agent, type Flags } from "./args.ts";
import {
  asksConsent,
  compose,
  fetchCompose,
  hasKey,
  INSTANCE_JSON,
  keyVars,
  PROJECT,
  paths,
  providers,
  setEnvLines,
  startError,
  VOLUME,
} from "./compose.ts";
import type { Deps } from "./deps.ts";
import { doctor } from "./doctor.ts";
import { compareVersions, runtimeTag } from "./release.ts";
import { CliError, type Ok } from "./result.ts";
import { type InstallState, readInstall, type StatusResult, status } from "./status.ts";
import {
  type Consent,
  envValues,
  field,
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
  /** The command's argument; only `telemetry` takes one. */
  arg?: string;
}

/** A person is there to answer, and did not ask for defaults or machine output. */
const asks = ({ deps, flags }: Ctx) => deps.interactive && !flags.yes && !flags.json;

/**
 * Check, write, start, wait, then connect. Safe to run again: an existing
 * install is reported, not touched. The model key is asked for only when a
 * person is at the terminal; otherwise a missing key ends `init` with
 * `MODEL_KEY_MISSING` after everything else is up, carrying the full status.
 */
export async function init(ctx: Ctx): Promise<Ok> {
  const { deps, flags, home } = ctx;
  if (await readInstall(deps, home)) return { ...(await status(deps, home)), already: true };

  // A person is asked after agreeing to the install (in `install`); until then the
  // answer is what a flag or the environment already gave, so a failure before the
  // question waits in the report and leaves only on a later yes.
  const answer = { consent: await chooseConsent(ctx, false) };
  const rec = recorder(deps, ctx.version, await reportId(deps, home));
  const begun = Date.now();
  rec.record("cli.init_started", { agent: flags.agent ?? null, interactive: deps.interactive });
  try {
    return await install(ctx, answer, rec, begun);
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    // Declining the start before any answer changed nothing, so it leaves no report either.
    if (err.code !== "CANCELLED" || answer.consent !== "undecided")
      await settleFailure(rec, home, answer.consent, err);
    throw new CliError(err.code, err.message, {
      ...err.detail,
      telemetry: field(answer.consent, lockedHere(deps)),
    });
  }
}

/** Records why `init` stopped (a missing key is not a failure) and settles the run. */
async function settleFailure(rec: Recorder, home: string, consent: Consent, err: CliError) {
  if (err.code !== "MODEL_KEY_MISSING") {
    const check = typeof err.detail.check === "string" ? err.detail.check : undefined;
    rec.record(check ? "cli.doctor_failed" : "cli.init_failed", { error: err.code, check });
  }
  await rec.settle(home, consent);
}

/**
 * The answer, in order: `--telemetry`, then the person at the terminal (when
 * `ask`), else undecided. Never asked when `DO_NOT_TRACK` is set or there is nowhere to send.
 */
async function chooseConsent(ctx: Ctx, ask: boolean): Promise<Consent> {
  if (lockedHere(ctx.deps)) return "off";
  if (ctx.flags.telemetry) return ctx.flags.telemetry;
  if (!ask || !asks(ctx)) return "undecided";
  return parseAnswer(await ctx.deps.prompt(`${QUESTION} [y/N] `));
}

async function install(
  ctx: Ctx,
  answer: { consent: Consent },
  rec: Recorder,
  begun: number,
): Promise<Ok> {
  const { deps, flags, home } = ctx;
  await doctor(deps, flags.port);
  await guardOurs(deps, home);
  const tag = await runtimeTag(deps, flags.runtime);
  const composeText = await fetchCompose(deps, tag);
  await confirmStart(ctx, tag);
  answer.consent = await chooseConsent(ctx, true);
  const { consent } = answer;

  await writeInstallFiles(
    deps,
    home,
    tag,
    flags.port,
    composeText,
    envValues(deps, rec.id, consent, asksConsent(composeText)),
  );
  // Asked before the start: the runtime reads `.env` only when its container is created.
  if (!hasKey((await deps.readText(paths(home).env)) ?? "", keyVars(composeText)) && asks(ctx))
    await enterKey(ctx, false);
  deps.say(`Starting NimbleBrain ${tag}. The first start downloads about 2 GB of images.`);
  await start(deps, home, flags.port);

  const state: InstallState = {
    version: tag.replace(/^v/, ""),
    port: flags.port,
    project: PROJECT,
  };
  await writeState(deps, home, state);
  const manual = await connectChosenAgent(ctx, state);
  if (state.agent) rec.record("cli.agent_connected", { agent: state.agent });

  const result: StatusResult & { manual?: string } = { ...(await status(deps, home)), manual };
  rec.record("cli.init_completed", {
    duration_ms: Date.now() - begun,
    model_key: result.model_key,
  });
  await rec.settle(home, consent);
  if (result.model_key === "missing") {
    throw new CliError("MODEL_KEY_MISSING", "NimbleBrain is running; chat needs a model key.", {
      ...result,
    });
  }
  return { ...result };
}

async function confirmStart(ctx: Ctx, tag: string): Promise<void> {
  if (!asks(ctx)) return;
  const answer = await ctx.deps.prompt(
    `Start NimbleBrain ${tag} at http://127.0.0.1:${ctx.flags.port}? [Y/n] `,
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

export async function up(ctx: Ctx): Promise<Ok> {
  const install = await requireInstall(ctx);
  await start(ctx.deps, ctx.home, install.port);
  return { ...(await status(ctx.deps, ctx.home)) };
}

export async function down(ctx: Ctx): Promise<Ok> {
  await requireInstall(ctx);
  const res = await compose(ctx.deps, ctx.home, ["down"]);
  if (res.code !== 0) throw startError(res);
  return { ok: true, health: "down" };
}

export async function logs(ctx: Ctx): Promise<Ok> {
  await requireInstall(ctx);
  const res = await compose(ctx.deps, ctx.home, [
    "logs",
    "--no-color",
    "--tail",
    "100",
    "platform",
  ]);
  if (res.code !== 0) throw startError(res);
  return { ok: true, lines: res.stdout.split("\n").filter((l) => l.trim()) };
}

/**
 * Moves the install to the newest runtime release, or the one `--runtime`
 * names, keeping the data volume. The CLI is versioned on its own (ADR-0064),
 * so updating the runtime needs no newer CLI. Refuses to move an install
 * backwards, since a release's data may not read on an older one.
 */
export async function update(ctx: Ctx): Promise<Ok> {
  const { deps, home } = ctx;
  const install = await requireInstall(ctx);
  const tag = await runtimeTag(deps, ctx.flags.runtime);
  const from = `v${install.version}`;
  const order = compareVersions(tag, from);
  if (order === 0) return { ...(await status(deps, home)), already: true };
  if (order < 0) {
    throw new CliError(
      "USAGE",
      `${tag} is older than the installed ${from}; NimbleBrain does not move backwards.`,
    );
  }

  const composeText = await fetchCompose(deps, tag);
  await writeInstallFiles(deps, home, tag, install.port, composeText);
  deps.say(`Updating NimbleBrain ${from} → ${tag}.`);
  const pull = await compose(deps, home, ["pull"], START_TIMEOUT_MS);
  if (pull.code !== 0) throw startError(pull);
  await start(deps, home, install.port);
  await writeState(deps, home, { ...install, version: tag.replace(/^v/, "") });
  return { ...(await status(deps, home)), from };
}

/**
 * Removes the containers, images, the data volume and the files `init` wrote.
 * The install folder goes too when nothing else is left in it. Asks first.
 */
export async function uninstall(ctx: Ctx): Promise<Ok> {
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
  for (const file of [...Object.values(paths(home)), reportPath(home)]) await deps.remove(file);
  await deps.remove(home);
  return { ok: true, removed: true };
}

/**
 * Reports or changes whether the install sends anonymous telemetry. The
 * running runtime keeps the answer, so this and the web UI change the same
 * thing; changing it needs the runtime up. A report waiting from earlier runs
 * is sent on `on` and deleted on `off`.
 */
export async function telemetry(ctx: Ctx): Promise<Ok> {
  const { deps, home } = ctx;
  const install = await requireInstall(ctx);
  const url = `http://127.0.0.1:${install.port}`;
  if (ctx.arg !== "on" && ctx.arg !== "off") {
    return { ok: true, telemetry: (await status(deps, home)).telemetry };
  }
  const here = lockedHere(deps);
  if (here) {
    throw new CliError(
      "TELEMETRY_LOCKED",
      here === "do_not_track"
        ? "DO_NOT_TRACK (or NB_TELEMETRY_DISABLED) is set, so telemetry stays off."
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
  return { ok: true, telemetry: field(ctx.arg) };
}

/** Takes the model key at a hidden prompt. A person runs this; an agent never handles the key. */
export async function key(ctx: Ctx): Promise<Ok> {
  if (!ctx.deps.interactive) {
    throw new CliError("NEEDS_TERMINAL", "`key` asks for a model key at a hidden prompt.");
  }
  await requireInstall(ctx);
  return enterKey(ctx, true);
}

async function enterKey(ctx: Ctx, restart: boolean): Promise<Ok> {
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
    await start(deps, home, install?.port ?? flags.port);
  }
  return { ok: true, provider, model_key: "set" };
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
    COMPOSE_PROJECT_NAME: PROJECT,
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
 * project, which is the mark a previous, unfinished `init` leaves.
 */
async function guardOurs(deps: Deps, home: string): Promise<void> {
  const env = await deps.readText(paths(home).env);
  if (env?.includes(`COMPOSE_PROJECT_NAME=${PROJECT}`)) return;
  for (const file of Object.values(paths(home))) {
    if ((await deps.readText(file)) !== undefined) {
      throw new CliError("NOT_OURS", `${file} already exists and this CLI did not write it.`);
    }
  }
  const projects = await deps.exec("docker", ["compose", "ls", "-a", "--format", "json"]);
  const taken = projects.code === 0 && /"Name"\s*:\s*"nimblebrain-local"/.test(projects.stdout);
  const volumes = await deps.exec("docker", ["volume", "ls", "-q", "--filter", `name=^${VOLUME}$`]);
  if (taken || volumes.stdout.trim() !== "") {
    throw new CliError(
      "NOT_OURS",
      `Docker already has a "${PROJECT}" project or volume that this install did not make.`,
    );
  }
}
