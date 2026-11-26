/**
 * The agent worker's process: `nimblebrain __agent-worker <claude|codex>
 * [--port <n>] [--model <id>] [--log <path>]`. `use` has launchd start it (a
 * login item), its output in `<home>/agent-worker.log`, which `--log` names
 * so a failed turn can point at it; run in the foreground, it serves a source
 * checkout's `bun run dev` the same way.
 *
 * It is not a command. It never answers in the CLI's JSON contract: it runs
 * until stopped, and does its own I/O (a listening port, the vendor CLI's
 * processes, its log on stderr). Exit 0 when stopped, 1 when it refused to
 * start (not signed in, an API key, a port in use), 2 for bad arguments.
 */

import { parseArgs } from "node:util";
import { createClaudeBackend } from "./backends/claude.ts";
import { createCodexBackend } from "./backends/codex.ts";
import { API_KEY_VARIABLES, type Backend, BackendRefused } from "./backends/types.ts";
import { TOOL_SURFACE, WORKER_COMMAND, WORKER_PORTS } from "./command.ts";
import { log } from "./log.ts";
import { serveWorker } from "./worker.ts";

function usage(): never {
  process.stderr.write(
    `usage: nimblebrain ${WORKER_COMMAND} <claude|codex> [--port <n>] [--model <id>] [--log <path>]\n` +
      "Runs NimbleBrain's agent turns on the Claude Code or Codex you are signed in to,\n" +
      "billed to your subscription, never an API key. `npx nimblebrain use` starts it for you.\n",
  );
  process.exit(2);
}

function parse(argv: string[]): { backend: Backend; port: number } {
  let parsed: ReturnType<typeof parseWorkerArgs>;
  try {
    parsed = parseWorkerArgs(argv);
  } catch {
    usage();
  }
  const [which, ...extra] = parsed.positionals;
  if (extra.length > 0) usage();
  const { model, log: logPath } = parsed.values;
  const opts = { ...(model ? { model } : {}), ...(logPath ? { log: logPath } : {}) };
  const backend =
    which === "claude"
      ? createClaudeBackend(opts)
      : which === "codex"
        ? createCodexBackend(opts)
        : usage();
  const port = Number(parsed.values.port ?? WORKER_PORTS[backend.id]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) usage();
  return { backend, port };
}

function parseWorkerArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: { port: { type: "string" }, model: { type: "string" }, log: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
}

/** Runs the worker until SIGINT or SIGTERM; never returns. */
export async function serveAgentWorker(argv: string[]): Promise<void> {
  const { backend, port } = parse(argv);
  try {
    await start(backend, port);
  } catch (err) {
    const message =
      err instanceof BackendRefused
        ? err.message
        : (err as NodeJS.ErrnoException).code === "EADDRINUSE"
          ? `port ${port} is in use on 127.0.0.1.`
          : err instanceof Error
            ? err.message
            : String(err);
    process.stderr.write(`\n  Not started: ${message}\n\n`);
    process.exit(1);
  }
}

async function start(backend: Backend, port: number): Promise<void> {
  const account = await backend.preflight();
  const stripped = API_KEY_VARIABLES.filter((k) => process.env[k]);
  const worker = await serveWorker(backend, port, account.plan);

  const lines = [
    "",
    `  NimbleBrain on ${backend.label}`,
    "",
    `  Billed to:   ${account.describe}`,
    stripped.length > 0
      ? `  API keys:    ${stripped.join(", ")} set in this shell, and withheld from ${backend.label}`
      : "  API keys:    none, so nothing can bill API pricing",
    `  Model:       ${backend.modelLabel ?? `${backend.label}'s default`}`,
    `  Tools:       ${TOOL_SURFACE[backend.id]}`,
    `  Listening:   ${worker.acpUrl} (this machine only)`,
    "",
    "  An install made by `npx nimblebrain` dials it once `npx nimblebrain use` has run.",
    "  A source checkout (`bun run dev`) dials it with, in nimblebrain.json:",
    "",
    `    "execution": { "default": "${backend.id}",`,
    `      "runtimes": { "${backend.id}": { "driver": "${backend.id}", "url": "${worker.acpUrl}" } } }`,
    "",
    "  Every chat turn and run then goes to your subscription. Ctrl-C stops it.",
    "",
  ];
  process.stderr.write(`${lines.join("\n")}\n`);

  const stop = async () => {
    log("stopping");
    await worker.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
