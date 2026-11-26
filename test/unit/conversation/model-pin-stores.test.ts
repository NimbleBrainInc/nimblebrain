/**
 * `CreateConversationOptions.model` is the conversation's binding, so the store
 * the runtime writes through (the conversations contract, here over the built-in
 * plugin in process) carries it to the stored conversation and back on every
 * load. A stored conversation with no model is not run unbound: it is
 * `ConversationCorruptedError`, which the API answers `422 conversation_corrupted`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationCorruptedError } from "../../../src/runtime/errors.ts";
import { conversationStore } from "../../helpers/conversation-store.ts";

const MODEL = "nebius:moonshotai/Kimi-K2.6";
const WORKSPACE = "ws_0076759dbbe19fcc";
const OWNER = "usr_test";
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "nb-model-pin-stores-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("the contract store", () => {
  test("create carries the model binding, and a load reads it back", async () => {
    const store = conversationStore(tempDir(), WORKSPACE, OWNER);
    const conversation = await store.create({ ownerId: OWNER, model: MODEL });
    expect(conversation.model).toBe(MODEL);
    expect((await store.load(conversation.id))?.model).toBe(MODEL);
  });

  test("a stored conversation with no model is refused as conversation_corrupted", async () => {
    const dir = tempDir();
    const store = conversationStore(dir, WORKSPACE, OWNER);
    const conversation = await store.create({ ownerId: OWNER, model: MODEL });
    const path = join(
      dir,
      "workspaces",
      WORKSPACE,
      "conversations",
      OWNER,
      `${conversation.id}.jsonl`,
    );
    const [header, ...rest] = readFileSync(path, "utf8").split("\n");
    const { model: _model, ...unbound } = JSON.parse(header as string);
    writeFileSync(path, [JSON.stringify(unbound), ...rest].join("\n"));

    const error = await store.load(conversation.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConversationCorruptedError);
    expect((error as ConversationCorruptedError).conversationId).toBe(conversation.id);
    // Absent stays absent: only a conversation that is there and unreadable is corrupted.
    expect(await store.load("conv_0123456789abcdef")).toBeNull();
  });
});
