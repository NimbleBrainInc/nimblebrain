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

import type { EventSourcedConversationStore } from "../../src/conversation/event-sourced-store.ts";
import type { ConversationEvent } from "../../src/conversation/types.ts";
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

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * Wait for the `aux.usage` event a fast-slot call records, and return it.
 * These calls run outside the agentic loop and are fire-and-forget, so the
 * event lands after `chat()` resolves.
 */
async function waitForAuxUsage(
  store: EventSourcedConversationStore,
  conversationId: string,
  source: string,
  timeoutMs = 5000,
): Promise<{ model?: string }> {
  const start = Date.now();
  for (;;) {
    const events = await store.readEvents(conversationId);
    const found = events.find(
      (e): e is Extract<ConversationEvent, { type: "aux.usage" }> =>
        e.type === "aux.usage" && (e as { source?: string }).source === source,
    );
    if (found) return found;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`no aux.usage event with source="${source}" within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
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
  // A slot can be named either way (`parseModelSlotRef`); both must collapse to
  // the concrete model before it is stored, or moving the slot would retarget
  // the conversation — the bug the binding prevents.
  test.each(["alias:fast", "fast"])("a slot reference (%s) is resolved before it is stored", async (
    slotRef,
  ) => {
    runtime.updateConfig({ models: { default: MODEL_A, fast: FAST_MODEL } });
    const conv = await runtime.chat({
      message: "via slot",
      model: slotRef,
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });

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

    // On the event format a rename appends a `metadata.title` event and leaves
    // line 1 alone, so this passes today by construction. It is a forward
    // guard: the pin lives on line 1, and the legacy path (`appendLegacyFormat`)
    // does rewrite that line, so a rename that ever moves to rewriting must not
    // drop the field.
    const store = await runtime.resolveConversationStore(conv.conversationId);
    await store!.update(conv.conversationId, { title: "renamed" });

    expect(await pinOf(conv.conversationId)).toBe(MODEL_A);
  });

  test("the title call runs on the fast slot, not the conversation's model", async () => {
    // Title generation runs outside the agentic loop on the `fast` slot and
    // records itself as an `aux.usage` event. A refactor that routed auxiliary
    // calls through the pin would change cost silently and put title generation
    // on a model the fast slot never selected.
    runtime.updateConfig({ models: { default: MODEL_A, fast: FAST_MODEL } });
    const conv = await runtime.chat({
      message: "one",
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });

    // The title call is fire-and-forget; wait for its event to land.
    const store = await runtime.resolveConversationStore(conv.conversationId);
    const titleUsage = await waitForAuxUsage(store!, conv.conversationId, "title");

    expect(titleUsage.model).toBe(FAST_MODEL);
    expect(await pinOf(conv.conversationId)).toBe(MODEL_A);
  });
});

describe("conversations that predate the binding", () => {
  test("an unpinned conversation resolves from current config", async () => {
    // A genuine pre-feature record: created through the store with no model,
    // so line 1 on disk has no `model` field. Deleting the field off a loaded
    // object would prove nothing — `load()` re-reads the file every call.
    const seed = await runtime.chat({
      message: "seed",
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });
    const store = await runtime.resolveConversationStore(seed.conversationId);
    const legacy = await store!.create({
      ownerId: USER.id,
      workspaceId: TEST_WORKSPACE_ID,
    });
    expect(legacy.model).toBeUndefined();

    runtime.updateConfig({ models: { default: MODEL_B } });
    await runtime.chat({
      message: "resumed",
      conversationId: legacy.id,
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });

    // No pin to honor, so the turn follows current config — today's behavior,
    // unchanged. The binding must not retroactively invent one.
    expect(await modelsUsed(legacy.id)).toEqual([MODEL_B]);
    expect(await pinOf(legacy.id)).toBeUndefined();
  });
});

describe("the detached-turn path", () => {
  test("a conversation created by startTurn is bound like any other", async () => {
    // `/v1/chat/start` → `startTurn` is the web client's chat path, and it
    // creates the conversation before delegating to `chat()` — so its own
    // `createOpts` is the only thing that binds a web-created conversation.
    runtime.updateConfig({ models: { default: MODEL_A } });
    const { conversationId } = await runtime.startTurn({
      message: "one",
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });
    await waitFor(() => !runtime.isTurnActive(conversationId));

    expect(await pinOf(conversationId)).toBe(MODEL_A);

    runtime.updateConfig({ models: { default: MODEL_B } });
    await runtime.chat({
      message: "two",
      conversationId,
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });

    expect(await modelsUsed(conversationId)).toEqual([MODEL_A]);
  });
});

describe("whose model the pin captures", () => {
  // The tint that lets a person's model preference outrank the org default
  // reads identity from the turn's request context. Both chat doors resolve
  // the binding before that context existed, so the pin took the org default
  // and the preference only ever changed what tools reported — never the model
  // the turn ran on.
  const PICKY: UserIdentity = {
    id: "usr_picky",
    email: "picky@example.com",
    displayName: "Picky",
    orgRole: "member",
    preferences: { models: { default: MODEL_B } },
  };

  test("a person's profile preference binds the conversation, not the org default", async () => {
    runtime.updateConfig({ models: { default: MODEL_A } });
    await runtime.getWorkspaceStore().addMember(TEST_WORKSPACE_ID, PICKY.id, "member");

    const conv = await runtime.chat({
      message: "which model am I on",
      workspaceId: TEST_WORKSPACE_ID,
      identity: PICKY,
    });

    expect(await pinOf(conv.conversationId)).toBe(MODEL_B);
    // And the turn actually ran on it — a pin the engine ignores is no better
    // than no pin.
    expect(await modelsUsed(conv.conversationId)).toEqual([MODEL_B]);
  });

  test("someone without a preference still gets the org default", async () => {
    runtime.updateConfig({ models: { default: MODEL_A } });

    const conv = await runtime.chat({
      message: "no preference here",
      workspaceId: TEST_WORKSPACE_ID,
      identity: USER,
    });

    expect(await pinOf(conv.conversationId)).toBe(MODEL_A);
  });

  test("the detached-start door binds the same way", async () => {
    runtime.updateConfig({ models: { default: MODEL_A } });

    const { conversationId } = await runtime.startTurn({
      message: "started detached",
      workspaceId: TEST_WORKSPACE_ID,
      identity: PICKY,
    });

    expect(await pinOf(conversationId)).toBe(MODEL_B);
  });
});
