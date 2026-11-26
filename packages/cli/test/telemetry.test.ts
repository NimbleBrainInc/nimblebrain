import { describe, expect, test } from "bun:test";
import { keyVars, providers } from "../src/compose.ts";
import { run } from "../src/main.ts";
import { QUESTION } from "../src/telemetry.ts";
import { fail, type Machine, machine, REPO_COMPOSE, record } from "./fake.ts";

const HOME = "/home/dana/.nimblebrain-local";
const ENV = `${HOME}/.env`;
const REPORT = `${HOME}/telemetry-report.jsonl`;
const ID = `${HOME}/telemetry-id`;
/**
 * A runtime that asks before sending (the repo's Compose file passes the
 * answer through), and a destination to send to: without a key no one is asked.
 */
const env = { NIMBLEBRAIN_TAG: "v0.74.0", NIMBLEBRAIN_TELEMETRY_KEY: "phc_test" };

async function json(argv: string[], m: Machine) {
  const { stdout, code } = await run([...argv, "--json"], m.deps);
  return { body: JSON.parse(stdout), code };
}

const sent = (m: Machine) =>
  m.posts
    .filter((p) => p.url.includes("posthog.com"))
    .flatMap(
      (p) =>
        (
          p.body as {
            batch: Array<{
              event: string;
              distinct_id: string;
              properties: Record<string, unknown>;
            }>;
          }
        ).batch,
    );

const reportEvents = (m: Machine) =>
  (m.files.get(REPORT)?.text ?? "")
    .split("\n")
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { event: string }).event);

describe("telemetry consent at init", () => {
  test("a rerun that finishes an unfinished install reuses the answer given, never asking again", async () => {
    // No to telemetry, yes to the start, a hosted model, the default provider, a key.
    const m = machine({ env, interactive: true, answers: ["n", "", "", "", "sk-typed"] });
    m.deps.getJson = async () => undefined;
    const first = await run([], m.deps);
    expect(first.stdout).toContain("did not report healthy");
    expect(m.asked[0]).toStartWith(QUESTION);
    expect(m.files.get(ENV)?.text).toContain("NB_TELEMETRY_CONSENT=off");
    // A person at the terminal again, who would be asked if the answer were not kept.
    const again = machine({ env, interactive: true });
    for (const [path, file] of m.files) again.files.set(path, file);
    const { stdout } = await run(["--no-open"], again.deps);
    expect(stdout).toContain("running at http://127.0.0.1:27246");
    expect(stdout).toContain("telemetry: off");
    expect(again.asked.some((q) => q.startsWith(QUESTION))).toBe(false);
  });

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
    const { stdout } = await run(["status"], m.deps);
    expect(stdout).toContain("telemetry: undecided (answer with npx nimblebrain telemetry on|off)");
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

  test("init_completed names the provider and the connected agent, never the key", async () => {
    const files = {
      [`${HOME}/install.json`]: record({ phase: "starting", version: "0.74.0" }),
      [ENV]: "ANTHROPIC_API_KEY=sk-secret\n",
    };
    const m = machine({ env, files });
    await json(["--yes", "--telemetry", "on", "--agent", "claude-code"], m);
    const done = sent(m).find((e) => e.event === "cli.init_completed");
    expect(done?.properties).toMatchObject({
      model_key: "set",
      provider: "anthropic",
      model_source: "api",
      agent: "claude-code",
    });
    expect(JSON.stringify(sent(m))).not.toContain("sk-secret");
  });

  test("init_completed with no key and no agent sends null for both", async () => {
    const m = machine({ env });
    await json(["--yes", "--telemetry", "on", "--agent", "none"], m);
    const done = sent(m).find((e) => e.event === "cli.init_completed");
    expect(done?.properties).toMatchObject({
      model_key: "missing",
      provider: null,
      model_source: null,
      agent: null,
    });
  });

  test("--telemetry off sends nothing and keeps nothing", async () => {
    const m = machine({ env });
    const { body } = await json(["--yes", "--telemetry", "off"], m);
    expect(body.telemetry).toEqual({ state: "off" });
    expect(sent(m)).toHaveLength(0);
    expect(m.files.has(REPORT)).toBe(false);
  });

  test("a person is asked first; Enter is yes, and only an answer starting with n is no", async () => {
    for (const [answer, state] of [
      ["", "on"],
      ["y", "on"],
      ["n", "off"],
      ["No", "off"],
    ] as const) {
      // Consent, then start. The key prompt gets no key, so init stops there with the answer kept.
      const m = machine({ env, interactive: true, answers: [answer, "y"] });
      await run([], m.deps);
      expect(m.files.get(ENV)?.text).toContain(`NB_TELEMETRY_CONSENT=${state}`);
      expect(m.said.join("\n")).toContain(
        `npx nimblebrain telemetry ${state === "on" ? "off" : "on"}`,
      );
    }
  });

  test("the telemetry question comes before the checks and the start", async () => {
    const m = machine({ env, interactive: true, answers: ["", "y"] });
    await run([], m.deps);
    expect(m.asked[0]).toStartWith("Help improve");
    expect(m.asked[0]).toEndWith("[Y/n] ");
    expect(m.asked[1]).toStartWith("Start NimbleBrain");
  });

  test("a failed check after a yes is sent at once", async () => {
    const m = machine({
      env,
      interactive: true,
      answers: [""],
      exec: { "docker --version": { ...fail(), missing: true } },
    });
    await run([], m.deps);
    expect(sent(m).map((e) => e.event)).toEqual(["cli.init_started", "cli.doctor_failed"]);
    expect(m.files.has(REPORT)).toBe(false);
  });

  test("declining the start after a yes reports the cancel; after a no, nothing is kept", async () => {
    const yes = machine({ env, interactive: true, answers: ["", "n"] });
    await run([], yes.deps);
    expect(sent(yes).map((e) => e.event)).toEqual(["cli.init_started", "cli.init_failed"]);
    const no = machine({ env, interactive: true, answers: ["n", "n"] });
    await run([], no.deps);
    expect(sent(no)).toHaveLength(0);
    expect(no.files.has(REPORT)).toBe(false);
  });

  test("--yes never answers the telemetry question", async () => {
    const m = machine({ env, interactive: true });
    await run(["--yes"], m.deps);
    expect(m.asked.some((q) => q.startsWith("Help improve"))).toBe(false);
    expect(sent(m)).toHaveLength(0);
    expect(m.files.get(ENV)?.text).not.toContain("NB_TELEMETRY_CONSENT");
  });

  test("with no destination no one is asked and nothing is written", async () => {
    const m = machine({ env: { NIMBLEBRAIN_TAG: "v0.74.0" } });
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

  test("failed inits on one home count as one install, and .env gets that id", async () => {
    const dockerMissing = { "docker --version": { ...fail(), missing: true } };
    const m = machine({ env, exec: dockerMissing });
    await json(["--yes", "--telemetry", "on"], m);
    await json(["--yes", "--telemetry", "on"], m);
    const ids = new Set(sent(m).map((e) => e.distinct_id));
    expect(sent(m).map((e) => e.event)).toEqual([
      "cli.init_started",
      "cli.doctor_failed",
      "cli.init_started",
      "cli.doctor_failed",
    ]);
    expect(ids.size).toBe(1);
    const [id] = ids;
    expect(m.files.get(ID)).toEqual({ text: `${id}\n`, mode: 0o600 });

    // The same home, now with Docker: the install takes the id the failures used.
    const files = Object.fromEntries([...m.files].map(([p, f]) => [p, f.text]));
    const fixed = machine({ env, files });
    await json(["--yes", "--telemetry", "on"], fixed);
    expect(fixed.files.get(ENV)?.text).toContain(`NB_TELEMETRY_ID=${id}\n`);
    expect(sent(fixed).every((e) => e.distinct_id === id)).toBe(true);
    await json(["uninstall", "--yes"], fixed);
    expect(fixed.files.has(ID)).toBe(false);
  });

  test("another home is another install, with its own id", async () => {
    const m = machine({ env, exec: { "docker --version": { ...fail(), missing: true } } });
    await json(["--yes", "--telemetry", "on"], m);
    await json(["--yes", "--telemetry", "on", "--home", "/home/dana/other"], m);
    const [a, b] = sent(m)
      .filter((e) => e.event === "cli.init_started")
      .map((e) => e.distinct_id);
    expect(a).not.toBe(b);
    expect(m.files.get("/home/dana/other/telemetry-id")?.text).toBe(`${b}\n`);
  });

  test("locked off, no id is written anywhere", async () => {
    for (const lock of [{ DO_NOT_TRACK: "1" }]) {
      const failing = machine({
        env: { ...env, ...lock },
        exec: { "docker --version": { ...fail(), missing: true } },
      });
      await json(["--yes", "--telemetry", "on"], failing);
      expect(failing.files.has(ID)).toBe(false);
      const m = machine({ env: { ...env, ...lock } });
      await json(["--yes", "--telemetry", "on"], m);
      expect(m.files.has(ID)).toBe(false);
      expect(m.files.get(ENV)?.text).not.toContain("NB_TELEMETRY_ID");
    }
  });

  test("no id is written into a home holding files this CLI did not write", async () => {
    const m = machine({ env, files: { [`${HOME}/docker-compose.yml`]: "services: {}\n" } });
    const { body } = await json(["--yes", "--telemetry", "on"], m);
    expect(body.error).toBe("NOT_OURS");
    expect(m.files.has(ID)).toBe(false);
  });

  test("a runtime that does not ask before sending gets no key, since it would send without asking", async () => {
    const older = REPO_COMPOSE.split("\n")
      .filter((l) => !l.includes("NB_TELEMETRY"))
      .join("\n");
    const m = machine({ env, compose: { status: 200, body: older } });
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
    expect(keyVars(REPO_COMPOSE)).not.toContain("POSTHOG_API_KEY");
    expect(Object.keys(providers(REPO_COMPOSE))).not.toContain("posthog");
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
