/**
 * The event-sourced store honors the model binding. The `ConversationStore`
 * providers are held to it by the conformance suite
 * (`test/unit/conversation/store-conformance.test.ts`).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventSourcedConversationStore } from "../../../src/conversation/event-sourced-store.ts";
import { ConversationCorruptedError } from "../../../src/runtime/errors.ts";

const MODEL = "nebius:moonshotai/Kimi-K2.6";
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "nb-model-pin-stores-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("EventSourcedConversationStore", () => {
  test("create carries the model binding", async () => {
    const store = new EventSourcedConversationStore({ dir: tempDir() });
    const conversation = await store.create({ ownerId: "usr_test", model: MODEL });
    expect(conversation.model).toBe(MODEL);

    // And it survives the round trip, since the binding is read back on every
    // turn rather than held in memory.
    const loaded = await store.load(conversation.id);
    expect(loaded?.model).toBe(MODEL);
  });
});

describe("EventSourcedConversationStore — a header without a model", () => {
  test("is refused as conversation_corrupted, not run unbound", async () => {
    const dir = tempDir();
    const store = new EventSourcedConversationStore({ dir });
    const conversation = await store.create({ ownerId: "usr_test", model: MODEL });
    const path = join(dir, `${conversation.id}.jsonl`);
    const [header, ...rest] = readFileSync(path, "utf8").split("\n");
    const { model: _model, ...unbound } = JSON.parse(header as string);
    writeFileSync(path, [JSON.stringify(unbound), ...rest].join("\n"));

    const error = await store.load(conversation.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConversationCorruptedError);
    expect((error as ConversationCorruptedError).reason).toBe("missing_model");
  });
});
