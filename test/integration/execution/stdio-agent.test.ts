import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StaticToolRouter } from "../../../src/adapters/static-router.ts";
import type { EngineEvent } from "../../../src/engine/types.ts";
import { createAcpRuntime } from "../../../src/execution/acp/acp-runtime.ts";
import type { AcpDriver } from "../../../src/execution/acp/driver.ts";
import {
  encodeMessages,
  RUN_META_KEY,
  userMessageToPrompt,
} from "../../../src/execution/acp/nimblebrain-extension.ts";
import type { ResolvedRun } from "../../../src/execution/types.ts";
import { spawnStdioAgent } from "../../helpers/acp/stdio-agent-process.ts";

// An ACP agent as a real child process: the transport, the environment a
// driver hands it, and that nothing outlives the run.

const AGENT = join(import.meta.dir, "../../helpers/acp-stdio-agent.ts");

function stdioDriver(pids: number[]): AcpDriver {
  return {
    id: "stdio-test",
    toolSurface: "projection",
    async open() {
      const target = spawnStdioAgent({
        command: process.execPath,
        args: ["--no-env-file", AGENT],
        cwd: tmpdir(),
        env: { PATH: "/usr/bin:/bin", ONLY_THIS: "1" },
      });
      const found = Bun.spawnSync(["pgrep", "-f", AGENT]).stdout.toString().trim();
      pids.push(...found.split("\n").filter(Boolean).map(Number));
      return target;
    },
    sessionMeta: (run) => ({
      [RUN_META_KEY]: {
        system: run.system,
        history: encodeMessages([]),
        model: run.config.model,
        maxIterations: run.config.maxIterations,
        maxInputTokens: run.config.maxInputTokens,
        maxOutputTokens: run.config.maxOutputTokens,
      },
    }),
    prompt: (run) => {
      const last = run.messages.at(-1);
      return last?.role === "user" ? userMessageToPrompt(last) : [];
    },
  };
}

const run: ResolvedRun = {
  runId: "run_stdio",
  conversationId: null,
  system: "s",
  messages: [{ role: "user", content: [{ type: "text", text: "what can you see?" }] }],
  tools: [],
  config: { model: "test:echo", maxIterations: 3, maxInputTokens: 10_000, maxOutputTokens: 100 },
};

describe("an ACP agent over stdio", () => {
  test("sees only the environment its driver names, and is gone when the run ends", async () => {
    const pids: number[] = [];
    const events: EngineEvent[] = [];
    const result = await createAcpRuntime("stdio-test", stdioDriver(pids)).execute(run, {
      tools: new StaticToolRouter([], () => ({ content: [], isError: false })),
      events: { emit: (e) => events.push(e) },
    });

    expect(result.stopReason).toBe("complete");
    const seen = result.output.replace(/^env:/, "").split(",");
    expect(seen).toContain("ONLY_THIS");
    expect(seen).not.toContain("HOME");
    expect(seen.filter((k) => /KEY|TOKEN|SECRET/i.test(k))).toEqual([]);
    expect(events.some((e) => e.type === "execution.bound")).toBe(true);

    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) {
      expect(() => process.kill(pid, 0)).toThrow();
    }
  });
});
