/**
 * The native runtime: NimbleBrain's own engine loop, run in this process.
 *
 * The default and the reference. Every other runtime is held to the outcomes
 * this one produces for the same resolved run (`test/integration/execution/`).
 */

import type { LanguageModelV4 } from "@ai-sdk/provider";
import { AgentEngine } from "../engine/engine.ts";
import type { AgentRuntime } from "./types.ts";

export const NATIVE_RUNTIME_ID = "native";

export function createNativeRuntime(
  resolveModel: (model: string) => LanguageModelV4,
): AgentRuntime {
  return {
    id: NATIVE_RUNTIME_ID,
    capabilities: { spendGate: true, loopPolicy: true },
    execute(run, io) {
      io.events.emit({
        type: "execution.bound",
        data: { runId: run.runId, runtime: NATIVE_RUNTIME_ID },
      });
      const engine = new AgentEngine(resolveModel(run.config.model), io.tools, io.events);
      return engine.run(run.config, run.system, run.messages, run.tools);
    },
  };
}
