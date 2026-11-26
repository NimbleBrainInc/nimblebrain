import { SOURCE_LIST, SOURCES, type Source } from "./args.ts";
import { hasKey, keyProvider, keyVars, paths } from "./compose.ts";
import {
  asks,
  type Ctx,
  carryingStarted,
  confirmOllamaStart,
  enterKey,
  start,
  useLocalModel,
} from "./lifecycle.ts";
import { DEFAULT_LOCAL_MODEL, ensureOllama, localModelOf } from "./local-model.ts";
import { CliError } from "./result.ts";
import {
  currentSource,
  detectSources,
  isSubscription,
  leaveSubscription,
  noSourceNamed,
  pickSource,
  refuseModelFor,
  type SubscriptionSource,
  startSubscription,
} from "./source.ts";
import { requireReady } from "./status.ts";
import { TOOL_SURFACE } from "./subscription/command.ts";

/**
 * Chooses what runs NimbleBrain's agents (`SOURCES`): the person's Claude
 * subscription through Claude Code, their ChatGPT plan through Codex, an API
 * key, or a local model through Ollama. With none named, a person at a
 * terminal picks from what this machine offers; anyone else is told the four.
 *
 * The choice reaches the runtime only through `.env`, which its container
 * reads when it is created, so `use` recreates it. A refusal comes before any
 * change: a subscription's sign-in is checked before its worker starts, and an
 * API key is asked for (or refused) before the worker stops.
 */
export async function use(ctx: Ctx) {
  const { deps, home } = ctx;
  const named = ctx.arg === undefined ? undefined : sourceArg(ctx.arg);
  if (ctx.operand !== undefined && named !== "local") {
    throw new CliError("USAGE", `Only use local takes a model, not "${ctx.operand}".`);
  }
  if (named === undefined && !asks(ctx)) throw noSourceNamed();
  refuseModelFor(ctx.flags.model, named ?? "claude");
  const install = await requireReady(deps, home);
  const source = named ?? (await askSource(ctx));
  refuseModelFor(ctx.flags.model, source);
  if (isSubscription(source)) return useSubscription(ctx, source, install.port);
  if (source === "api") return useApi(ctx, install.port);
  return useLocal(ctx, install.port);
}

function sourceArg(arg: string): Source {
  if ((SOURCES as readonly string[]).includes(arg)) return arg as Source;
  throw new CliError("USAGE", `use takes ${SOURCE_LIST}, not "${arg}".`);
}

async function askSource(ctx: Ctx): Promise<Source> {
  const p = paths(ctx.home);
  const envText = (await ctx.deps.readText(p.env)) ?? "";
  const composeText = (await ctx.deps.readText(p.compose)) ?? "";
  return pickSource(ctx.deps, await detectSources(ctx.deps, envText, composeText));
}

async function useSubscription(ctx: Ctx, source: SubscriptionSource, webPort: number) {
  const { worker, account, runtime, moved } = await startSubscription(
    ctx.deps,
    ctx.home,
    source,
    ctx.flags.port,
    ctx.flags.model,
  );
  await start(ctx.deps, ctx.home, webPort);
  return {
    ok: true as const,
    model_source: await currentSource(ctx.deps, ctx.home),
    agent_runtime: { name: runtime, worker },
    billed_to: account.describe,
    tools: TOOL_SURFACE[runtime],
    port_moved: moved,
  };
}

/**
 * The hosted provider's key: one already in `.env`, else entered at the
 * hidden prompt by a person at a terminal; with neither, `MODEL_KEY_MISSING`
 * before anything changes.
 */
async function useApi(ctx: Ctx, webPort: number) {
  const { deps, home } = ctx;
  const p = paths(home);
  const composeText = (await deps.readText(p.compose)) ?? "";
  if (!hasKey((await deps.readText(p.env)) ?? "", keyVars(composeText))) {
    if (!deps.interactive) {
      throw new CliError(
        "MODEL_KEY_MISSING",
        "This install has no model key, and `key` asks for one at a hidden prompt.",
      );
    }
    await enterKey(ctx, false);
  }
  await leaveSubscription(deps, home, true);
  await start(deps, home, webPort);
  return {
    ok: true as const,
    model_source: await currentSource(deps, home),
    agent_runtime: { name: "native" as const, worker: null },
    provider: keyProvider((await deps.readText(p.env)) ?? "", composeText),
  };
}

/**
 * A local model, as `local-model` sets one up: the model named, else the one
 * already saved (only checking Ollama answers), else the default.
 */
async function useLocal(ctx: Ctx, webPort: number) {
  const { deps, home } = ctx;
  const p = paths(home);
  const saved = localModelOf((await deps.readText(p.env)) ?? "");
  const composeText = (await deps.readText(p.compose)) ?? "";
  const { name, started } =
    ctx.operand === undefined && saved
      ? { name: saved, started: (await ensureOllama(deps, confirmOllamaStart(ctx, true))).started }
      : await useLocalModel(ctx, composeText, ctx.operand ?? DEFAULT_LOCAL_MODEL);
  await carryingStarted(started, async () => {
    await leaveSubscription(deps, home, false);
    await start(deps, home, webPort);
  });
  return {
    ok: true as const,
    model_source: await currentSource(deps, home),
    agent_runtime: { name: "native" as const, worker: null },
    local_model: name,
    ollama_started: started,
  };
}
