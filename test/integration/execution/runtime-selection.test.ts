/**
 * The door executes a run on the runtime `execution.default` names, and a
 * conversation outlives any one runtime: every turn is recorded in the
 * engine's vocabulary, so the next turn replays it whichever runtime runs it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4, LanguageModelV4Prompt } from "@ai-sdk/provider";
import type { ConversationEvent } from "../../../src/conversation/types.ts";
import { createAcpRuntime } from "../../../src/execution/acp/acp-runtime.ts";
import type { UserIdentity } from "../../../src/identity/provider.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import type { RuntimeConfig } from "../../../src/runtime/types.ts";
import { usageMonthDir, usageMonthOf } from "../../../src/usage/paths.ts";
import type { UsageLedgerEntry } from "../../../src/usage/types.ts";
import { emptyLog, scriptedConnection, scriptedDriver } from "../../helpers/acp/scripted-agent.ts";
import { devProvider } from "../../helpers/dev-provider.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { makeIdentity } from "../../helpers/identity.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../../helpers/test-workspace.ts";

const USER: UserIdentity = makeIdentity({
  id: "usr_exec",
  email: "exec@example.com",
  displayName: "Exec",
  orgRole: "member",
});

/** Every prompt the model was sent, in order. */
const prompts: LanguageModelV4Prompt[] = [];

function recordingModel(): LanguageModelV4 {
  const echo = createEchoModel();
  return {
    ...echo,
    doStream(options) {
      prompts.push(options.prompt);
      return echo.doStream(options);
    },
  };
}

/** Everything the ACP agent received, in order. */
const agentLog = emptyLog();

const workDir = join(tmpdir(), `nimblebrain-exec-select-${Date.now()}`);
const config: RuntimeConfig = {
  identityProvider: devProvider,
  languageModel: recordingModel(),
  models: { default: "anthropic:claude-sonnet-4-6" },
  logging: { disabled: true },
  workDir,
  execution: { default: "scripted-acp" },
  agentRuntimes: [
    createAcpRuntime(
      "scripted-acp",
      scriptedDriver(),
      scriptedConnection({
        // Echo the turn's last line, as the echo model answers the last message.
        script: (prompt) => [{ text: prompt.trim().split("\n").at(-1) ?? "" }],
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
  const store = await runtime.resolveConversationStore(conversationId);
  return store!.readEvents(conversationId);
}

function bindings(events: ConversationEvent[]) {
  return events
    .filter(
      (e): e is Extract<ConversationEvent, { type: "execution.bound" }> =>
        e.type === "execution.bound",
    )
    .map((e) => ({ runtime: e.runtime, hasSession: e.runtimeSessionId !== undefined }));
}

/** The user text of every message in a prompt, flattened. */
function userTexts(prompt: LanguageModelV4Prompt | undefined): string[] {
  return (prompt ?? [])
    .filter((m) => m.role === "user")
    .flatMap((m) => m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])));
}

/** The usage ledger's lines for one conversation. */
function ledgerLines(conversationId: string): UsageLedgerEntry[] {
  const dir = usageMonthDir(workDir, usageMonthOf(new Date()));
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(dir, f), "utf-8").split("\n").filter(Boolean))
    .map((l) => JSON.parse(l) as UsageLedgerEntry)
    .filter((l) => l.conversationId === conversationId);
}

describe("runtime selection", () => {
  test("a chat runs on the configured ACP runtime, and its turn is recorded", async () => {
    const result = await runtime.chat({
      message: "first question",
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });

    expect(result.response).toContain("first question");
    const events = await eventsOf(result.conversationId);
    expect(bindings(events)).toEqual([{ runtime: "scripted-acp", hasSession: true }]);
    expect(events.filter((e) => e.type === "llm.response")).toHaveLength(1);
    expect(events.filter((e) => e.type === "run.done")).toHaveLength(1);
  });

  test("a later turn replays the conversation, and the runtime can change between turns", async () => {
    const first = await runtime.chat({
      message: "turn one",
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });

    config.execution = { ...config.execution, default: "native" };
    prompts.length = 0;
    await runtime.chat({
      message: "turn two",
      conversationId: first.conversationId,
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });
    // The native engine read the turn the ACP runtime ran.
    expect(userTexts(prompts.at(-1)).join(" ")).toContain("turn one");

    config.execution = { ...config.execution, default: "scripted-acp" };
    agentLog.prompts.length = 0;
    await runtime.chat({
      message: "turn three",
      conversationId: first.conversationId,
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });
    // And the agent behind ACP read both, from the history the door handed it.
    const seen = agentLog.prompts.at(-1) ?? "";
    expect(seen).toContain("turn one");
    expect(seen).toContain("turn two");

    expect(bindings(await eventsOf(first.conversationId))).toEqual([
      { runtime: "scripted-acp", hasSession: true },
      { runtime: "native", hasSession: false },
      { runtime: "scripted-acp", hasSession: true },
    ]);
  });

  test("usage an external runtime reports is recorded as that runtime's", async () => {
    config.execution = { ...config.execution, default: "scripted-acp" };
    const external = await runtime.chat({
      message: "count me",
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });
    config.execution = { ...config.execution, default: "native" };
    const native = await runtime.chat({
      message: "count me too",
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });
    config.execution = { ...config.execution, default: "scripted-acp" };

    const externalLines = ledgerLines(external.conversationId).filter((l) => l.source === "main");
    expect(externalLines.length).toBeGreaterThan(0);
    expect(externalLines.every((l) => l.runtime === "scripted-acp")).toBe(true);
    const nativeLines = ledgerLines(native.conversationId);
    expect(nativeLines.length).toBeGreaterThan(0);
    expect(nativeLines.every((l) => l.runtime === undefined)).toBe(true);
  });

  test("a call NimbleBrain makes inside an external runtime's run is not recorded as the agent's", async () => {
    config.execution = { ...config.execution, default: "scripted-acp" };
    const external = await runtime.chat({
      message: "title me",
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });

    // The title call is forked after the turn returns.
    let title: UsageLedgerEntry | undefined;
    for (let i = 0; i < 50 && !title; i++) {
      title = ledgerLines(external.conversationId).find((l) => l.source === "title");
      if (!title) await Bun.sleep(20);
    }
    const main = ledgerLines(external.conversationId).find((l) => l.source === "main");
    expect(main?.runtime).toBe("scripted-acp");
    // The run's call, measured by NimbleBrain on its own model client.
    expect(title).toBeDefined();
    expect(title?.runId).toBe(main?.runId);
    expect(title?.runtime).toBeUndefined();
  });

  test("a run that names spend accounts is refused on a runtime with no spend gate", async () => {
    config.execution = { ...config.execution, default: "scripted-acp" };
    await expect(
      runtime.executeTask({
        prompt: "do it",
        workspaceId: TEST_WORKSPACE_ID,
        identity: USER,
        spendAccounts: [{ id: "t:1", unit: "usd", remaining: 1 }],
      }),
    ).rejects.toThrow(/cannot run this run/);
  });

  test("a run that caps its input tokens is refused on a runtime with no spend gate", async () => {
    config.execution = { ...config.execution, default: "scripted-acp" };
    await expect(
      runtime.executeTask({
        prompt: "do it",
        workspaceId: TEST_WORKSPACE_ID,
        identity: USER,
        maxRunInputTokens: 1,
      }),
    ).rejects.toThrow(/caps its input tokens/);
  });
});
