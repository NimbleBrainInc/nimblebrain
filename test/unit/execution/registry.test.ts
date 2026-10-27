import { describe, expect, test } from "bun:test";
import { createAgentRuntimes } from "../../../src/execution/registry.ts";
import type { AgentRuntime } from "../../../src/execution/types.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";

const deps = { resolveModel: () => createEchoModel() };

function stubRuntime(id: string): AgentRuntime {
  return {
    id,
    capabilities: { spendGate: false },
    execute: () => Promise.reject(new Error("not run")),
  };
}

describe("createAgentRuntimes", () => {
  test("selects a supplied runtime by id, and native by default", () => {
    const runtimes = createAgentRuntimes({ runtimes: [stubRuntime("scripted")] }, deps);
    expect(runtimes.select("scripted").id).toBe("scripted");
    expect(runtimes.select(undefined).id).toBe("native");
  });

  test("rejects two supplied runtimes with the same id", () => {
    expect(() =>
      createAgentRuntimes({ runtimes: [stubRuntime("scripted"), stubRuntime("scripted")] }, deps),
    ).toThrow('execution.runtimes: "scripted" is named twice');
  });

  test("rejects a supplied runtime named native", () => {
    expect(() => createAgentRuntimes({ runtimes: [stubRuntime("native")] }, deps)).toThrow(
      'execution.runtimes: "native" is named twice',
    );
  });
});
