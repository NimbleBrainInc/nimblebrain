/**
 * A first turn's title starts with the turn, from the person's message alone,
 * and runs beside it: the turn waits for nothing the title does.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import type { EngineEvent, EngineEventOf } from "../../../src/engine/types.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { devProvider } from "../../helpers/dev-provider.ts";
import { createMockModel, isTitleCall } from "../../helpers/mock-model.ts";

const testDir = join(tmpdir(), `nb-title-with-turn-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

const ALICE = {
  id: "usr_alice",
  email: "alice@example.com",
  displayName: "Alice Liddell",
  orgRole: "member" as const,
  preferences: {},
};

const REPLY = "The reply only the turn writes";

function userText(options: LanguageModelV4CallOptions): string {
  return options.prompt
    .filter((m) => m.role === "user")
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("\n");
}

describe("the first turn's title", () => {
  it("starts before the turn ends, holds nothing up, and is written from the message alone", async () => {
    let titleStarted!: () => void;
    const started = new Promise<void>((r) => {
      titleStarted = r;
    });
    let releaseTitle!: () => void;
    const released = new Promise<void>((r) => {
      releaseTitle = r;
    });
    let titleInput = "";

    const model = createMockModel(
      async (options) => {
        if (isTitleCall(options)) {
          titleInput = userText(options);
          titleStarted();
          await released;
          return { content: [{ type: "text", text: "Planning The Garden" }] };
        }
        // The turn answers only once the title has started: a title that
        // waited for the turn would never start, and this would time out.
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("the title did not start during the turn")), 3000),
        );
        await Promise.race([started, timeout]);
        return { content: [{ type: "text", text: REPLY }] };
      },
      { scriptTitles: true },
    );

    const events: EngineEvent[] = [];
    const workDir = join(testDir, "concurrent");
    mkdirSync(workDir, { recursive: true });
    const runtime = await Runtime.start({
      identityProvider: devProvider,
      languageModel: model,
      logging: { disabled: true },
      workDir,
      events: [{ emit: (e) => events.push(e) }],
    });
    const ws = await runtime.getWorkspaceStore().create("Alice's", {
      members: [{ userId: ALICE.id, role: "admin" }],
    });

    // The turn completes while the title call is still unanswered.
    const res = await runtime.chat({
      message: "help me plan the garden",
      identity: ALICE,
      workspaceId: ws.id,
    });
    expect(res.response).toContain(REPLY);
    const isTitle = (e: EngineEvent): e is EngineEventOf<"conversation.title"> =>
      e.type === "conversation.title" && e.data.conversationId === res.conversationId;
    expect(events.some(isTitle)).toBe(false);

    expect(titleInput).toContain("help me plan the garden");
    expect(titleInput).not.toContain(REPLY);
    expect(titleInput).not.toContain("<assistant-message>");

    releaseTitle();
    const deadline = Date.now() + 3000;
    let title: EngineEventOf<"conversation.title"> | undefined;
    while (!title && Date.now() < deadline) {
      title = events.find(isTitle);
      if (!title) await new Promise((r) => setTimeout(r, 25));
    }
    expect(title?.data.title).toBe("Planning The Garden");

    await runtime.shutdown();
  });
});
