/**
 * Self-tests for `scripts/verify-static.ts`.
 *
 * `runSteps` and `report` are exercised with fake steps so the no-short-circuit
 * property is checked without running real checks. The real execution path
 * (`runBunStep` and the `main` exit code) is exercised against a temporary
 * fixture package.json whose scripts are trivial, so it runs fast and does not
 * depend on the repo's own checks.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { report, runBunStep, runSteps, STEPS } from "../../../scripts/verify-static.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const RUNNER = join(REPO_ROOT, "scripts/verify-static.ts");

/** Writes a fixture package.json where every declared step exits 0, except `failing`. */
function makeFixture(failing: readonly string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "verify-static-"));
  const scripts: Record<string, string> = {};
  for (const step of STEPS) {
    scripts[step] = failing.includes(step) ? "echo broke-here && exit 1" : "echo ok-here";
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", scripts }));
  return dir;
}

describe("verify-static — runSteps", () => {
  test("runs every step even after one fails", async () => {
    const ran: string[] = [];
    const results = await runSteps(["a", "b", "c"], async (step) => {
      ran.push(step);
      return { exitCode: step === "a" || step === "c" ? 1 : 0, output: `out ${step}` };
    });
    expect(ran).toEqual(["a", "b", "c"]);
    expect(results.map((r) => r.exitCode)).toEqual([1, 0, 1]);
  });

  test("report names every failed step in the summary", async () => {
    const results = await runSteps(["lint", "check", "check:codegen"], async (step) => ({
      exitCode: step === "lint" || step === "check:codegen" ? 2 : 0,
      output: "",
    }));
    expect(report(results)).toContain("2 of 3 steps failed: lint, check:codegen");
  });
});

describe("verify-static — step list coverage", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  test("every STEPS entry is a script declared in package.json", () => {
    const missing = STEPS.filter((step) => !(step in pkg.scripts));
    expect(missing).toEqual([]);
  });

  test("every check:* script in package.json is in STEPS, and no duplicates", () => {
    const declared = Object.keys(pkg.scripts)
      .filter((name) => name.startsWith("check:"))
      .sort();
    const listed = STEPS.filter((step) => step.startsWith("check:")).sort();
    expect(listed).toEqual(declared);
    expect(new Set(STEPS).size).toBe(STEPS.length);
  });

  test("the chain's leading steps are format:check, lint, check, in that order", () => {
    expect(STEPS.slice(0, 3)).toEqual(["format:check", "lint", "check"]);
  });
});

describe("verify-static — real execution path", () => {
  const fixtures: string[] = [];

  afterAll(() => {
    for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
  });

  test("runBunStep captures a step's stdout and exit code", async () => {
    const dir = makeFixture(["lint"]);
    fixtures.push(dir);
    const ok = await runBunStep("check:theme", dir);
    expect(ok.exitCode).toBe(0);
    expect(ok.output).toContain("ok-here");
    const bad = await runBunStep("lint", dir);
    expect(bad.exitCode).toBe(1);
    expect(bad.output).toContain("broke-here");
  }, 60_000);

  test("runner exits 0 and reports all steps passed when every step passes", async () => {
    const dir = makeFixture();
    fixtures.push(dir);
    const proc = Bun.spawn([process.execPath, RUNNER], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`All ${STEPS.length} steps passed.`);
  }, 120_000);

  test("runner runs every step, reports both broken checks, and exits 1", async () => {
    const dir = makeFixture(["lint", "check:theme"]);
    fixtures.push(dir);
    const proc = Bun.spawn([process.execPath, RUNNER], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(exitCode).toBe(1);
    expect(stdout.match(/^=== /gm)?.length).toBe(STEPS.length);
    expect(stdout).toContain(`2 of ${STEPS.length} steps failed: lint, check:theme`);
  }, 120_000);
});
