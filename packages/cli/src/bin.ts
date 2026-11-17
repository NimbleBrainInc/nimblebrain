/**
 * The published entry point (`bin` in package.json, after the build). Kept
 * apart from `main.ts` so importing `run` in a test never executes a command,
 * without `import.meta.main`, which Node only has from 24.
 */
import { realDeps } from "./deps.ts";
import { run } from "./main.ts";

const { stdout, code } = await run(process.argv.slice(2), realDeps());
process.stdout.write(stdout);
process.exitCode = code;
