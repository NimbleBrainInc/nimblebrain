/**
 * A default runtime that brings its own model (`RuntimeCapabilities.ownModel`,
 * a coding agent's CLI on a person's subscription) executes the door's own
 * model work too: the conversation's title and the between-turn history fold
 * run on it as internal runs, and nothing reaches the native model. Its runs
 * are recorded under its own model, not the run's slot.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { ConversationEvent } from "../../../src/conversation/types.ts";
import { createAcpRuntime } from "../../../src/execution/acp/acp-runtime.ts";
import type { UserIdentity } from "../../../src/identity/provider.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import type { RuntimeConfig } from "../../../src/runtime/types.ts";
import { emptyLog, scriptedConnection, scriptedDriver } from "../../helpers/acp/scripted-agent.ts";
import { devProvider } from "../../helpers/dev-provider.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { makeIdentity } from "../../helpers/identity.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../../helpers/test-workspace.ts";

const USER: UserIdentity = makeIdentity({
  id: "usr_own",
  email: "own@example.com",
  displayName: "Own",
  orgRole: "member",
});

const OWN_MODEL = "scripted-subscription";
const SUMMARY_NEEDLE = "OWN_RUNTIME_SUMMARY_7f3a";
const TITLE = "Own Runtime Title";

/** Every call that reached the native model. The test expects none. */
const nativeCalls: string[] = [];

function refusingModel(): LanguageModelV4 {
  const echo = createEchoModel();
  return {
    ...echo,
    doGenerate(options) {
      nativeCalls.push("doGenerate");
      return echo.doGenerate(options);
    },
    doStream(options) {
      nativeCalls.push("doStream");
      return echo.doStream(options);
    },
  };
}

const agentLog = emptyLog();
const workDir = join(tmpdir(), `nimblebrain-own-model-${Date.now()}`);
const config: RuntimeConfig = {
  identityProvider: devProvider,
  languageModel: refusingModel(),
  models: { default: "anthropic:claude-sonnet-4-6", fast: "anthropic:claude-haiku-4-5" },
  logging: { disabled: true },
  workDir,
  features: { compaction: true },
  // A small budget and large replies, so a few turns cross the fold's trigger.
  maxInputTokens: 8000,
  maxOutputTokens: 512,
  execution: { default: "own" },
  agentRuntimes: [
    createAcpRuntime(
      "own",
      { ...scriptedDriver(), capabilities: { spendGate: false, ownModel: OWN_MODEL } },
      scriptedConnection({
        script: (prompt) => {
          if (prompt.includes("compacting the older portion")) {
            return [{ text: `${SUMMARY_NEEDLE} dense summary` }];
          }
          if (prompt.includes("Generate a 3-6 word title")) return [{ text: TITLE }];
          return [{ text: `reply ${"x".repeat(3000)}` }];
        },
        log: agentLog,
      }),
    ),
  ],
};
let runtime: Runtime;

beforeAll(async () => {
  mkdirSync(workDir, { recursive: true });
  runtime = await Runtime.start(config);
  await provisionTestWorkspace(runtime);
  await runtime.getWorkspaceStore().addMember(TEST_WORKSPACE_ID, USER.id, "member");
});

afterAll(async () => {
  await runtime?.shutdown();
  rmSync(workDir, { recursive: true, force: true });
});

async function eventsOf(conversationId: string): Promise<ConversationEvent[]> {
  const store = await runtime.resolveConversationStore(TEST_WORKSPACE_ID, conversationId, USER.id);
  return store!.readEvents(conversationId);
}

async function until<T>(read: () => Promise<T | undefined>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
}

describe("a default runtime that brings its own model", () => {
  test("runs the turn, the title and the history fold, and the native model is never called", async () => {
    const first = await runtime.chat({
      message: "turn 1",
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });
    const id = first.conversationId;

    // The title is written after the first turn, by a run on the runtime.
    const titleUsage = await until(async () =>
      (await eventsOf(id)).find(
        (e): e is Extract<ConversationEvent, { type: "aux.usage" }> =>
          e.type === "aux.usage" && e.source === "title",
      ),
    );
    expect(titleUsage.model).toBe(OWN_MODEL);
    const conversation = await runtime.findConversation(TEST_WORKSPACE_ID, id, { userId: USER.id });
    expect(conversation?.title).toBe(TITLE);

    // The run is recorded under the runtime's own model.
    const start = (await eventsOf(id)).find((e) => e.type === "run.start") as
      | { model?: string }
      | undefined;
    expect(start?.model).toBe(OWN_MODEL);

    for (let turn = 2; turn <= 8; turn++) {
      await runtime.chat({
        message: `turn ${turn}`,
        conversationId: id,
        workspaceId: TEST_WORKSPACE_ID,
        identity: USER,
      });
      if ((await eventsOf(id)).some((e) => e.type === "history.compacted")) break;
    }
    const events = await eventsOf(id);
    const fold = events.find(
      (e): e is Extract<ConversationEvent, { type: "history.compacted" }> =>
        e.type === "history.compacted",
    );
    expect(fold?.summary).toContain(SUMMARY_NEEDLE);
    const foldUsage = events.filter((e) => e.type === "aux.usage" && e.source !== "title");
    expect(foldUsage.length).toBeGreaterThan(0);
    for (const usage of foldUsage) expect((usage as { model: string }).model).toBe(OWN_MODEL);

    expect(nativeCalls).toEqual([]);
  });

  test("bootstrap names the runtime instead of offering models", () => {
    expect(runtime.getRuntimeWithOwnModel()).toBe("own");
  });
});
