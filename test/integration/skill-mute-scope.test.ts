/**
 * Muting a skill steers ONE conversation and edits nothing.
 *
 * `skills__deactivate` used to write `status: disabled` into the skill's file.
 * That file is read by every conversation the user has, in every workspace, so
 * one chat's "not right now" silently reconfigured all the others — an operator
 * disabled a skill in one campaign and found it back on in another, because a
 * third conversation had flipped it. Nothing told them.
 *
 * The first test here is the whole point: deactivate in A, compose in B, assert
 * B is unchanged. The rest pin that the mute survives a resume of its own
 * conversation, that a new conversation starts clean, and that the durable file
 * is untouched.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { extractText } from "../../src/engine/content-helpers.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

const SKILL_NAME = "house-voice";
const MARKER = "VOICE-MARKER-WHISKEY";

const testDir = join(tmpdir(), `nimblebrain-skill-mute-${Date.now()}`);
let runtime: Runtime;
let lastPrompt: LanguageModelV3CallOptions["prompt"] | undefined;
let skillPath = "";

/**
 * Model that captures the composed prompt, and — when the user message names a
 * tool — issues that tool call. Driving the mute through a real engine run is
 * required, not incidental: the handler returns a `_meta` marker and the ENGINE
 * turns it into the conversation event. A registry call made outside a run
 * would never persist anything.
 */
function capturingModel(): LanguageModelV3 {
  return createMockModel((options) => {
    const system = options.prompt.find((m) => m.role === "system");
    const isTitle =
      typeof system?.content === "string" && system.content.includes("Generate a 3-6 word title");
    if (!isTitle) lastPrompt = options.prompt;

    const text = options.prompt
      .filter((m) => m.role === "user")
      .map((m) =>
        typeof m.content === "string"
          ? m.content
          : m.content.map((p) => ("text" in p ? p.text : "")).join(" "),
      )
      .join("\n");
    const last = text.split("\n").pop() ?? "";

    if (!isTitle && pendingCall && last.includes(pendingCall.trigger)) {
      const call = pendingCall;
      pendingCall = null;
      return {
        content: [
          {
            type: "tool-call" as const,
            toolCallId: `tc-${Math.random().toString(36).slice(2)}`,
            toolName: call.tool,
            input: JSON.stringify({ id: SKILL_NAME }),
          },
        ],
        finishReason: "tool-calls" as const,
        inputTokens: 10,
        outputTokens: 5,
      };
    }
    return { content: [{ type: "text" as const, text: "ok" }], inputTokens: 10, outputTokens: 5 };
  });
}

/** Set before a chat turn to make the model issue that tool call on it. */
let pendingCall: { trigger: string; tool: string } | null = null;

function promptText(): string {
  if (!lastPrompt) return "";
  return lastPrompt
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content.map((p) => ("text" in p ? p.text : "")).join(" "),
    )
    .join("\n");
}

async function callTool(name: string, input: Record<string, unknown>) {
  const registry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
  const result = await runWithRequestContext(
    { identity: null, workspaceId: TEST_WORKSPACE_ID },
    () => registry.execute({ id: `t-${Math.random()}`, name, input }),
  );
  return { content: extractText(result.content), isError: result.isError ?? false };
}

/** Drive a mute/un-mute the way the agent does: a tool call inside a run. */
async function muteViaAgent(
  tool: "skills__deactivate" | "skills__activate",
  conversationId?: string,
): Promise<string> {
  pendingCall = { trigger: "PLEASE-TOGGLE", tool };
  const id = await chat("PLEASE-TOGGLE", conversationId);
  pendingCall = null;
  return id;
}

/** Send a turn, returning the conversation id. */
async function chat(message: string, conversationId?: string): Promise<string> {
  const res = await runtime.chat({
    workspaceId: TEST_WORKSPACE_ID,
    message,
    ...(conversationId ? { conversationId } : {}),
  });
  return res.conversationId;
}

beforeAll(async () => {
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: capturingModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
    telemetry: { enabled: false },
  });
  await provisionTestWorkspace(runtime);

  const created = await callTool("skills__create", {
    scope: "workspace",
    manifest: { name: SKILL_NAME, description: "House voice", loadingStrategy: "always" },
    body: `${MARKER} — always speak in the house voice.`,
  });
  expect(created.isError).toBe(false);
  const listed = await callTool("skills__list", {});
  const m = /(\/\S*house-voice\.md)/.exec(listed.content);
  skillPath = m?.[1] ?? "";
});

afterAll(async () => {
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe("muting a skill is conversation-scoped", () => {
  it("composes the skill in a fresh conversation (baseline)", async () => {
    await chat("hello");
    expect(promptText()).toContain(MARKER);
  });

  it("deactivating in conversation A leaves conversation B untouched", async () => {
    const convA = await chat("first turn in A");
    await muteViaAgent("skills__deactivate", convA);

    // A is muted from the next turn.
    await chat("second turn in A", convA);
    expect(promptText()).not.toContain(MARKER);

    // B — a different conversation — still gets it. This is the regression.
    const convB = await chat("first turn in B");
    expect(promptText()).toContain(MARKER);
    expect(convB).not.toBe(convA);
  });

  it("the mute survives a resume of its own conversation", async () => {
    const conv = await chat("turn one");
    await muteViaAgent("skills__deactivate", conv);
    await chat("turn two", conv);
    expect(promptText()).not.toContain(MARKER);
    // Resume again later in the same conversation.
    await chat("turn three", conv);
    expect(promptText()).not.toContain(MARKER);
  });

  it("activate un-mutes the same conversation", async () => {
    const conv = await chat("start");
    await muteViaAgent("skills__deactivate", conv);
    await chat("now muted", conv);
    expect(promptText()).not.toContain(MARKER);

    await muteViaAgent("skills__activate", conv);
    await chat("now restored", conv);
    expect(promptText()).toContain(MARKER);
  });

  it("writes nothing to the skill file — the durable status is untouched", async () => {
    const conv = await chat("a turn");
    const before = readFileSync(skillPath, "utf-8");
    await muteViaAgent("skills__deactivate", conv);
    expect(readFileSync(skillPath, "utf-8")).toBe(before);
    expect(before).toContain("status: active");
  });

  it("rejects an unknown name instead of silently muting nothing", async () => {
    const conv = await chat("a turn");
    const res = await callTool("skills__deactivate", { id: "no-such-skill" });
    // No conversation in scope: the refusal names the reason rather than
    // reporting a success that changed nothing.
    expect(res.isError).toBe(true);
    expect(res.content).toContain("only works inside a chat");
  });
});
