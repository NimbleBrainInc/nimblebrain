#!/usr/bin/env bun
/**
 * Lint: no test under `test/` is written against a shape that moved — a call with
 * the wrong number of arguments, or an import naming something no longer exported.
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
 * So this gates the diagnostics that catch it without importing that migration.
 * Each one has no false-positive story — the code is either wrong or it is not,
 * with no fixture-ergonomics judgment in between — and none needs the strictness
 * the rest of the suite would fail. `tsconfig.test.json` is the base config with
 * that strictness relaxed, so the compiler still resolves every signature.
 *
 * - **TS2554** "Expected N arguments, but got M" — a call site that fell behind
 *   its callee. An arity mismatch is always wrong.
 * - **TS2305 / TS2724 / TS2459 / TS2614** "no exported member" — an import naming
 *   something the module does not export. Worse than an arity mismatch: an
 *   unresolved type import degrades to the error type, which behaves as `any`, so
 *   every annotation written in terms of it silently stops constraining anything.
 *   One dead import voids a whole file's type coverage while the suite stays
 *   green.
 *
 *   All four are the same defect; which one TypeScript picks turns on properties
 *   of the *importee*, not of the mistake. TS2614 rather than TS2305 whenever the
 *   module happens to have a default export, TS2724 when the name is a near-miss,
 *   TS2459 when the name is declared but its `export` was dropped — the way a
 *   named export most often rots. Gating a subset would make coverage depend on
 *   whether an unrelated module carries a default.
 *
 * `TS2304` "Cannot find name" is the same degradation one step further along — no
 * import at all — and is deliberately still out: its 29 instances today are
 * mostly missing DOM lib types, not drift. Widening to another code means fixing
 * that code's existing instances first, and expecting the fix to expose what the
 * dead type was hiding.
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
 * The diagnostics this gate covers — a call site that fell behind its callee
 * (TS2554), and an import naming something its module does not export (the
 * other four, which are one defect TypeScript reports four ways). See the
 * header before adding another.
 */
const GATED_CODES = [2554, 2305, 2724, 2459, 2614];
const GATED = new RegExp(`error TS(${GATED_CODES.join("|")}):`);

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
    console.error("A real violation in an unanalyzed file would go unreported, so the gate must");
    console.error("fail rather than report a pass it cannot back. Usual causes: the project file");
    console.error("is missing or unreadable, or its `include` no longer covers the whole tree.\n");
    for (const f of unanalyzed.slice(0, 5)) console.error(`  ${relative(ROOT, f)}`);
    if (unanalyzed.length > 5) console.error(`  … and ${unanalyzed.length - 5} more`);
    for (const l of lines.filter((l) => /error TS/.test(l)).slice(0, 5)) {
      console.error(`\n  ${l.trim()}`);
    }
    process.exit(1);
  }

  // Anchored to `test/` like the coverage check above. The project also compiles
  // `src/`, `instrument/` and `scripts/` so that signatures resolve, plus the
  // `web/src` files those import — already covered by `bun run check` and
  // `check:web` respectively, so reporting them here would only duplicate that,
  // under a message telling you to update a test.
  //
  // Both path forms count. `--listFiles` is absolute, diagnostics are relative to
  // tsc's cwd, and matching only one would make an empty `violations` mean either
  // "clean" or "the format moved" — the silent green this gate refuses. A path
  // under TEST_ROOT is unambiguously a test file, so accepting both costs nothing.
  const violations = lines
    .filter((l) => (l.startsWith(`test${sep}`) || l.startsWith(TEST_ROOT)) && GATED.test(l))
    .map((l) => l.trim());

  if (violations.length > 0) {
    console.error(`✗ Found ${violations.length} test(s) written against a shape that moved:\n`);
    for (const v of violations) console.error(`  ${v}`);
    console.error("\nNeither kind stops a test from running, which is why they survive. A wrong");
    console.error("arity still executes — JavaScript drops the extras and fills the missing with");
    console.error("undefined. A dead type import degrades to the error type, so every annotation");
    console.error("written in terms of it stops constraining anything. Both go on passing while");
    console.error("asserting something the runtime can no longer do. Update the test.");
    process.exit(1);
  }

  console.log(`✓ No call-site or import drift across ${onDisk.length} files under test/`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
