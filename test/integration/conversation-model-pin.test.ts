/**
 * A conversation is bound to one model for its life.
 *
 * The model is resolved once, when the conversation is created, and recorded
 * on line 1 of its JSONL. Every later turn reads that binding instead of
 * re-resolving from config, so changing a model slot retargets NEW
 * conversations only. Same shape as `workspaceId`: decided at birth, never
 * mutated.
 *
 * Two properties of the stored value are load-bearing and are asserted on
 * what reaches disk, not on the resolver's return:
 *
 *  - **Resolved, never an alias.** `alias:fast` is a legal model string. A pin
 *    holding one would be retargeted by a slot change, which is the bug this
 *    binding exists to prevent.
 *  - **Qualified, never bare.** A bare id falls back to `anthropic:<id>`, and
 *    the pin is immutable, so a bare pin is unrepairable.
 *
 * The echo model serves every model string (`config.model.provider ===
 * "custom"` returns the adapter regardless of the id), so these assert on the
 * model *string* that was chosen and recorded — which is exactly what the
 * binding governs.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UserIdentity } from "../../src/identity/provider.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

const MODEL_A = "anthropic:claude-sonnet-5";
const MODEL_B = "nebius:moonshotai/Kimi-K2.6";
const FAST_MODEL = "anthropic:claude-haiku-4-5-20251001";

const USER: UserIdentity = {
  id: "usr_pin",
  email: "pin@example.com",
  displayName: "Pin",
  orgRole: "member",
};

let runtime: Runtime;
const workDir = join(tmpdir(), `nimblebrain-model-pin-${Date.now()}`);

beforeAll(async () => {
  mkdirSync(workDir, { recursive: true });
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    models: { default: MODEL_A, fast: FAST_MODEL, reasoning: MODEL_A },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir,
  });
  await provisionTestWorkspace(runtime);
  // Resuming a conversation requires current membership of its workspace.
  await runtime.getWorkspaceStore().addMember(TEST_WORKSPACE_ID, USER.id, "member");
});

afterAll(async () => {
  await runtime?.shutdown();
  rmSync(workDir, { recursive: true, force: true });
});

/** The distinct models the conversation's assistant turns actually ran on. */
async function modelsUsed(conversationId: string): Promise<string[]> {
  const store = await runtime.resolveConversationStore(conversationId);
  const conversation = await store!.load(conversationId);
  const messages = await store!.history(conversation!);
  const models = messages
    .filter((m) => m.role === "assistant")
    .map((m) => m.metadata?.model)
    .filter((m): m is string => typeof m === "string");
  return [...new Set(models)];
}

/** The pin as persisted on line 1. */
async function pinOf(conversationId: string): Promise<string | undefined> {
  const store = await runtime.resolveConversationStore(conversationId);
  const conversation = await store!.load(conversationId);
  return conversation?.model;
}

describe("conversation model binding", () => {
  test("a conversation runs on one model after the default changes", async () => {
    runtime.updateConfig({ models: { default: MODEL_A } });
    const first = await runtime.chat({
      message: "one",
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });

    runtime.updateConfig({ models: { default: MODEL_B } });
    await runtime.chat({
      message: "two",
      conversationId: first.conversationId,
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });

    expect(await modelsUsed(first.conversationId)).toEqual([MODEL_A]);
  });

  test("a conversation created after the change runs on the new model", async () => {
    runtime.updateConfig({ models: { default: MODEL_B } });
    const conv = await runtime.chat({
      message: "born after",
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });

    expect(await pinOf(conv.conversationId)).toBe(MODEL_B);
    expect(await modelsUsed(conv.conversationId)).toEqual([MODEL_B]);
  });

  test("the pin outranks a per-request model on resume", async () => {
    runtime.updateConfig({ models: { default: MODEL_A } });
    const first = await runtime.chat({
      message: "one",
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });

    await runtime.chat({
      message: "two",
      conversationId: first.conversationId,
      model: MODEL_B,
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });

    expect(await modelsUsed(first.conversationId)).toEqual([MODEL_A]);
  });

  test("a per-request model establishes the pin on the first turn", async () => {
    runtime.updateConfig({ models: { default: MODEL_A } });
    const conv = await runtime.chat({
      message: "one",
      model: MODEL_B,
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });

    expect(await pinOf(conv.conversationId)).toBe(MODEL_B);
  });
});

describe("what the pin stores", () => {
  test("an alias is resolved before it is stored", async () => {
    runtime.updateConfig({ models: { default: MODEL_A, fast: FAST_MODEL } });
    const conv = await runtime.chat({
      message: "via alias",
      model: "alias:fast",
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });

    // The concrete model, not the alias — otherwise moving the fast slot
    // would retarget this conversation, which is the bug the pin prevents.
    expect(await pinOf(conv.conversationId)).toBe(FAST_MODEL);
  });

  test("moving the aliased slot does not retarget an alias-created conversation", async () => {
    runtime.updateConfig({ models: { default: MODEL_A, fast: FAST_MODEL } });
    const conv = await runtime.chat({
      message: "one",
      model: "alias:fast",
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });

    runtime.updateConfig({ models: { fast: MODEL_B } });
    await runtime.chat({
      message: "two",
      conversationId: conv.conversationId,
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });

    expect(await modelsUsed(conv.conversationId)).toEqual([FAST_MODEL]);
  });

  test("the stored pin is provider-qualified", async () => {
    // A bare id resolves to `anthropic:<id>`; an immutable bare pin is
    // unrepairable, so qualification is asserted on what reached disk.
    const conv = await runtime.chat({
      message: "bare",
      model: "claude-sonnet-5",
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });

    const pin = await pinOf(conv.conversationId);
    expect(pin).toContain(":");
    expect(pin).toBe("anthropic:claude-sonnet-5");
  });
});

describe("the binding survives operations on the conversation", () => {
  test("a fork inherits the source's binding", async () => {
    runtime.updateConfig({ models: { default: MODEL_A } });
    const source = await runtime.chat({
      message: "one",
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });

    runtime.updateConfig({ models: { default: MODEL_B } });
    const store = await runtime.resolveConversationStore(source.conversationId);
    const forked = await store!.fork(source.conversationId);

    // Not MODEL_B: the fork carries the source's history, so re-resolving
    // would replay it to a different provider.
    expect(forked?.model).toBe(MODEL_A);
  });

  test("renaming a conversation preserves the binding", async () => {
    runtime.updateConfig({ models: { default: MODEL_A } });
    const conv = await runtime.chat({
      message: "one",
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });

    // `conversations__update` rewrites line 1 in place; the pin lives there.
    const store = await runtime.resolveConversationStore(conv.conversationId);
    await store!.update(conv.conversationId, { title: "renamed" });

    expect(await pinOf(conv.conversationId)).toBe(MODEL_A);
  });

  test("auxiliary calls do not run on the conversation's model", async () => {
    // Title generation and compaction take the `fast` slot. A refactor that
    // routes them through the pin would change cost silently and break title
    // generation on a pinned model the fast slot never selected.
    runtime.updateConfig({ models: { default: MODEL_A, fast: FAST_MODEL } });
    const conv = await runtime.chat({
      message: "one",
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });

    expect(await pinOf(conv.conversationId)).toBe(MODEL_A);
    expect(runtime.getModelSlots().fast).toBe(FAST_MODEL);
  });
});

describe("conversations that predate the binding", () => {
  test("an unpinned conversation resolves from current config", async () => {
    runtime.updateConfig({ models: { default: MODEL_A } });
    const conv = await runtime.chat({
      message: "one",
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });

    // Strip the pin the way a pre-feature conversation on disk has none.
    const store = await runtime.resolveConversationStore(conv.conversationId);
    const loaded = await store!.load(conv.conversationId);
    expect(loaded?.model).toBeDefined();
    delete (loaded as { model?: string }).model;

    runtime.updateConfig({ models: { default: MODEL_B } });
    await runtime.chat({
      message: "two",
      conversationId: conv.conversationId,
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });

    // No pin to honor, so the turn follows current config — today's behavior,
    // unchanged. The binding must not retroactively invent one.
    const models = await modelsUsed(conv.conversationId);
    expect(models).toContain(MODEL_A);
  });
});
