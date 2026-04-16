import { homedir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";
import { render } from "ink";
import { createElement } from "react";
import { CallbackEventSink } from "../../adapters/callback-events.ts";
import { ConsoleEventSink } from "../../adapters/console-events.ts";
import { DebugEventSink } from "../../adapters/debug-events.ts";
import { Runtime } from "../../runtime/runtime.ts";
import type { TelemetryManager } from "../../telemetry/manager.ts";
import { App } from "../app.tsx";
import { loadConfig } from "../config.ts";
import { log } from "../log.ts";
import { TuiConfirmationGate } from "../tui-gate.ts";

/**
 * Register the default action on the root program.
 * Handles the no-subcommand case: TUI (interactive) or headless (piped stdin).
 */
export function registerDefaultAction(program: Command, telemetry: TelemetryManager): void {
  program
    .option("--resume <id>", "resume a conversation")
    .action(async (_opts: unknown, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const headless = !process.stdin.isTTY;

      const config = loadConfig({
        config: globals.config,
        model: globals.model,
        defaultWorkDir: join(homedir(), ".nimblebrain"),
      });

      // Interactive mode gets TUI gate for confirmations + credential prompts
      if (!headless) {
        config.confirmationGate = new TuiConfirmationGate();
      }

      // Event sinks — headless doesn't need the callback sink (no Ink UI)
      let callbackSink: CallbackEventSink | undefined;
      if (headless) {
        config.events = [globals.debug ? new DebugEventSink() : new ConsoleEventSink()];
      } else {
        callbackSink = new CallbackEventSink();
        config.events = [
          callbackSink,
          globals.debug ? new DebugEventSink() : new ConsoleEventSink(),
        ];
      }

      log.info("[nimblebrain] Starting runtime...");

      const startupTime = performance.now();
      const runtime = await Runtime.start(config);
      const startupMs = Math.round(performance.now() - startupTime);
      telemetry.capture("cli.startup", {
        mode: headless ? "headless" : "tui",
        bundle_count: runtime.bundleNames().length,
        startup_ms: startupMs,
      });

      const tools = await runtime.availableTools();
      if (tools.length > 0) {
        log.info(`[nimblebrain] ${tools.length} tools available`);
      }

      const resumeId = globals.resume as string | undefined;
      if (resumeId) {
        log.info(`[nimblebrain] Resuming conversation: ${resumeId}`);
      }

      log.info("[nimblebrain] Ready.\n");

      if (headless) {
        await runHeadless(runtime, resumeId, globals.json ?? false);
      } else {
        const tuiGate = config.confirmationGate as TuiConfirmationGate | undefined;
        await runInteractive(runtime, callbackSink!, resumeId, tuiGate);
      }

      log.info("\n[nimblebrain] Shutting down...");
      await telemetry.shutdown();
      await runtime.shutdown();
      process.exit(0);
    });
}

/**
 * Headless pipe mode: read lines from stdin, write responses to stdout.
 *
 * One line = one message. Runtime stays alive across all lines (single session).
 * Conversation ID is managed internally — no --resume needed for multi-turn.
 * EOF closes the session.
 *
 * Output modes:
 *   default: plain text (just the response)
 *   --json:  full ChatResult as JSON, one object per line
 */
async function runHeadless(
  runtime: Runtime,
  resumeId: string | undefined,
  json: boolean,
): Promise<void> {
  let conversationId = resumeId;
  let hasError = false;

  const fullInput = await Bun.stdin.text();
  const inputLines = fullInput.split("\n");

  for (const line of inputLines) {
    const message = line.trim();
    if (!message) continue;

    log.info(`[headless] ← ${message}`);

    try {
      const result = await runtime.chat({ message, conversationId });
      conversationId = result.conversationId;

      if (json) {
        const output = {
          response: result.response,
          conversationId: result.conversationId,
          skillName: result.skillName,
          toolCalls: result.toolCalls,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          stopReason: result.stopReason,
        };
        process.stdout.write(`${JSON.stringify(output)}\n`);
      } else {
        process.stdout.write(`${result.response}\n`);
      }

      log.info(
        `[headless] → ${result.response.slice(0, 80)}${result.response.length > 80 ? "..." : ""} (${result.inputTokens + result.outputTokens} tokens)`,
      );
    } catch (err) {
      hasError = true;
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error(`[headless] error: ${errorMsg}`);

      if (json) {
        process.stdout.write(`${JSON.stringify({ error: errorMsg })}\n`);
      } else {
        process.stderr.write(`Error: ${errorMsg}\n`);
      }
    }
  }

  if (hasError) process.exitCode = 1;
}

async function runInteractive(
  runtime: Runtime,
  callbackSink: CallbackEventSink,
  resumeId: string | undefined,
  gate?: TuiConfirmationGate,
): Promise<void> {
  const { waitUntilExit } = render(
    createElement(App, {
      runtime,
      eventSink: callbackSink,
      initialConversationId: resumeId,
      confirmationGate: gate,
    }),
    { exitOnCtrlC: false },
  );

  await waitUntilExit();
}
