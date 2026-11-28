/**
 * What an end-to-end scenario is, and what a run records for it.
 *
 * A scenario is one user journey through the public interfaces (HTTP, the
 * event stream, the MCP door). It declares what the target must offer
 * (`requires`), the groups it belongs to (`groups`), and its steps. Each step
 * that asserts something is a `check`: it runs, throws on a wrong result, and
 * returns its evidence. A scenario passes when it ran at least one check and
 * every check passed.
 */

import type { Caller, E2EClient } from "./client.ts";

/** What a target offers beyond a base URL and one signed-in person. */
export type Capability =
  /** The model follows the suite's directives (`directive-model.ts`). */
  | "scripted-model"
  /** A second person, an org member who is not in the first person's workspace. */
  | "second-identity"
  /** The first person is an org admin. */
  | "org-admin"
  /** The suite's fixture catalog is configured, and its artifact server's log is readable. */
  | "fixture-catalog";

/**
 * A named subset of the scenarios. `smoke` is the set run against a deployment
 * after it deploys: fast, safe, and covering the critical journeys.
 */
export type Group = "smoke";

export interface ScenarioContext {
  client: E2EClient;
  /** The org admin (or the one person of a deployment target). */
  alice: Caller;
  /** An org member outside `ws`; absent unless the target offers `second-identity`. */
  bob?: Caller;
  /** Alice's workspace the scenarios run in. Against a deployment, one the suite created. */
  ws: string;
  /** Bob's workspace, which Alice is not in, when there is a Bob. */
  bobWs?: string;
  /** The fixture catalog's artifact server, under `fixture-catalog`. */
  catalogBase?: string;
  /** One assertion: `fn` throws on a wrong result; what it returns is kept as the evidence. */
  check(label: string, fn: () => unknown | Promise<unknown>): Promise<void>;
  /** A value for later steps, kept with the scenario's evidence. */
  note(key: string, value: unknown): void;
  /**
   * A workspace the scenario created: the suite deletes and purges it when the
   * scenario ends, failed or not. Register it as soon as it exists.
   */
  disposable(ws: string): void;
}

export interface Scenario {
  /** `<capability>.<journey>`, e.g. `chat.turn`, `files.download`. */
  id: string;
  title: string;
  groups?: Group[];
  requires?: Capability[];
  run(ctx: ScenarioContext): Promise<void>;
}

export interface CheckRecord {
  label: string;
  ok: boolean;
  evidence: unknown;
  ms: number;
}

/** A failed expectation, with what was seen. */
export class Mismatch extends Error {
  constructor(
    message: string,
    readonly seen?: unknown,
  ) {
    super(message);
  }
}

export function expect(cond: unknown, message: string, seen?: unknown): asserts cond {
  if (!cond) throw new Mismatch(message, seen);
}

export function expectEq(actual: unknown, wanted: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Mismatch(`${message}: wanted ${JSON.stringify(wanted)}`, actual);
  }
}

/** Poll `probe` until it returns a value `done` accepts; that value. */
export async function until<T>(
  probe: () => Promise<T>,
  done: (v: T) => boolean,
  what: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await probe();
  while (!done(last)) {
    if (Date.now() > deadline) throw new Mismatch(`timed out waiting for ${what}`, last);
    await Bun.sleep(150);
    last = await probe();
  }
  return last;
}

/** Keep evidence small enough to read in a report. */
export function compact(value: unknown, max = 1500): unknown {
  if (value === undefined) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return null;
  if (text.length <= max) return typeof value === "string" ? value : JSON.parse(text);
  return `${text.slice(0, max)}… (${text.length} chars)`;
}
