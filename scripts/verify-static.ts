#!/usr/bin/env bun
/**
 * Runs every static check and reports every failure, not just the first.
 *
 * `verify:static` used to be a `&&` chain, which stopped at the first broken
 * check and hid the rest. This runner keeps the step list as a declared array,
 * runs each step as `bun run <step>` (the `check:*` entries in package.json
 * stay the source of truth), buffers each step's output so it prints grouped
 * rather than interleaved, and exits 1 if any step failed.
 *
 * To add a check: add the `check:*` script to package.json, then add its name
 * to `STEPS` below.
 */

export const STEPS = [
  "format:check",
  "lint",
  "check",
  "check:web",
  "check:web-tests",
  "check:theme",
  "check:platform-app-transport",
  "check:workspace-paths",
  "check:conversation-paths",
  "check:tool-namespace",
  "check:workspace-splat-nesting",
  "check:credential-paths",
  "check:public-origin",
  "check:file-paths",
  "check:task-paths",
  "check:resource-schemes",
  "check:rest-responses",
  "check:internal-hosts",
  "check:catalog-schema",
  "check:usage-record",
  "check:test-signatures",
  "check:platform-apps",
  "check:core-skill-tool-refs",
  "check:codegen",
] as const;

export interface StepResult {
  step: string;
  exitCode: number;
  durationMs: number;
  output: string;
}

/** Runs one step and resolves with its exit code and combined output. */
export type StepRunner = (step: string) => Promise<Omit<StepResult, "step" | "durationMs">>;

/** Runs every step in order, never stopping at a failure. */
export async function runSteps(steps: readonly string[], run: StepRunner): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const step of steps) {
    const started = performance.now();
    const { exitCode, output } = await run(step);
    results.push({ step, exitCode, output, durationMs: performance.now() - started });
  }
  return results;
}

/** Spawns `bun run <step>` in `cwd`, capturing stdout and stderr together. */
export async function runBunStep(step: string, cwd: string) {
  const proc = Bun.spawn([process.execPath, "run", step], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, output: stdout + stderr };
}

/** Formats the grouped output and the final summary table. */
export function report(results: StepResult[]): string {
  const sections = results.map(
    (r) => `=== ${r.step} (${r.exitCode === 0 ? "pass" : "FAIL"}) ===\n${r.output.trimEnd()}\n`,
  );
  const rows = results.map(
    (r) =>
      `${r.exitCode === 0 ? "pass" : "FAIL"}  ${(r.durationMs / 1000).toFixed(1).padStart(5)}s  ${r.step}`,
  );
  const failed = results.filter((r) => r.exitCode !== 0).length;
  const summary = [
    "--- summary ---",
    ...rows,
    failed === 0
      ? `All ${results.length} steps passed.`
      : `${failed} of ${results.length} steps failed: ${results
          .filter((r) => r.exitCode !== 0)
          .map((r) => r.step)
          .join(", ")}`,
  ];
  return [...sections, summary.join("\n")].join("\n");
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const results = await runSteps(STEPS, (step) => runBunStep(step, cwd));
  console.log(report(results));
  process.exit(results.some((r) => r.exitCode !== 0) ? 1 : 0);
}

if (import.meta.main) {
  await main();
}
