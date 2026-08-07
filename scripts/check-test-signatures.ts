#!/usr/bin/env bun
/**
 * Lint: no test under `test/` calls a function with the wrong number of arguments.
 *
 * `tsconfig.json`'s `include` is `src` / `instrument` / `scripts`, so `bun run
 * check` never sees `test/`. A signature change therefore does not break its
 * tests; it silently converts them into tests that assert a shape production can
 * no longer produce. Nothing goes red, and the coverage is gone until someone
 * reads the file.
 *
 * That is not hypothetical: `recordLlmUsage` grew from three parameters to five
 * and two call sites in `test/unit/metrics.test.ts` kept passing three, still
 * green, still asserting on a label set the runtime had stopped emitting.
 *
 * The obvious fix — put `test/**` in `include` — surfaces ~1,500 errors, almost
 * all strict-null and implicit-any noise in fixtures. That migration is worth
 * doing and is tracked separately; it is not a precondition for closing the one
 * failure mode above.
 *
 * So this gates the single diagnostic that catches it: **TS2554**, "Expected N
 * arguments, but got M". It is the code TypeScript emits when a call site falls
 * behind its callee, it has no false-positive story (an arity mismatch is always
 * wrong), and it needs none of the strictness the rest of the suite would fail.
 * `tsconfig.test.json` is the base config with that strictness relaxed, so the
 * compiler still resolves every signature. Widening this script to more codes
 * means fixing that code's existing instances first — check before adding one.
 *
 * ## What this does NOT cover
 *
 * Only the `test/` tree. `web/`'s suite (`web/tsconfig.json` excludes
 * `src/**\/*.test.ts(x)` and `src/**\/__tests__`) and the bundle UI suites
 * (under the base config's `src/bundles/*\/ui` exclude, which this project
 * inherits) have the identical hole and are not gated here. Extending to them
 * is tracked with the full-strictness migration.
 *
 * ## Why it proves tsc actually ran
 *
 * A gate that greens when it stops working is the same defect it exists to
 * catch, one level up. Filtering stdout for TS2554 does exactly that: a renamed
 * project file, an `include` glob that drifts off `test/`, or colourised output
 * all yield zero matching lines, which reads identically to "no violations".
 *
 * So the pass condition is positive, not an absence: `--listFiles` reports the
 * program tsc actually built, and this compares it against the source files
 * actually on disk under `test/`. Every file must be accounted for, which
 * catches total failure (a renamed project, a glob pointing elsewhere) and
 * partial drift (`test/unit/**` silently dropping the integration suite) alike
 * — neither of which enumerating known config-error codes would reach.
 *
 * The two sides must enumerate the same extensions or they cancel: a suffix the
 * project does not compile and this scan does not list is absent from both sets,
 * so it is never "unanalyzed" and the count still reconciles. `.tsx` was exactly
 * that until it was added to both.
 * `--pretty false` is belt-and-braces: it keeps ANSI escapes from landing
 * between `error` and `TS2554:` even when the project sets `pretty`.
 */

import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { $, Glob } from "bun";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROJECT = "tsconfig.test.json";
/**
 * The tree this gate is responsible for, anchored at the repo root.
 *
 * Anchored rather than a bare `/test/` substring: dependencies ship their own
 * `test/` directories (`@types/node/test/reporters.d.ts` is in the program), and
 * a loose match counts those as coverage — which greened a drifted `include` in
 * testing.
 */
const TEST_ROOT = join(ROOT, "test") + sep;
/**
 * Source suffixes under `test/`, and the half of the reconciliation this file
 * owns. The other half is `include` in `tsconfig.test.json` — the two must list
 * the same set. A suffix in neither is invisible to the check rather than
 * reported, because it lands in neither the analyzed set nor the on-disk one.
 */
const TEST_EXTENSIONS = ["ts", "tsx"];

/**
 * "Expected N arguments, but got M" — a call site that fell behind its callee.
 * The one diagnostic this gate covers; see the header before adding another.
 */
const ARITY_ERROR = /error TS2554:/;

async function main(): Promise<void> {
  // tsc exits non-zero whenever it reports anything, and under the relaxed
  // project it reports plenty we deliberately ignore. So the exit code says
  // nothing — the output is the signal. `.nothrow()` keeps a non-zero exit from
  // aborting before we can read it.
  const result = await $`bunx tsc -p ${PROJECT} --noEmit --pretty false --listFiles`
    .cwd(ROOT)
    .nothrow()
    .quiet();
  const lines = `${result.stdout.toString()}${result.stderr.toString()}`.split("\n");

  // What tsc actually analyzed, against what is actually there. `--listFiles`
  // emits one absolute path per file in the program, so this reads the real
  // program rather than inferring coverage from an absence of complaints.
  const analyzed = new Set(lines.filter((l) => l.startsWith(TEST_ROOT)).map((l) => l.trim()));
  const onDisk: string[] = [];
  for await (const rel of new Glob(`**/*.{${TEST_EXTENSIONS.join(",")}}`).scan({
    cwd: join(ROOT, "test"),
  })) {
    onDisk.push(join(ROOT, "test", rel));
  }
  const unanalyzed = onDisk.filter((f) => !analyzed.has(f));

  if (unanalyzed.length > 0) {
    console.error(
      `✗ ${PROJECT} left ${unanalyzed.length} of ${onDisk.length} files under test/ unanalyzed — this gate did not check them.\n`,
    );
    console.error("A real arity error in an unanalyzed file would go unreported, so the gate must");
    console.error("fail rather than report a pass it cannot back. Usual causes: the project file");
    console.error("is missing or unreadable, or its `include` no longer covers the whole tree.\n");
    for (const f of unanalyzed.slice(0, 5)) console.error(`  ${relative(ROOT, f)}`);
    if (unanalyzed.length > 5) console.error(`  … and ${unanalyzed.length - 5} more`);
    for (const l of lines.filter((l) => /error TS/.test(l)).slice(0, 5)) {
      console.error(`\n  ${l.trim()}`);
    }
    process.exit(1);
  }

  const violations = lines.filter((l) => ARITY_ERROR.test(l)).map((l) => l.trim());

  if (violations.length > 0) {
    console.error(`✗ Found ${violations.length} test call(s) with the wrong argument count:\n`);
    for (const v of violations) console.error(`  ${v}`);
    console.error(
      "\nA test that calls a function with the wrong arity still runs — JavaScript ignores",
    );
    console.error(
      "the extra arguments and fills the missing ones with undefined — so it goes on passing",
    );
    console.error("while asserting something the runtime can no longer do. Update the call site.");
    process.exit(1);
  }

  console.log(`✓ No call-site arity mismatches across ${onDisk.length} files under test/`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
