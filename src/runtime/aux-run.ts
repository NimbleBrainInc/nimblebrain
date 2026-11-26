/**
 * The door's own model work as a run on an agent runtime: a system prompt and
 * one user text, no tools, one iteration. Used where the runtime brings its
 * own model and access (`RuntimeCapabilities.ownModel`), so the work is
 * executed by the only thing that can spend that access.
 *
 * The run belongs to no conversation and records nothing in one: its events
 * go to a sink that keeps only the model the agent reported, and the caller
 * bills its usage as the door's own (`aux.usage`), as it does for a native
 * call.
 *
 * It takes no admission slot and no spend account: it is the same work as the
 * native call it replaces, which the door makes for the turn that caused it
 * (a chat is not admitted, and the door's own model calls are not checked,
 * `src/runtime/AGENTS.md`). Only where it executes changes.
 */

import type { Complete } from "../conversation/completion.ts";
import type { ToolRouter } from "../engine/types.ts";
import type { AgentRuntime } from "../execution/types.ts";
import { DEFAULT_MAX_INPUT_TOKENS } from "../limits.ts";

/** A run's router with no tools: an internal run calls none. */
const NO_TOOLS: ToolRouter = {
  availableTools: async () => [],
  execute: async (call) => ({
    content: [{ type: "text", text: `no tools on this run: ${call.name}` }],
    isError: true,
  }),
};

export function completeOnRuntime(runtime: AgentRuntime, ownModel: string): Complete {
  return async ({ system, text, maxOutputTokens, signal }) => {
    const runId = `run_${crypto.randomUUID().slice(0, 12)}`;
    let answeredBy: string | undefined;
    const result = await runtime.execute(
      {
        runId,
        conversationId: null,
        internal: true,
        system,
        messages: [{ role: "user", content: [{ type: "text", text }] }],
        tools: [],
        config: {
          runId,
          model: ownModel,
          maxIterations: 1,
          maxInputTokens: DEFAULT_MAX_INPUT_TOKENS,
          maxOutputTokens,
          signal,
        },
      },
      {
        tools: NO_TOOLS,
        events: {
          emit(event) {
            if (event.type === "llm.done" && !event.data.transcriptOnly) {
              answeredBy ??= event.data.model;
            }
          },
        },
        billSummary: () => {},
      },
    );
    return { text: result.output, usage: result.usage, model: answeredBy ?? ownModel };
  };
}
