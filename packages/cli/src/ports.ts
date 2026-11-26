import { join } from "node:path";
import { type Deps, defaultHome, installHome } from "./deps.ts";
import { CliError } from "./result.ts";

/**
 * When the default port a new install or a new agent worker would take is in
 * use, the next port it tries is this far on (27246, 27346, 27446, …), so a
 * second install's ports read as a family beside the first's.
 */
export const PORT_STEP = 100;

/** How many ports are tried, the default included, before giving up with `PORT_IN_USE`. */
export const PORT_TRIES = 10;

/** What holds a port: another install's web UI or agent worker this CLI can see, or something else. */
export type HeldBy = "nimblebrain" | "agent_worker" | "other";

/** A default port that was taken, and the one used instead. */
export interface PortMove {
  from: number;
  to: number;
  held_by: HeldBy;
  /** The other install's home, when `held_by` names one this CLI can see; else null. */
  home: string | null;
}

/** Another install on this machine: its home, and the ports its record and `.env` name. */
interface OtherInstall {
  home: string;
  web?: number;
  worker?: number;
}

/** The homes of the other installs this CLI can see from `home`: the default one and `NIMBLEBRAIN_HOME`'s. */
export function otherHomes(deps: Deps, home: string): string[] {
  return [...new Set([defaultHome(deps), installHome(deps)])].filter((h) => h !== home);
}

/**
 * The other installs this CLI can see from `home`: the default home's and
 * `NIMBLEBRAIN_HOME`'s, when either is not `home`. Read only for the ports
 * they recorded, leniently (an older CLI's record has no `phase`), and never
 * acted on.
 */
async function otherInstalls(deps: Deps, home: string): Promise<OtherInstall[]> {
  const found: OtherInstall[] = [];
  for (const h of otherHomes(deps, home)) {
    const web = numberAt(await deps.readText(join(h, "install.json")), "port");
    if (web === undefined) continue;
    const env = (await deps.readText(join(h, ".env"))) ?? "";
    const dialed = Number(env.match(/^NB_AGENT_RUNTIME_URL=https?:\/\/[^/]+:(\d+)\//m)?.[1]);
    const worker =
      numberAt(await deps.readText(join(h, "agent-worker.json")), "port") ??
      (Number.isInteger(dialed) && dialed > 0 ? dialed : undefined);
    found.push({ home: h, web, worker });
  }
  return found;
}

function numberAt(text: string | undefined, key: string): number | undefined {
  if (text === undefined) return undefined;
  try {
    const v = (JSON.parse(text) as Record<string, unknown> | null)?.[key];
    return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/** What holds `port`: an install this CLI can see by its record, else a NimbleBrain web UI answering there. */
async function holder(
  deps: Deps,
  port: number,
  others: OtherInstall[],
  kind: "web" | "worker",
): Promise<{ held_by: HeldBy; home: string | null }> {
  const web = others.find((o) => o.web === port);
  if (web) return { held_by: "nimblebrain", home: web.home };
  const worker = others.find((o) => o.worker === port);
  if (worker) return { held_by: "agent_worker", home: worker.home };
  // The web UI names itself in its page title; a worker answers nothing that names it.
  if (kind === "web") {
    const page = await deps.getText(`http://127.0.0.1:${port}/`, 1_500);
    if (page?.status === 200 && /<title>\s*NimbleBrain/i.test(page.body))
      return { held_by: "nimblebrain", home: null };
  }
  return { held_by: "other", home: null };
}

/**
 * The port to use when `from`, a default, may be taken: `from` when it is
 * free and no other install this CLI can see recorded it (a stopped install
 * still owns its port), else the first such port `PORT_STEP` on, within
 * `PORT_TRIES`. Undefined when `from` is usable. None usable is
 * `PORT_IN_USE`, whose fix names `--port`.
 */
export async function movePort(
  deps: Deps,
  home: string,
  from: number,
  kind: "web" | "worker",
): Promise<PortMove | undefined> {
  const others = await otherInstalls(deps, home);
  const taken = new Set(others.flatMap((o) => [o.web, o.worker]));
  if (!taken.has(from) && (await deps.portFree(from))) return undefined;
  for (let i = 1; i < PORT_TRIES; i++) {
    const to = from + i * PORT_STEP;
    if (to > 65535) break;
    if (taken.has(to) || !(await deps.portFree(to))) continue;
    return { from, to, ...(await holder(deps, from, others, kind)) };
  }
  const last = Math.min(from + (PORT_TRIES - 1) * PORT_STEP, 65535);
  throw new CliError(
    "PORT_IN_USE",
    `Port ${from} is in use, and so is every port tried after it (every ${PORT_STEP} up to ${last}).`,
  );
}

/** A path under the person's home folder as they write it, `~/…`. */
function tilde(deps: Deps, path: string): string {
  return path.startsWith(`${deps.home}/`) ? `~${path.slice(deps.home.length)}` : path;
}

/** What holds the port, as a person reads it. */
export function heldByText(deps: Deps, move: PortMove): string {
  if (move.held_by === "nimblebrain")
    return move.home ? `your NimbleBrain at ${tilde(deps, move.home)}` : "another NimbleBrain";
  if (move.held_by === "agent_worker" && move.home)
    return `the agent worker of your NimbleBrain at ${tilde(deps, move.home)}`;
  return "another program";
}

/** The line that says a default port moved: `Port 27246 is in use (by …), so this install uses 27346.` */
export function movedLine(deps: Deps, move: PortMove, what: string): string {
  return `Port ${move.from} is in use (by ${heldByText(deps, move)}), so ${what} uses ${move.to}.`;
}
