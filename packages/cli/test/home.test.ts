import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { BARE_CLI, invocation } from "../src/deps.ts";
import { interrupted, run } from "../src/main.ts";
import { type Machine, machine } from "./fake.ts";

/**
 * Every command the CLI prints runs against the install this run acted on. A
 * home with another folder name is another install, so a bare command would
 * act on the default one.
 */

const TRY = "/home/dana/nb-try";
const CLI = `npx nimblebrain --home ${TRY}`;
/** A pinned runtime, and a destination, so the telemetry question is asked. */
const env = { NIMBLEBRAIN_TAG: "v0.74.0", NIMBLEBRAIN_TELEMETRY_KEY: "phc_test" };

async function json(argv: string[], m: Machine) {
  const { stdout, code } = await run([...argv, "--json"], m.deps);
  return { body: JSON.parse(stdout), code };
}

describe("the install's own commands", () => {
  test("test_init_otherHome_printsCommandsWithHome", async () => {
    // Telemetry yes, start, hosted model, provider, key, no agent.
    const m = machine({ env, interactive: true, answers: ["", "", "", "", "sk-typed", "none"] });
    // Relative to the working directory (/home/dana/src), as a person types it; printed absolute.
    const { stdout, code } = await run(["init", "--home", "../nb-try"], m.deps);
    expect(code).toBe(0);
    expect(m.said.join("\n")).toContain(`Turn it off any time: ${CLI} telemetry off`);
    expect(stdout).toContain(`Stop it with ${CLI} down.`);
    expect(stdout).not.toMatch(/npx nimblebrain (?!--home)/);
  });

  test("test_init_defaultHome_printsBareCommands", async () => {
    for (const home of [[], ["--home", "/home/dana/.nimblebrain-local/"]]) {
      const m = machine({ env, interactive: true, answers: ["", "", "", "", "sk-typed", "none"] });
      const { stdout } = await run(["init", ...home], m.deps);
      expect(m.said.join("\n")).toContain("Turn it off any time: npx nimblebrain telemetry off");
      expect(stdout).toContain("Stop it with npx nimblebrain down.");
      expect(stdout).not.toContain("--home");
    }
  });

  test("test_unattendedInit_otherHome_nextStepAndTelemetrySetCarryHome", async () => {
    const m = machine({ env });
    const { body } = await json(["--yes", "--home", TRY], m);
    expect(body).toMatchObject({ ok: true, model_key: "missing" });
    expect(body.telemetry.set).toBe(`${CLI} telemetry on|off`);
    const plain = await run(["--yes", "--home", TRY], machine({ env }).deps);
    expect(plain.stdout).toContain(`Run ${CLI} use in your own terminal`);
    expect(body.model_source.set).toBe(`${CLI} use claude|codex|api|local`);
    const status = await json(["status", "--home", TRY], m);
    expect(status.body.telemetry.set).toBe(`${CLI} telemetry on|off`);
    const statusText = await run(["status", "--home", TRY], m.deps);
    expect(statusText.stdout).toContain(`agents run on: nothing yet (choose with ${CLI} use)`);
    expect(statusText.stdout).toContain(`answer with ${CLI} telemetry on|off`);
  });

  test("test_failure_otherHome_fixNamesHome", async () => {
    const { body } = await json(["logs", "--home", TRY], machine({ env }));
    expect(body).toMatchObject({
      error: "NOT_INSTALLED",
      fix: `Run \`${CLI}\` to install it.`,
    });
  });

  test("test_failure_defaultHome_fixIsUnchanged", async () => {
    const { body } = await json(["logs"], machine({ env }));
    expect(body.fix).toBe("Run `npx nimblebrain` to install it.");
  });

  test("test_interrupted_otherHome_fixNamesHome", () => {
    const out = interrupted(["up", "--home", TRY, "--json"], 130, machine().deps);
    expect(JSON.parse(out.stdout).fix).toBe(
      `Run \`${CLI} status\` to see what is in place, then run the same command again.`,
    );
  });
});

describe("invocation", () => {
  const deps = (e: NodeJS.ProcessEnv = {}) => ({ ...machine().deps, env: e });

  test("test_invocation_envHome_carriesHome", () => {
    // The printed command may run in a shell without the variable.
    const d = deps({ NIMBLEBRAIN_HOME: "/srv/nb" });
    expect(invocation(d, "/srv/nb")).toBe("npx nimblebrain --home /srv/nb");
  });

  test("test_invocation_defaultHomeWithEnvElsewhere_carriesHome", () => {
    // A bare command in this shell would land on NIMBLEBRAIN_HOME, not the default.
    const d = deps({ NIMBLEBRAIN_HOME: "/srv/nb" });
    expect(invocation(d, "/home/dana/.nimblebrain-local")).toBe(
      "npx nimblebrain --home /home/dana/.nimblebrain-local",
    );
  });

  test("test_invocation_defaultHome_isBare", () => {
    expect(invocation(deps(), "/home/dana/.nimblebrain-local")).toBe(BARE_CLI);
    const d = deps({ NIMBLEBRAIN_HOME: "/home/dana/.nimblebrain-local" });
    expect(invocation(d, "/home/dana/.nimblebrain-local")).toBe(BARE_CLI);
  });

  test("test_invocation_homeWithShellCharacters_roundTripsThroughShell", () => {
    for (const home of ["/home/dana/my nb", "/home/dana/dana's nb", "/home/dana/$&nb`x`"]) {
      const cli = invocation(deps(), home);
      expect(cli.startsWith("npx nimblebrain --home ")).toBe(true);
      const quoted = cli.slice("npx nimblebrain --home ".length);
      const sh = spawnSync("sh", ["-c", `printf %s ${quoted}`], { encoding: "utf8" });
      expect(sh.stdout).toBe(home);
    }
  });

  test("test_failure_homeWithDollar_fixKeepsHomeLiteral", async () => {
    const home = "/home/dana/$&nb";
    const { body } = await json(["logs", "--home", home], machine({ env }));
    expect(body.fix).toBe("Run `npx nimblebrain --home '/home/dana/$&nb'` to install it.");
  });
});
