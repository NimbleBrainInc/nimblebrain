/**
 * A skill the agent writes never loads into a later conversation on its own.
 *
 * Conversation 1 is an agent (as an injected one would) trying every way to
 * make a skill load without the model choosing it: an empty trigger (matches
 * every message), a near-universal tool glob, and an on-request skill updated
 * to `tool-affinity: ["*"]`. Each write is refused, so conversation 2 (a plain
 * answer) and conversation 3 (one tool call) never carry those bodies. An
 * on-request skill is still saved, and the catalog lists it.
 */

import { afterAll, beforeAll, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const TRIGGER_MARKER = "AGENT-EMPTY-TRIGGER-MARKER";
const GLOB_MARKER = "AGENT-GLOB-AFFINITY-MARKER";
const UPDATED_MARKER = "AGENT-UPDATED-TO-STAR-MARKER";

const testDir = join(tmpdir(), `nimblebrain-skill-agent-auto-load-${Date.now()}`);
const skillsDir = join(testDir, "users", DEV_IDENTITY.id, "skills");
const seen: string[] = [];
let runtime: Runtime;

function create(id: string, manifest: Record<string, unknown>, body: string) {
  return {
    toolCalls: [
      {
        toolCallId: id,
        toolName: "skills__create",
        input: JSON.stringify({ scope: "user", manifest, body }),
      },
    ],
  };
}

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  const base = createEchoModel({
    responses: [
      // Conversation 1: the agent's writes, then its answer and the title. The
      // first skills call is held until the authoring guide is read, then retried.
      create("c0", { name: "every-message", description: "x", triggers: [""] }, TRIGGER_MARKER),
      create("c1", { name: "every-message", description: "x", triggers: [""] }, TRIGGER_MARKER),
      create("c2", { name: "every-tool", description: "x", toolAffinity: ["*_*"] }, GLOB_MARKER),
      create("c3", { name: "widened", description: "A procedure" }, UPDATED_MARKER),
      {
        toolCalls: [
          {
            toolCallId: "u1",
            toolName: "skills__update",
            input: JSON.stringify({
              id: join(skillsDir, "widened.md"),
              manifest: { toolAffinity: ["*"] },
            }),
          },
        ],
      },
      { text: "saved" },
      { text: "title one" },
      // Conversation 2: a plain answer, no tool call.
      { text: "plain answer" },
      { text: "title two" },
      // Conversation 3: one tool call.
      { toolCalls: [{ toolCallId: "s1", toolName: "nb__status", input: "{}" }] },
      { text: "done" },
      { text: "title three" },
    ],
  });
  const model = {
    ...base,
    doStream: (o: LanguageModelV4CallOptions) => {
      seen.push(JSON.stringify(o.prompt));
      return base.doStream(o);
    },
    doGenerate: (o: LanguageModelV4CallOptions) => {
      seen.push(JSON.stringify(o.prompt));
      return base.doGenerate(o);
    },
  } as typeof base;
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: model,
    logging: { disabled: true },
    workDir: testDir,
    telemetry: { enabled: false },
  });
  await provisionTestWorkspace(runtime);
});

afterAll(async () => {
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

it("refuses every auto-loading write from the agent, and saves the on-request one", async () => {
  const c1 = await runtime.chat({
    identity: DEV_IDENTITY,
    workspaceId: TEST_WORKSPACE_ID,
    message: "save these as skills",
  });
  const store = await runtime.resolveConversationStore(
    TEST_WORKSPACE_ID,
    c1.conversationId,
    DEV_IDENTITY.id,
  );
  const events = (await store?.readEvents(c1.conversationId)) ?? [];
  const refusals = events.filter(
    (e) =>
      (e as { type: string }).type === "tool.done" &&
      JSON.stringify(e).includes("Not saved: this skill would load on its own"),
  );
  // The empty trigger, the glob, and the update to `*`.
  expect(refusals).toHaveLength(3);

  expect(existsSync(join(skillsDir, "every-message.md"))).toBe(false);
  expect(existsSync(join(skillsDir, "every-tool.md"))).toBe(false);
  const widened = readFileSync(join(skillsDir, "widened.md"), "utf-8");
  expect(widened).not.toContain("tool-affinity");
});

it("a later conversation never carries those bodies, with or without a tool call", async () => {
  const before = seen.length;
  await runtime.chat({
    identity: DEV_IDENTITY,
    workspaceId: TEST_WORKSPACE_ID,
    message: "what time is it",
  });
  await runtime.chat({
    identity: DEV_IDENTITY,
    workspaceId: TEST_WORKSPACE_ID,
    message: "status please",
  });
  const later = seen.slice(before).join("\n");
  expect(later.length).toBeGreaterThan(0);
  expect(later).not.toContain(TRIGGER_MARKER);
  expect(later).not.toContain(GLOB_MARKER);
  expect(later).not.toContain(UPDATED_MARKER);
});
