#!/usr/bin/env bun
/**
 * Typecheck: the web suite compiles under web's own strict config. Every
 * diagnostic fails the check.
 *
 * `web/tsconfig.json` excludes `src/**\/*.test.ts(x)` and `src/**\/__tests__`,
 * and its `include` never reaches `web/test/`, so `check:web` reads none of the
 * suite, and `bun test` strips types. Web also resolves no Bun types there, so
 * `bun:test` would not resolve and every `describe`/`expect` would be `any`. A
 * prop, a context value, or an API type can then change shape while its tests
 * keep passing against the old one.
 *
 * `web/tsconfig.test.json` extends web's config unchanged, so the suite meets
 * the same strictness as the source, adds `types: ["bun"]`, and includes `src/`
 * and `test/` whole. It runs web's own `tsc`, the version its lockfile pins.
 *
 * Typing a stub on the real signature keeps it honest: `mock<typeof
 * ApiClient.fn>(…)` (with `import type * as ApiClient`) fails here when `fn`
 * changes shape, where a mock typed from its inline body would not.
 *
 * ## Why it proves tsc actually ran
 *
 * A clean run and a run that analyzed nothing both print no diagnostics, so
 * the pass condition is positive: `--listFiles` reports the program tsc built,
 * and every `.ts`/`.tsx` under `web/src/` and `web/test/` must appear in it. A
 * missing or unreadable project file, or an `include` that drifts off either
 * tree, fails here rather than passing unchecked.
 */

import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { $, Glob } from "bun";
import { tscBinary, unlistedSources } from "./lib/tsc-paths.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB = join(ROOT, "web");
const PROJECT = "tsconfig.test.json";
/** The trees the project must cover, relative to `web/`. */
const TREES = ["src", "test"];

/** Any tsc diagnostic line. */
const DIAGNOSTIC = /error TS\d+:/;

/** Every `.ts`/`.tsx` under the trees the project must cover. */
async function listOnDisk(): Promise<string[]> {
  const files: string[] = [];
  for (const tree of TREES) {
    for await (const rel of new Glob("**/*.{ts,tsx}").scan({ cwd: join(WEB, tree) })) {
      files.push(join(WEB, tree, rel));
    }
  }
  return files;
}

function fail(header: string, detail: string[]): never {
  console.error(`✗ ${header}\n`);
  for (const d of detail) console.error(`  ${d}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const tsc = tscBinary(WEB);
  if (!(await Bun.file(tsc).exists())) {
    fail("web/ has no TypeScript installed. Run `cd web && bun install` first.", []);
  }

  const result = await $`${tsc} -p ${PROJECT} --noEmit --pretty false --listFiles`
    .cwd(WEB)
    .nothrow()
    .quiet();
  const lines = `${result.stdout.toString()}${result.stderr.toString()}`.split("\n");
  const diagnostics = lines.filter((l) => DIAGNOSTIC.test(l)).map((l) => `web/${l.trim()}`);

  const onDisk = await listOnDisk();
  if (onDisk.length === 0) {
    fail(`Found no .ts/.tsx under web/${TREES.join(", web/")} — nothing checked.`, []);
  }

  const unanalyzed = unlistedSources(onDisk, lines).map((f) => relative(ROOT, f));
  if (unanalyzed.length > 0) {
    fail(
      `web/${PROJECT} left ${unanalyzed.length} of ${onDisk.length} files unanalyzed — this gate did not check them.`,
      [
        ...unanalyzed.slice(0, 5),
        ...(unanalyzed.length > 5 ? [`… and ${unanalyzed.length - 5} more`] : []),
        ...diagnostics.slice(0, 5),
      ],
    );
  }

  if (diagnostics.length > 0) {
    fail(`Found ${diagnostics.length} type error(s) in the web suite:`, [
      ...diagnostics,
      "",
      "A test typed against a shape the code no longer has still runs and passes,",
      "asserting on a case the runtime cannot produce. Fix the test, not the type.",
    ]);
  }

  // A crash or a bad flag exits non-zero without a diagnostic line; say so
  // rather than read the silence as clean.
  if (result.exitCode !== 0) {
    fail(
      `tsc exited ${result.exitCode} with no diagnostics:`,
      lines.filter((l) => l.trim() && !l.startsWith(ROOT)).slice(0, 10),
    );
  }

  console.log(`✓ web suite typechecks clean (${onDisk.length} files under web/src and web/test)`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
