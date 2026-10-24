/**
 * The native runtime: NimbleBrain's own engine loop, run in this process.
 *
 * The default and the reference. Every other runtime is held to the outcomes
 * this one produces for the same resolved run (`test/integration/execution/`).
 */

import type { LanguageModelV4 } from "@ai-sdk/provider";
import { AgentEngine } from "../engine/engine.ts";
import type { EventSink } from "../engine/types.ts";
import type { AgentRuntime } from "./types.ts";

export const NATIVE_RUNTIME_ID = "native";

export function createNativeRuntime(
  resolveModel: (model: string) => LanguageModelV4,
): AgentRuntime {
  return {
    id: NATIVE_RUNTIME_ID,
    capabilities: { spendGate: true, loopPolicy: true },
    execute(run, io) {
      const engine = new AgentEngine(
        resolveModel(run.config.model),
        io.tools,
        boundAfterStart(io.events, run.runId),
      );
      return engine.run({ ...run.config, runId: run.runId }, run.system, run.messages, run.tools);
    },
  };
}

/**
 * The run's sink, with `execution.bound` emitted right after the engine's
 * `run.start`: the order every runtime records them in.
 */
function boundAfterStart(events: EventSink, runId: string): EventSink {
  let bound = false;
  return {
    emit(event) {
      events.emit(event);
      if (!bound && event.type === "run.start") {
        bound = true;
        events.emit({ type: "execution.bound", data: { runId, runtime: NATIVE_RUNTIME_ID } });
      }
    },
  };
}
