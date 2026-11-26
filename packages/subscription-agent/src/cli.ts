#!/usr/bin/env bun
/**
 * Run NimbleBrain's agent turns on your own Claude or ChatGPT subscription.
 *
 *   bun packages/subscription-agent/src/cli.ts claude [--port 27290] [--model <id>]
 *   bun packages/subscription-agent/src/cli.ts codex  [--port 27291] [--model <id>]
 */

import { createClaudeBackend } from "./backends/claude.ts";
import { createCodexBackend } from "./backends/codex.ts";
import { API_KEY_VARIABLES, type Backend, BackendRefused } from "./backends/types.ts";
import { log } from "./log.ts";
import { serveWorker } from "./worker.ts";

const DEFAULT_PORTS = { "claude-code": 27290, codex: 27291 } as const;

function usage(): never {
  process.stderr.write(
    "usage: subscription-agent <claude|codex> [--port <n>] [--model <id>]\n" +
      "Runs NimbleBrain's agent turns on the Claude Code or Codex you are signed in to,\n" +
      "billed to your subscription, never an API key.\n",
  );
  process.exit(2);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const [which, ...rest] = process.argv.slice(2);
  const model = flag(rest, "--model");
  const backend: Backend =
    which === "claude"
      ? createClaudeBackend(model ? { model } : {})
      : which === "codex"
        ? createCodexBackend(model ? { model } : {})
        : usage();
  const port = Number(flag(rest, "--port") ?? DEFAULT_PORTS[backend.id]);

  const account = await backend.preflight();
  const stripped = API_KEY_VARIABLES.filter((k) => process.env[k]);
  const worker = await serveWorker(backend, port);

  const lines = [
    "",
    `  NimbleBrain on ${backend.label}`,
    "",
    `  Billed to:   ${account.describe}`,
    stripped.length > 0
      ? `  API keys:    ${stripped.join(", ")} set in this shell, and withheld from ${backend.label}`
      : "  API keys:    none, so nothing can bill API pricing",
    `  Tools:       ${backend.toolsAreNimbleBrainOnly ? "only your NimbleBrain workspace's tools" : "your NimbleBrain workspace's tools, plus Codex's read-only shell (it has no off switch)"}`,
    `  Listening:   ${worker.acpUrl} (this machine only)`,
    "",
    "  Point NimbleBrain at it, in nimblebrain.json:",
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

main().catch((err: unknown) => {
  if (err instanceof BackendRefused) {
    process.stderr.write(`\n  Not started: ${err.message}\n\n`);
    process.exit(1);
  }
  throw err;
});
