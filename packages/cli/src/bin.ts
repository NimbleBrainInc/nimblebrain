/**
 * The published entry point (`bin` in package.json, after the build). Kept
 * apart from `main.ts` so importing `run` in a test never executes a command,
 * without `import.meta.main`, which Node only has from 24.
 *
 * Every run answers exactly once. The answer is written synchronously. If the
 * process ends before writing it (a signal, or an `await` that never settles
 * and leaves the loop empty), the exit hook writes an `INTERRUPTED` answer
 * carrying the exit code, and says so on stderr, so the cause is visible next
 * time.
 */
import { writeSync } from "node:fs";
import { realDeps } from "./deps.ts";
import { interrupted, run } from "./main.ts";

const argv = process.argv.slice(2);
const deps = realDeps();
let answered = false;

process.on("exit", (code) => {
  if (answered) return;
  const out = interrupted(argv, code, deps);
  writeSync(1, out.stdout);
  writeSync(2, `nimblebrain: stopped before answering (exit code ${code})\n`);
  process.exitCode = out.code;
});

// A signal ends the process without an `exit` event; end it through
// process.exit so the hook above still answers. 128 + n is the shell's code.
for (const [signal, n] of [
  ["SIGINT", 2],
  ["SIGTERM", 15],
  ["SIGHUP", 1],
] as const) {
  process.on(signal, () => process.exit(128 + n));
}

const { stdout, code } = await run(argv, deps);
writeSync(1, stdout);
answered = true;
process.exitCode = code;
