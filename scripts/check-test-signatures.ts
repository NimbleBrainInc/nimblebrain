#!/usr/bin/env bun
/**
 * Lint: no test calls a function with the wrong number of arguments.
 *
 * `tsconfig.json`'s `include` is `src` / `instrument` / `scripts` — the test
 * suite is outside it, so `bun run check` never sees it. A signature change
 * therefore does not break its tests; it silently converts them into tests that
 * assert a shape production can no longer produce. Nothing goes red, and the
 * coverage is gone until someone reads the file.
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
 *
 * `tsconfig.test.json` exists for this: the base config with the noisy strictness
 * relaxed, so the compiler still resolves every signature and reports arity while
 * staying quiet about fixture ergonomics. Widening this script to more codes
 * means fixing that code's existing instances first — check before you add one.
 */

import { relative } from "node:path";
import { $ } from "bun";

const ROOT = new URL("..", import.meta.url).pathname;
const PROJECT = "tsconfig.test.json";

/**
 * "Expected N arguments, but got M" — a call site that fell behind its callee.
 * The one diagnostic this gate covers; see the header before adding another.
 */
const ARITY_ERROR = /error TS2554:/;

async function main(): Promise<void> {
  // tsc exits non-zero whenever it reports anything, and under the relaxed
  // project it reports plenty we are deliberately ignoring. So the exit code
  // says nothing — the output is the signal. `.nothrow()` keeps a non-zero exit
  // from aborting the script before we can read it.
  const result = await $`bunx tsc -p ${PROJECT} --noEmit`.cwd(ROOT).nothrow().quiet();
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;

  const violations = output
    .split("\n")
    .filter((line) => ARITY_ERROR.test(line))
    .map((line) => line.trim());

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

  console.log(`✓ No test call-site arity mismatches (${relative(ROOT, PROJECT) || PROJECT})`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
