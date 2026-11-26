import { join } from "node:path";
import { AGENTS, type Agent, type Source } from "./args.ts";
import type { Deps } from "./deps.ts";

/**
 * Which coding agent `init` connects to the first workspace, asked of a person
 * at the terminal after NimbleBrain is up. Connecting one gives it
 * NimbleBrain's tools; it never changes what runs NimbleBrain's own agents
 * (`src/source.ts`). Each install registers under its own server name, so
 * connecting never takes over another install's registration.
 */

/** Each agent as a person reads it. */
export const AGENT_LABELS: Record<Agent, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
  none: "None",
};

/** The question, as `init` asks it. */
export const AGENT_QUESTION = "Connect a coding agent to NimbleBrain?";

/** One answer to the question, as this machine offers it. */
export interface AgentOption {
  agent: Agent;
  label: string;
  /** Whether the agent is on this machine, by what connecting it relies on. */
  detected: boolean;
  /** What was found, for the list; null when there is nothing to say. */
  note: string | null;
}

/** The model source each agent also is: Claude Code serves `claude`, Codex `codex`. */
const RUNS_SOURCE: Partial<Record<Agent, Source>> = { "claude-code": "claude", codex: "codex" };

/**
 * Whether each agent is on this machine, by what `connectAgent` relies on:
 * the `claude` and `codex` programs it runs, and the `~/.cursor` folder whose
 * `mcp.json` it writes (Cursor makes the folder when it first runs). Local and
 * fast: nothing is run, nothing leaves the machine.
 */
async function detected(deps: Deps, agent: Agent): Promise<boolean> {
  if (agent === "claude-code") return (await deps.which("claude")) !== undefined;
  if (agent === "codex") return (await deps.which("codex")) !== undefined;
  if (agent === "cursor") return deps.exists(join(deps.home, ".cursor"));
  return false;
}

/**
 * The agents in the order a person sees them: those on this machine first,
 * then the rest, then None. `source` is what runs NimbleBrain's agents, so the
 * agent that is also that source says so.
 */
export async function detectAgents(deps: Deps, source: Source | null): Promise<AgentOption[]> {
  const agents = AGENTS.filter((a) => a !== "none");
  const found = await Promise.all(agents.map((a) => detected(deps, a)));
  const options = agents.map((agent, i): AgentOption => {
    const here = found[i] ?? false;
    const runs = here && source !== null && RUNS_SOURCE[agent] === source;
    return {
      agent,
      label: AGENT_LABELS[agent],
      detected: here,
      note: here ? (runs ? "installed; also runs NimbleBrain's agents" : "installed") : null,
    };
  });
  return [
    ...options.filter((o) => o.detected),
    ...options.filter((o) => !o.detected),
    { agent: "none", label: AGENT_LABELS.none, detected: false, note: null },
  ];
}

/**
 * The default answer: the agent that is also the chosen source when it is
 * installed, else the first installed agent, else None.
 */
export function defaultAgent(options: AgentOption[], source: Source | null): Agent {
  const here = options.filter((o) => o.detected);
  const same = here.find((o) => source !== null && RUNS_SOURCE[o.agent] === source);
  return (same ?? here[0])?.agent ?? "none";
}

/** Short names a person may type, beside the number and the agent's own name. */
const ALIASES: Record<string, Agent> = {
  claude: "claude-code",
  claudecode: "claude-code",
  no: "none",
  n: "none",
};

/** The agent an answer names: its number, its name, its label, or an alias; case and spacing aside. */
export function agentAnswer(answer: string, options: AgentOption[]): Agent | undefined {
  const a = answer
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if (/^\d+$/.test(a)) return options[Number(a) - 1]?.agent;
  const named = options.find(
    (o) => o.agent === a || o.label.toLowerCase().replace(/\s+/g, "-") === a,
  );
  return named?.agent ?? ALIASES[a.replace(/-/g, "")];
}

/** The numbered list a person chooses from. */
export function agentLines(options: AgentOption[]): string[] {
  const width = Math.max(...options.map((o) => o.label.length)) + 3;
  return [
    AGENT_QUESTION,
    "It can then use NimbleBrain's tools. It does not change what runs NimbleBrain's own agents.",
    ...options.map((o, i) =>
      `  ${i + 1}) ${o.note ? `${o.label.padEnd(width)}(${o.note})` : o.label}`.trimEnd(),
    ),
  ];
}

/** How many times an answer that names no agent is asked again. */
const TRIES = 3;

/**
 * Asks a person which agent to connect: the list, then a number or a name,
 * Enter taking the default. An answer that names none is asked again, twice;
 * after that the default is taken, and said. Unlike the model source's
 * picker, it never refuses: it is asked once NimbleBrain is up, and
 * connecting an agent never fails `init`.
 */
export async function pickAgent(deps: Deps, options: AgentOption[], def: Agent): Promise<Agent> {
  const n = Math.max(1, options.findIndex((o) => o.agent === def) + 1);
  for (const line of agentLines(options)) deps.say(line);
  const names = options.map((o) => o.agent).join(", ");
  for (let tries = 0; tries < TRIES; tries++) {
    const answer = await deps.prompt(`Choose 1-${options.length}, or ${names} [${n}]: `);
    if (answer.trim() === "") return def;
    const agent = agentAnswer(answer, options);
    if (agent) return agent;
    deps.say(
      `"${answer.trim()}" is not one of them. Type a number from 1 to ${options.length}, or a name.`,
    );
  }
  deps.say(
    def === "none"
      ? "Taking the default: no coding agent."
      : `Taking the default: ${n}) ${AGENT_LABELS[def]}.`,
  );
  return def;
}
