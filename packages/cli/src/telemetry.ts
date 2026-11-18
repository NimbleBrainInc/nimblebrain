import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Deps } from "./deps.ts";
import { CliError } from "./result.ts";

/**
 * The write-only key of the "NimbleBrain Self-hosted" PostHog project, which
 * holds anonymous telemetry from installs we do not run, and nothing else. It
 * is public by design (it ships in this package), so that project must never
 * hold customer data. `NIMBLEBRAIN_TELEMETRY_KEY` overrides it: another
 * project's key, or empty for no destination, in which case the CLI asks no
 * one and sends nothing.
 */
export const TELEMETRY_KEY = "phc_qKmpYhdDtcFYZchu3KAKFFmYHG88nfUDPCFqxoAmbS7E";
const ENDPOINT = "https://us.i.posthog.com/batch/";

export const QUESTION =
  "Help improve NimbleBrain by sending anonymous usage data? No prompts, content, names or keys are sent.";

/**
 * The person's answer. The runtime owns it once it is running (the web UI and
 * this CLI set the same answer through it). Until then the CLI holds it, in
 * the install's `.env` as `NB_TELEMETRY_CONSENT`, which the runtime reads at
 * its first start.
 */
export type Consent = "on" | "off" | "undecided";

/** What `init`, `status` and `telemetry` report. `ask` and `set` appear only while undecided, for an agent to pass on. */
export interface TelemetryField {
  state: Consent;
  /** Present when no person can change the answer here. */
  locked?: "do_not_track" | "no_destination" | "operator";
  ask?: string;
  set?: string;
}

interface Event {
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, unknown>;
}

export const reportPath = (home: string) => join(home, "telemetry-report.jsonl");

export function telemetryKey(deps: Deps): string {
  return deps.env.NIMBLEBRAIN_TELEMETRY_KEY ?? TELEMETRY_KEY;
}

/** Whether no one can be asked: the person set `DO_NOT_TRACK`, or there is nowhere to send. */
export function lockedHere(deps: Deps): TelemetryField["locked"] {
  if (deps.env.DO_NOT_TRACK === "1" || deps.env.NB_TELEMETRY_DISABLED === "1")
    return "do_not_track";
  if (!telemetryKey(deps)) return "no_destination";
  return undefined;
}

export function field(state: Consent, locked?: TelemetryField["locked"]): TelemetryField {
  if (locked) return { state: state === "undecided" ? "off" : state, locked };
  if (state !== "undecided") return { state };
  return { state, ask: QUESTION, set: "npx nimblebrain telemetry on|off" };
}

/**
 * Events from one CLI run. While the answer is `on` they are sent at the end of
 * the run. While `undecided` they wait in the install report until someone
 * answers: sent with the first batch on `on`, deleted on `off`. Nothing leaves
 * the machine before a yes.
 */
export interface Recorder {
  id: string;
  record(event: string, properties?: Record<string, unknown>): void;
  /** Sends, keeps or drops what was recorded, by the answer. Never throws. */
  settle(home: string, consent: Consent): Promise<void>;
}

export function recorder(deps: Deps, version: string, id?: string): Recorder {
  const events: Event[] = [];
  const self: Recorder = {
    id: id ?? randomUUID(),
    record(event, properties = {}) {
      if (lockedHere(deps)) return;
      events.push({
        event,
        distinct_id: self.id,
        timestamp: new Date().toISOString(),
        properties: {
          cli_version: version,
          os: process.platform,
          arch: process.arch,
          node_version: process.version,
          ...properties,
        },
      });
    },
    async settle(home, consent) {
      try {
        if (consent === "off" || lockedHere(deps)) {
          await deps.remove(reportPath(home));
          return;
        }
        const waiting = await readReport(deps, home);
        const batch = [...waiting, ...events].map((e) => ({ ...e, distinct_id: self.id }));
        if (consent === "on") await send(deps, home, batch);
        else if (events.length > 0) await deps.writeText(reportPath(home), toLines(batch), 0o600);
      } catch {
        // Telemetry never fails a command.
      } finally {
        events.length = 0;
      }
    },
  };
  return self;
}

/** Sends the batch; a failed send keeps it as the report, so the next run tries again. */
async function send(deps: Deps, home: string, batch: Event[]): Promise<void> {
  if (batch.length === 0) return;
  const res = await deps.postJson(ENDPOINT, { api_key: telemetryKey(deps), batch });
  if (res && res.status < 300) await deps.remove(reportPath(home));
  else await deps.writeText(reportPath(home), toLines(batch), 0o600);
}

/** The anonymous id a waiting report already uses, so an install's events stay one install. */
export async function reportId(deps: Deps, home: string): Promise<string | undefined> {
  return (await readReport(deps, home))[0]?.distinct_id;
}

async function readReport(deps: Deps, home: string): Promise<Event[]> {
  const text = await deps.readText(reportPath(home));
  if (!text) return [];
  return text
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Event];
      } catch {
        return [];
      }
    });
}

const toLines = (events: Event[]) => `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;

/** Only a typed yes is a yes: Enter alone, or anything else, is no. */
export function parseAnswer(answer: string): "on" | "off" {
  return /^y/i.test(answer.trim()) ? "on" : "off";
}

/** The answer the CLI holds in `.env` (`NB_TELEMETRY_CONSENT`), before the runtime owns it. */
export function seededConsent(envText: string): Consent {
  const seed = envText.match(/^NB_TELEMETRY_CONSENT=(on|off)\s*$/m)?.[1];
  return seed === "on" || seed === "off" ? seed : "undecided";
}

/**
 * The install's answer now: the runtime's when it is answering, else the one
 * in `.env`. With the runtime's lock, if it reports one.
 */
export async function currentTelemetry(
  deps: Deps,
  home: string,
  url: string,
): Promise<TelemetryField> {
  const here = lockedHere(deps);
  const rt = await runtimeTelemetry(deps, url);
  const state = rt?.consent ?? seededConsent((await deps.readText(join(home, ".env"))) ?? "");
  const lock =
    here ?? (rt?.locked === "operator" || rt?.locked === "no_destination" ? rt.locked : undefined);
  return field(state, lock);
}

/**
 * Settles a report left waiting by an earlier run, once the answer is known:
 * a person may have answered in the web UI since. Does nothing when there is
 * no report, so ordinary commands pay nothing.
 */
export async function settleWaiting(deps: Deps, home: string, version: string): Promise<void> {
  try {
    const id = await reportId(deps, home);
    if (!id) return;
    const install = JSON.parse((await deps.readText(join(home, "install.json"))) ?? "{}") as {
      port?: unknown;
    };
    if (typeof install.port !== "number") return;
    const t = await currentTelemetry(deps, home, `http://127.0.0.1:${install.port}`);
    await recorder(deps, version, id).settle(home, t.locked ? "off" : t.state);
  } catch {
    // Telemetry never fails a command.
  }
}

/** The answer the CLI holds before the runtime runs, and the install's telemetry settings, as `.env` lines. */
export function envValues(deps: Deps, id: string, consent: Consent): Record<string, string> {
  const values: Record<string, string> = {
    NB_TELEMETRY_ID: id,
    NB_TELEMETRY_KEY: telemetryKey(deps),
  };
  if (consent !== "undecided") values.NB_TELEMETRY_CONSENT = consent;
  return values;
}

/** The runtime's view of the answer, through the same tool the web UI uses. */
export async function runtimeTelemetry(
  deps: Deps,
  url: string,
): Promise<{ consent: Consent; locked?: string } | undefined> {
  const res = await deps.postJson(`${url}/v1/tools/call`, {
    server: "nb",
    tool: "workspace_info",
    arguments: {},
  });
  const t = (
    res?.body as { structuredContent?: { telemetry?: { consent?: unknown; locked?: unknown } } }
  )?.structuredContent?.telemetry;
  if (t?.consent !== "on" && t?.consent !== "off" && t?.consent !== "undecided") return undefined;
  return { consent: t.consent, locked: typeof t.locked === "string" ? t.locked : undefined };
}

export async function setRuntimeTelemetry(
  deps: Deps,
  url: string,
  consent: "on" | "off",
): Promise<void> {
  const res = await deps.postJson(`${url}/v1/tools/call`, {
    server: "nb",
    tool: "set_telemetry",
    arguments: { consent },
  });
  const body = res?.body as { isError?: boolean; content?: Array<{ text?: string }> } | undefined;
  if (!res || res.status >= 300 || body?.isError) {
    throw new CliError(
      "TELEMETRY_LOCKED",
      body?.content?.[0]?.text ?? "NimbleBrain did not accept the answer.",
    );
  }
}
