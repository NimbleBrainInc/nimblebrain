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
 *
 * After the answer, the run gives an update lookup still running up to
 * `NOTICE_WAIT_MS` to finish, so the cache is refreshed even by a short
 * `--json` run, then writes a person's notices on stderr. The process then
 * ends at once rather than when its event loop empties: a lookup it stopped
 * waiting for must not hold it open.
 *
 * The one exception is the agent worker (`WORKER_COMMAND`), the long-running
 * process `use` starts: it is not a command and never answers.
 */
import { writeSync } from "node:fs";
import { realDeps } from "./deps.ts";
import { interrupted, run } from "./main.ts";
import { WORKER_COMMAND } from "./subscription/command.ts";

const argv = process.argv.slice(2);
if (argv[0] === WORKER_COMMAND) {
  // Loaded only here, so a command never evaluates the worker's ACP and MCP code.
  const { serveAgentWorker } = await import("./subscription/serve.ts");
  await serveAgentWorker(argv.slice(1));
} else {
  await answerOnce(argv);
}

async function answerOnce(argv: string[]): Promise<void> {
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

  const answer = await run(argv, deps);
  writeSync(1, answer.stdout);
  answered = true;
  const notices = await answer.notices?.();
  if (notices) writeSync(2, notices);
  process.exit(answer.code);
}
