import { describe, expect, test } from "bun:test";
import type { ResolvedRun } from "../../../src/execution/types.ts";
import {
  createReflexDriver,
  encodeHistory,
  REFLEX_SESSION_META_KEY,
  reflexEnvironment,
} from "../../helpers/acp/reflex-driver.ts";

function run(model = "anthropic:claude-sonnet-4-6"): ResolvedRun {
  return {
    runId: "run_r",
    conversationId: null,
    system: "Be brief.",
    messages: [
      { role: "user", content: [{ type: "text", text: "earlier" }] },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      { role: "user", content: [{ type: "text", text: "now" }] },
    ],
    tools: [],
    config: { model, maxIterations: 7, maxInputTokens: 1000, maxOutputTokens: 100 },
  };
}

describe("reflex driver", () => {
  test("hands the child its model and one key, nothing of this process", () => {
    const env = reflexEnvironment({ command: "reflex" }, run(), {
      NB_REFLEX_API_KEY: "sk-reflex",
      ANTHROPIC_API_KEY: "sk-runtime-own",
      AWS_SECRET_ACCESS_KEY: "nope",
    });
    expect(env).toEqual({
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      REFLEX_MODEL: "anthropic:claude-sonnet-4-6",
      ANTHROPIC_API_KEY: "sk-reflex",
    });
    expect(() =>
      reflexEnvironment({ command: "reflex" }, run(), { ANTHROPIC_API_KEY: "x" }),
    ).toThrow(/NB_REFLEX_API_KEY/);
  });

  test("sends the door's prompt, prior history and limits as Reflex's session options", () => {
    const driver = createReflexDriver({ command: "reflex" }, { NB_REFLEX_API_KEY: "k" });
    expect(driver.toolSurface).toBe("projection");
    const meta = driver.sessionMeta?.(run(), { mcpServers: [] });
    expect(meta).toEqual({
      [REFLEX_SESSION_META_KEY]: {
        system: "Be brief.",
        history: encodeHistory(run().messages.slice(0, 2)),
        model: "anthropic:claude-sonnet-4-6",
        maxIterations: 7,
        maxInputTokens: 1000,
        maxOutputTokens: 100,
      },
    });
    expect(driver.prompt?.(run())).toEqual([{ type: "text", text: "now" }]);
  });

  test("encodes file bytes in Reflex's documented form", () => {
    const encoded = encodeHistory([
      {
        role: "user",
        content: [
          {
            type: "file",
            mediaType: "image/png",
            data: { type: "data", data: new Uint8Array([1, 2]) },
          },
        ],
      },
    ]);
    expect(encoded).toContain('{"__reflex_bytes":"AQI="}');
  });
});
