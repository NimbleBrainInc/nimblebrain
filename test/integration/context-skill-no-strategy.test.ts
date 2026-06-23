/**
 * PR-2c migration safety net — the no-flag-day proof.
 *
 * Killing the implicit `always` default for `type: context` skills must NOT
 * drop them from the prompt. Vendored core context skills (soul.md,
 * bootstrap.md, automation-authoring.md) carry NO `loading-strategy`; they
 * compose via the Layer 0/1 path (`activeContextSkills()`), which renders every
 * `type: context` body regardless of `loadingStrategy`. This boots the real
 * runtime, runs a chat, and asserts a stable marker from a core context skill
 * is still in the composed system prompt.
 *
 * On a hypothetical change that wrongly routed context skills through the
 * Layer-3 selector (which now skips strategy-less skills), this body would be
 * absent — so it is a genuine guard, not a tautology.
 */

import type { LanguageModelV3 } from "@ai-sdk/provider";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nimblebrain-ctx-nostrategy-${Date.now()}`);
let runtime: Runtime;
let getSystem: () => string;

/** Model that captures the composed system prompt (ignores auto-title calls). */
function createCapturingModel(): { model: LanguageModelV3; getSystem: () => string } {
  let captured = "";
  const model = createMockModel((options) => {
    const systemMsg = options.prompt.find((m) => m.role === "system");
    if (systemMsg && typeof systemMsg.content === "string") {
      if (!systemMsg.content.includes("Generate a 3-6 word title")) {
        captured = systemMsg.content;
      }
    }
    return { content: [{ type: "text", text: "ok" }], inputTokens: 10, outputTokens: 5 };
  });
  return { model, getSystem: () => captured };
}

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  const cap = createCapturingModel();
  getSystem = cap.getSystem;
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: cap.model },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
    telemetry: { enabled: false },
  });
  await provisionTestWorkspace(runtime);
});

afterAll(async () => {
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("PR-2c: strategy-less context skills still compose (no flag day)", () => {
  it("keeps vendored core context content in the system prompt after killing the `always` default", async () => {
    await runtime.chat({ workspaceId: TEST_WORKSPACE_ID, message: "what is 2 + 2?" });
    const sys = getSystem();
    // "# Capability Management" is the heading of bootstrap.md, a core
    // `type: context` skill with no `loading-strategy` — it reaches the prompt
    // only via the Layer 0/1 path, which this proves is intact post-PR-2c.
    expect(sys).toContain("Capability Management");
  });
});
