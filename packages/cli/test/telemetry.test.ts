import { describe, expect, test } from "bun:test";
import { run } from "../src/main.ts";
import { QUESTION } from "../src/telemetry.ts";
import { fail, type Machine, machine } from "./fake.ts";

const HOME = "/home/dana/.nimblebrain-local";
const ENV = `${HOME}/.env`;
const REPORT = `${HOME}/telemetry-report.jsonl`;
/**
 * The CLI's own release pinned (a dev build's version is `0.0.0-dev`), and a
 * destination to send to: without a key no one is asked.
 */
const env = { NIMBLEBRAIN_TAG: "v0.0.0-dev", NIMBLEBRAIN_TELEMETRY_KEY: "phc_test" };

async function json(argv: string[], m: Machine) {
  const { stdout, code } = await run([...argv, "--json"], m.deps);
  return { body: JSON.parse(stdout), code };
}

const sent = (m: Machine) =>
  m.posts
    .filter((p) => p.url.includes("posthog.com"))
    .flatMap((p) => (p.body as { batch: Array<{ event: string; distinct_id: string }> }).batch);

const reportEvents = (m: Machine) =>
  (m.files.get(REPORT)?.text ?? "")
    .split("\n")
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { event: string }).event);

describe("telemetry consent at init", () => {
  test("an unattended run sends nothing, keeps its events waiting, and hands the agent the question", async () => {
    const m = machine({ env });
    const { body } = await json(["--yes", "--agent", "none"], m);
    expect(body.telemetry).toEqual({
      state: "undecided",
      ask: QUESTION,
      set: "npx nimblebrain telemetry on|off",
    });
    expect(sent(m)).toHaveLength(0);
    expect(reportEvents(m)).toEqual(["cli.init_started", "cli.init_completed"]);
    expect(m.files.get(REPORT)?.mode).toBe(0o600);
    const dotenv = m.files.get(ENV)?.text ?? "";
    expect(dotenv).toMatch(/^NB_TELEMETRY_ID=[0-9a-f-]{36}$/m);
    expect(dotenv).toContain("NB_TELEMETRY_KEY=phc_test");
    expect(dotenv).not.toContain("NB_TELEMETRY_CONSENT");
  });

  test("--telemetry on records the answer for the runtime and sends this run's events", async () => {
    const m = machine({ env });
    const { body } = await json(["--yes", "--telemetry", "on"], m);
    expect(body.telemetry).toEqual({ state: "on" });
    expect(m.files.get(ENV)?.text).toContain("NB_TELEMETRY_CONSENT=on");
    expect(sent(m).map((e) => e.event)).toEqual(["cli.init_started", "cli.init_completed"]);
    const id = m.files.get(ENV)?.text.match(/^NB_TELEMETRY_ID=(.+)$/m)?.[1];
    expect(sent(m).every((e) => e.distinct_id === id)).toBe(true);
    expect(m.files.has(REPORT)).toBe(false);
  });

  test("--telemetry off sends nothing and keeps nothing", async () => {
    const m = machine({ env });
    const { body } = await json(["--yes", "--telemetry", "off"], m);
    expect(body.telemetry).toEqual({ state: "off" });
    expect(sent(m)).toHaveLength(0);
    expect(m.files.has(REPORT)).toBe(false);
  });

  test("a person at the terminal is asked first; only a typed yes is yes", async () => {
    for (const [answer, state] of [
      ["y", "on"],
      ["", "off"],
      ["no", "off"],
    ] as const) {
      // Consent, then start. The key prompt gets no key, so init stops there with the answer kept.
      const m = machine({ env, interactive: true, answers: [answer, "y"] });
      await run([], m.deps);
      expect(m.files.get(ENV)?.text).toContain(`NB_TELEMETRY_CONSENT=${state}`);
    }
  });

  test("with no destination no one is asked and nothing is written", async () => {
    const m = machine({ env: { NIMBLEBRAIN_TAG: "v0.70.0" } });
    const { body } = await json(["--yes"], m);
    expect(body.telemetry).toEqual({ state: "off", locked: "no_destination" });
    expect(m.files.has(REPORT)).toBe(false);
    expect(m.posts.filter((p) => p.url.includes("posthog.com"))).toHaveLength(0);
  });

  test("DO_NOT_TRACK wins over --telemetry on", async () => {
    const m = machine({ env: { ...env, DO_NOT_TRACK: "1" } });
    const { body } = await json(["--yes", "--telemetry", "on"], m);
    expect(body.telemetry).toEqual({ state: "off", locked: "do_not_track" });
    expect(sent(m)).toHaveLength(0);
    expect(m.files.has(REPORT)).toBe(false);
  });

  test("a failed check is kept, not sent, and the failure still asks", async () => {
    const m = machine({ env, exec: { "docker --version": { ...fail(), missing: true } } });
    const { body } = await json(["--yes"], m);
    expect(body.error).toBe("DOCKER_MISSING");
    expect(body.telemetry.state).toBe("undecided");
    expect(sent(m)).toHaveLength(0);
    expect(reportEvents(m)).toEqual(["cli.init_started", "cli.doctor_failed"]);
  });

  test("a runtime that is not this CLI's own release gets no key, since it may send without asking", async () => {
    const m = machine({ env: { ...env, NIMBLEBRAIN_TAG: "v0.70.0" } });
    await json(["--yes", "--telemetry", "on"], m);
    expect(m.files.get(ENV)?.text).toMatch(/^NB_TELEMETRY_KEY=$/m);
  });

  test("a development build has no destination of its own", async () => {
    const { NIMBLEBRAIN_TELEMETRY_KEY: _, ...noOverride } = env;
    const m = machine({ env: noOverride });
    // The fake defaults the override to empty; drop it to see the build's own key.
    delete m.deps.env.NIMBLEBRAIN_TELEMETRY_KEY;
    const { body } = await json(["--yes"], m);
    expect(body.telemetry).toEqual({ state: "off", locked: "no_destination" });
  });

  test("the telemetry key is not offered as a model provider", async () => {
    const { PROVIDERS, KEY_VARS } = await import("../src/compose.ts");
    expect(KEY_VARS).not.toContain("POSTHOG_API_KEY");
    expect(Object.keys(PROVIDERS)).not.toContain("posthog");
  });
});

describe("telemetry command", () => {
  async function installed(): Promise<Machine> {
    const m = machine({ env });
    await json(["--yes"], m);
    return m;
  }

  test("on: the runtime records it, and the waiting report goes out with the first batch", async () => {
    const m = await installed();
    const { body } = await json(["telemetry", "on"], m);
    expect(body).toEqual({ ok: true, telemetry: { state: "on" } });
    expect(m.runtimeConsent).toBe("on");
    expect(m.files.get(ENV)?.text).toContain("NB_TELEMETRY_CONSENT=on");
    expect(sent(m).map((e) => e.event)).toEqual(["cli.init_started", "cli.init_completed"]);
    expect(m.files.has(REPORT)).toBe(false);
  });

  test("off: the runtime records it, and the waiting report is deleted unsent", async () => {
    const m = await installed();
    const { body } = await json(["telemetry", "off"], m);
    expect(body.telemetry).toEqual({ state: "off" });
    expect(m.runtimeConsent).toBe("off");
    expect(sent(m)).toHaveLength(0);
    expect(m.files.has(REPORT)).toBe(false);
  });

  test("status reports the runtime's answer", async () => {
    const m = await installed();
    const { body } = await json(["telemetry"], m);
    expect(body.telemetry.state).toBe("undecided");
  });

  test("changing it needs the runtime up", async () => {
    const m = await installed();
    await json(["down"], m);
    const { body } = await json(["telemetry", "on"], m);
    expect(body.error).toBe("NOT_RUNNING");
  });

  test("an answer given in the web UI sends the waiting report at the next command", async () => {
    const m = await installed();
    m.runtimeConsent = "on";
    await json(["status"], m);
    expect(sent(m).map((e) => e.event)).toEqual(["cli.init_started", "cli.init_completed"]);
    expect(m.files.has(REPORT)).toBe(false);
  });

  test("telemetry takes only on, off or status", async () => {
    const m = await installed();
    const { body, code } = await json(["telemetry", "maybe"], m);
    expect(code).toBe(2);
    expect(body.error).toBe("USAGE");
  });
});
