#!/usr/bin/env bun
/**
 * Typecheck: every platform app UI package (`src/platform/*\/ui`) compiles under
 * its own strict config, source and tests alike. Every diagnostic fails the check.
 *
 * Each UI is a separate package with its own `tsconfig.json` and its own
 * TypeScript. The root project excludes `src/platform/*\/ui`, `vite build` does
 * not typecheck, and `bun test` strips types, so without this gate nothing reads
 * these files as TypeScript at all: a wrong prop type or a stale import ships.
 *
 * Two projects per package, because the two halves run in different places:
 *
 * - `tsconfig.json` — the source the iframe runs. It carries the browser libs and
 *   `vite/client` (CSS side-effect imports), and excludes `*.test.ts(x)`, so
 *   shipped code cannot name a Bun global without complaint.
 * - `tsconfig.test.json` — extends it, adds Bun's types so `bun:test` resolves,
 *   and includes the tests. Without `types: ["bun"]` every `describe`/`expect`
 *   degrades to `any` and a test checks nothing about the code it calls.
 *
 * Each package runs its own `node_modules/.bin/tsc`, the version its lockfile
 * pins, so `bun run install:platform-apps` must have run first.
 *
 * ## Why it proves tsc actually ran
 *
 * A clean run and a run that analyzed nothing print the same thing: no
 * diagnostics. So the pass condition is positive: `--listFiles` reports the
 * program tsc built, and every `.ts`/`.tsx` under the package's `src/` must
 * appear in it — non-test files in the source project, every file in the test
 * project. A missing project file, an `include` that drifts off `src/`, or a new
 * test file the test project does not pick up fails here rather than passing
 * unchecked. Finding no UI packages at all fails too.
 */

import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { $, Glob } from "bun";
import { tscBinary, unlistedSources } from "./lib/tsc-paths.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Any tsc diagnostic line. */
const DIAGNOSTIC = /error TS\d+:/;
const TEST_FILE = /\.test\.tsx?$/;

interface Project {
  config: string;
  /** Whether a file under `src/` must be in this project's program. */
  covers: (file: string) => boolean;
}

const PROJECTS: Project[] = [
  { config: "tsconfig.json", covers: (f) => !TEST_FILE.test(f) },
  { config: "tsconfig.test.json", covers: () => true },
];

async function listSources(pkg: string): Promise<string[]> {
  const files: string[] = [];
  for await (const rel of new Glob("**/*.{ts,tsx}").scan({ cwd: join(pkg, "src") })) {
    files.push(join(pkg, "src", rel));
  }
  return files;
}

async function checkProject(pkg: string, project: Project, sources: string[]): Promise<string[]> {
  const name = relative(ROOT, pkg);
  const tsc = tscBinary(pkg);
  if (!(await Bun.file(tsc).exists())) {
    return [`${name}: no TypeScript installed. Run \`bun run install:platform-apps\` first.`];
  }
  if (!(await Bun.file(join(pkg, project.config)).exists())) {
    return [`${name}/${project.config}: missing.`];
  }

  const result = await $`${tsc} -p ${project.config} --noEmit --pretty false --listFiles`
    .cwd(pkg)
    .nothrow()
    .quiet();
  const lines = `${result.stdout.toString()}${result.stderr.toString()}`.split("\n");
  const failures: string[] = [];

  const expected = sources.filter((f) => project.covers(relative(pkg, f)));
  const unanalyzed = unlistedSources(expected, lines);
  if (unanalyzed.length > 0) {
    failures.push(
      `${name}/${project.config} left ${unanalyzed.length} of ${expected.length} files unanalyzed:`,
      ...unanalyzed.map((f) => `  ${relative(ROOT, f)}`),
    );
  }

  const diagnostics = lines.filter((l) => DIAGNOSTIC.test(l));
  failures.push(...diagnostics.map((l) => `${name}/${l.trim()}`));

  // A crash or a bad flag exits non-zero without a diagnostic line; say so
  // rather than read the silence as clean.
  if (result.exitCode !== 0 && diagnostics.length === 0) {
    failures.push(
      `${name}/${project.config}: tsc exited ${result.exitCode} with no diagnostics:`,
      ...lines.filter((l) => l.trim() && !l.startsWith(ROOT)).slice(0, 10),
    );
  }
  return failures;
}

async function main(): Promise<void> {
  const packages: string[] = [];
  for await (const rel of new Glob("src/platform/*/ui/package.json").scan({ cwd: ROOT })) {
    packages.push(join(ROOT, rel, ".."));
  }
  packages.sort();
  if (packages.length === 0) {
    console.error("✗ Found no platform app UI packages under src/platform/*/ui — nothing checked.");
    process.exit(1);
  }

  const failures: string[] = [];
  let files = 0;
  for (const pkg of packages) {
    const sources = await listSources(pkg);
    files += sources.length;
    for (const project of PROJECTS) {
      failures.push(...(await checkProject(pkg, project, sources)));
    }
  }

  if (failures.length > 0) {
    // A source error is in both projects' programs; report it once.
    console.error("✗ Platform app UI typecheck failed:\n");
    for (const f of new Set(failures)) console.error(`  ${f}`);
    process.exit(1);
  }

  console.log(
    `✓ ${packages.length} platform app UIs typecheck clean (${files} files, source and tests)`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
