/**
 * The driver for NimbleBrain's own ACP agent (`src/execution/acp-agent/`).
 *
 * It hands the agent the door's prompt, history and limits through
 * NimbleBrain's `_meta` extension, and opens the latest message as the turn's
 * prompt. The agent runs in this process over an in-memory connection: the
 * protocol, the session and the tool projection are all exercised, with no
 * process to manage.
 */

import { tmpdir } from "node:os";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { createNimbleBrainAcpAgent } from "../../acp-agent/agent.ts";
import type { ResolvedRun } from "../../types.ts";
import { type AcpDriver, knownStopReason } from "../driver.ts";
import {
  encodeMessages,
  RUN_META_KEY,
  type RunMeta,
  STOP_REASON_META_KEY,
  userMessageToPrompt,
} from "../nimblebrain-extension.ts";

export function createNimbleBrainDriver(opts: {
  resolveModel(model: string): LanguageModelV4;
}): AcpDriver {
  return {
    id: "nimblebrain",
    // The agent reaches tools only through the MCP servers the session names.
    toolSurface: "projection",
    async open() {
      return { target: createNimbleBrainAcpAgent(opts), cwd: tmpdir(), close: async () => {} };
    },
    sessionMeta(run) {
      const meta: RunMeta = {
        system: run.system,
        history: encodeMessages(priorMessages(run)),
        model: run.config.model,
        maxIterations: run.config.maxIterations,
        maxInputTokens: run.config.maxInputTokens,
        maxOutputTokens: run.config.maxOutputTokens,
        ...(run.config.thinking ? { thinking: run.config.thinking } : {}),
      };
      return { [RUN_META_KEY]: meta };
    },
    prompt(run) {
      const latest = run.messages.at(-1);
      return latest?.role === "user" ? userMessageToPrompt(latest) : [];
    },
    outcome(response) {
      const stopReason = knownStopReason(response._meta?.[STOP_REASON_META_KEY]);
      return stopReason ? { stopReason } : {};
    },
  };
}

/** The history before the message that opens the run. */
function priorMessages(run: ResolvedRun) {
  return run.messages.at(-1)?.role === "user" ? run.messages.slice(0, -1) : run.messages;
}
