import {
  type AgentRuntimeState,
  preflight,
  SUBSCRIPTION_RUNTIMES,
  startWorker,
  stopWorker,
  writeAgentRuntime,
} from "./agent-worker.ts";
import { paths, takesAgentRuntime } from "./compose.ts";
import { type Ctx, start } from "./lifecycle.ts";
import { CliError } from "./result.ts";
import { requireReady } from "./status.ts";
import { type SubscriptionRuntime, TOOL_SURFACE, WORKER_PORTS } from "./subscription/command.ts";

/** What `use` takes, and the runtime each names. */
export const USE_CHOICES = {
  claude: "claude-code",
  codex: "codex",
  native: "native",
} as const satisfies Record<string, AgentRuntimeState["name"]>;

/**
 * Chooses the runtime NimbleBrain's agents run on. `claude` and `codex` run
 * each turn on the person's own Claude Code or Codex, signed in to their
 * subscription, through an agent worker on this machine; `native` runs them on
 * NimbleBrain's own engine again, on the install's model key or local model.
 *
 * The choice reaches the runtime only through `.env`, which its container
 * reads when it is created, so `use` recreates it. The worker starts first,
 * after the same sign-in check it makes itself, so a turn never reaches a
 * worker that would bill an API key or is not there.
 */
export async function use(ctx: Ctx) {
  const { deps, home } = ctx;
  const choice = useChoice(ctx.arg);
  const install = await requireReady(deps, home);
  if (choice === "native") {
    await stopWorker(deps, home);
    await writeAgentRuntime(deps, home, "native");
    await start(deps, home, install.port);
    return { ok: true as const, agent_runtime: { name: choice, worker: null } };
  }

  const runtime: SubscriptionRuntime = choice;
  if (deps.platform === "linux") {
    throw new CliError(
      "HOST_LOOPBACK_UNREACHABLE",
      `On Linux, NimbleBrain's container cannot reach an agent worker on this machine's 127.0.0.1, so it cannot run on ${SUBSCRIPTION_RUNTIMES[runtime].label} yet.`,
    );
  }
  const composeText = (await deps.readText(paths(home).compose)) ?? "";
  if (!takesAgentRuntime(composeText)) {
    throw new CliError(
      "RUNTIME_UNSUPPORTED",
      "This release's runtime takes no agent runtime from .env; a newer release does.",
    );
  }
  const account = await preflight(deps, runtime);
  await stopWorker(deps, home);
  const port = ctx.flags.port ?? WORKER_PORTS[runtime];
  const worker = await startWorker(deps, home, runtime, port);
  await writeAgentRuntime(deps, home, runtime, port);
  await start(deps, home, install.port);
  return {
    ok: true as const,
    agent_runtime: { name: runtime, worker },
    billed_to: account.describe,
    tools: TOOL_SURFACE[runtime],
  };
}

function useChoice(arg: string | undefined): (typeof USE_CHOICES)[keyof typeof USE_CHOICES] {
  if (arg === undefined || !Object.hasOwn(USE_CHOICES, arg)) {
    throw new CliError(
      "USAGE",
      `use takes claude, codex or native${arg === undefined ? "" : `, not "${arg}"`}.`,
    );
  }
  return USE_CHOICES[arg as keyof typeof USE_CHOICES];
}
