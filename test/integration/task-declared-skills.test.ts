/**
 * A task names the skills its runs need, and every run is given them in full
 * before its first model call — never left to the model choosing to load them.
 *
 * Covers the run-start door (`executeTask` with `skills`): the body rides the
 * stable, cached system prompt that runs with different inputs share, a
 * declared skill the turn already composes reaches the model once and is not
 * held for again, an unknown name or an unreadable body fails
 * the run before any model call, and the run reports what it was given
 * (`skillsDelivered`). Also: a run limited by `allowedTools` can still open the
 * skill catalog.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { Server } from "@modelcontextprotocol/server";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { extractText } from "../../src/engine/content-helpers.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { DeclaredSkillsUnavailableError } from "../../src/runtime/errors.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { connectorSkillManifestName } from "../../src/skills/connector-skills.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { type RemoteMcpFixture, startRemoteMcpServer } from "../helpers/remote-mcp-fixture.ts";
import {
  handleSkillsList,
  SKILLS_EXTENSION_CAPABILITY,
  skillEntryFor,
} from "../helpers/skills-server.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const SERVER = "ai-nimblebrain-fixture-ledger";
const RECORD = `${SERVER}__record`;
const RUNBOOK_MARKER = "RUNBOOK-STEPS-MARKER";
const BOUND_MARKER = "RECORD-RULES-MARKER";
const ALWAYS_MARKER = "HOUSE-STYLE-MARKER";
const UNREADABLE_SERVER = "ai-nimblebrain-fixture-unreadable";
const UNREADABLE_SKILL = connectorSkillManifestName(UNREADABLE_SERVER, "unreadable-guide");

let prompts: LanguageModelV4CallOptions["prompt"][] = [];
let executed = 0;

function createFixtureServer(): Server {
  const server = new Server({ name: "ledger", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", async () => ({
    tools: [
      {
        name: "record",
        description: "Record an entry",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));
  server.setRequestHandler("tools/call", async () => {
    executed += 1;
    return { content: [{ type: "text", text: "recorded" }] };
  });
  return server;
}

/** Lists one catalog skill and throws on every read of its body. */
function createUnreadableServer(): Server {
  const server = new Server(
    { name: "unreadable", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {}, ...SKILLS_EXTENSION_CAPABILITY } },
  );
  server.setRequestHandler("tools/list", async () => ({ tools: [] }));
  handleSkillsList(server, () => ({
    skills: [
      skillEntryFor(
        "skill://unreadable-guide/SKILL.md",
        "---\nname: unreadable-guide\ndescription: Guidance that cannot be read.\n---\n\nUnreachable.",
      ),
    ],
  }));
  server.setRequestHandler("resources/read", async () => {
    throw new Error("resources/read is unavailable");
  });
  return server;
}

/** How many times `needle` occurs in `text`. */
function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function promptText(p: LanguageModelV4CallOptions["prompt"]): string {
  return p
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content
            .map((c) =>
              "text" in c
                ? c.text
                : c.type === "tool-result" && "value" in c.output
                  ? String(c.output.value)
                  : "",
            )
            .join(" "),
    )
    .join("\n");
}

/** Calls `record` once, then answers. A held call would show as "Not run". */
function recordingModel() {
  return createMockModel((options) => {
    prompts.push(options.prompt);
    const lastTool = options.prompt.findLast((m) => m.role === "tool");
    if (lastTool) return { content: [{ type: "text", text: "Done." }] };
    return {
      content: [{ type: "tool-call", toolCallId: "call-1", toolName: RECORD, input: "{}" }],
      finishReason: "tool-calls",
    };
  });
}

const testDir = join(tmpdir(), `nimblebrain-task-declared-skills-${Date.now()}`);
let runtime: Runtime;
let source: McpSource;
let server: RemoteMcpFixture;
let unreadableSource: McpSource;
let unreadableServer: RemoteMcpFixture;

async function createWorkspaceSkill(manifest: Record<string, unknown>, body: string) {
  const registry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
  const created = await runWithRequestContext(
    { identity: DEV_IDENTITY, workspaceId: TEST_WORKSPACE_ID },
    () =>
      registry.execute({
        id: `create-${String(manifest.name)}`,
        name: "skills__create",
        input: { scope: "workspace", manifest, body },
      }),
  );
  expect(created.isError, extractText(created.content)).toBeFalsy();
}

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: recordingModel(),
    logging: { disabled: true },
    workDir: testDir,
    telemetry: { enabled: false },
  });
  await provisionTestWorkspace(runtime);
  server = startRemoteMcpServer(createFixtureServer);
  source = new McpSource(
    SERVER,
    { type: "remote", url: new URL(server.url), allowInsecure: true },
    new NoopEventSink(),
  );
  await source.start();
  runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(source);
  unreadableServer = startRemoteMcpServer(createUnreadableServer);
  unreadableSource = new McpSource(
    UNREADABLE_SERVER,
    { type: "remote", url: new URL(unreadableServer.url), allowInsecure: true },
    new NoopEventSink(),
  );
  await unreadableSource.start();
  runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(unreadableSource);

  // Catalog-only: nothing but the task's declaration delivers it.
  await createWorkspaceSkill(
    { name: "ledger-runbook", description: "How we keep the ledger." },
    `${RUNBOOK_MARKER} — reconcile before recording.`,
  );
  // Bound to the tool the run calls: without the declaration, the call is held for it.
  await createWorkspaceSkill(
    { name: "record-rules", description: "Rules for recording.", toolAffinity: [RECORD] },
    `${BOUND_MARKER} — one entry per call.`,
  );
});

afterAll(async () => {
  for (const s of [source, unreadableSource]) {
    try {
      await s.stop();
    } catch {
      // already stopped
    }
  }
  server.close();
  unreadableServer.close();
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("a task's declared skills", () => {
  it("reach the model in the system prompt, before its first model call", async () => {
    prompts = [];
    executed = 0;
    const result = await runtime.executeTask({
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      prompt: "Record today's entry.",
      // Narrowed to the one tool: the catalog stays reachable all the same.
      allowedTools: [RECORD],
      skills: ["ledger-runbook", "record-rules"],
    });

    const first = promptText(prompts[0] ?? []);
    expect(first).toContain(RUNBOOK_MARKER);
    // A declared bound skill composes once, by its declaration.
    expect(occurrences(first, BOUND_MARKER)).toBe(1);
    expect(first).toContain("load it with `nb__use_skill`");
    // The bound skill was declared, so its tool's first call is not held for it.
    expect(prompts.some((p) => promptText(p).includes(`Not run: ${RECORD}`))).toBe(false);
    expect(executed).toBe(1);
    expect(result.skillsDelivered).toEqual([
      { name: "ledger-runbook", loadedBy: "declared" },
      { name: "record-rules", loadedBy: "declared" },
    ]);
  });

  it("sit in the cached system prefix, shared by runs with different inputs", async () => {
    // A batch runs one task over many inputs. The declared bodies are the same
    // every run, so they belong in the prefix the system breakpoint caches,
    // not in the opening message, whose only breakpoint falls after the run's
    // own input and so is never matched by another run.
    const firstCall = async (prompt: string) => {
      prompts = [];
      await runtime.executeTask({
        identity: DEV_IDENTITY,
        workspaceId: TEST_WORKSPACE_ID,
        prompt,
        allowedTools: [RECORD],
        skills: ["ledger-runbook"],
      });
      return prompts[0] ?? [];
    };
    const a = await firstCall("Record the entry for account one.");
    const b = await firstCall("Record the entry for account two.");

    const systemOf = (p: LanguageModelV4CallOptions["prompt"]) =>
      p.find((m) => m.role === "system");
    const sysA = systemOf(a);
    const sysB = systemOf(b);
    expect(sysA?.content).toContain(RUNBOOK_MARKER);
    expect(sysA?.content).toBe(sysB?.content as string);
    expect(sysA?.providerOptions?.anthropic?.cacheControl).toBeDefined();
    // One copy: the opening message carries the input, not the body again.
    const opening = a.findLast((m) => m.role === "user");
    expect(promptText(opening ? [opening] : [])).not.toContain(RUNBOOK_MARKER);
  });

  it("refuse the run before any model call when one is not offered", async () => {
    prompts = [];
    await expect(
      runtime.executeTask({
        identity: DEV_IDENTITY,
        workspaceId: TEST_WORKSPACE_ID,
        prompt: "Record today's entry.",
        skills: ["ledger-runbook", "no-such-skill"],
      }),
    ).rejects.toBeInstanceOf(DeclaredSkillsUnavailableError);
    expect(prompts).toHaveLength(0);
  });

  it("are reported per run, with a held delivery when the task declares nothing", async () => {
    prompts = [];
    executed = 0;
    // Unnarrowed, the fixture's tool is proxied at turn start, so nothing
    // composes its bound skill up front and the first call is held for it.
    const result = await runtime.executeTask({
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      prompt: "Record today's entry.",
    });
    expect(result.skillsDelivered).toEqual([{ name: "record-rules", loadedBy: "before_call" }]);
  });

  it("fail the run before any model call when a body cannot be fetched", async () => {
    prompts = [];
    await expect(
      runtime.executeTask({
        identity: DEV_IDENTITY,
        workspaceId: TEST_WORKSPACE_ID,
        prompt: "Record today's entry.",
        skills: [UNREADABLE_SKILL],
      }),
    ).rejects.toThrow(`Declared skill "${UNREADABLE_SKILL}" could not be fetched`);
    expect(prompts).toHaveLength(0);
  });

  it("add nothing for a name the turn already composes as `always`", async () => {
    await createWorkspaceSkill(
      { name: "house-style", description: "House style.", loadingStrategy: "always" },
      `${ALWAYS_MARKER} — plain words.`,
    );
    prompts = [];
    const result = await runtime.executeTask({
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      prompt: "Record today's entry.",
      allowedTools: [RECORD],
      skills: ["house-style"],
    });
    expect(occurrences(promptText(prompts[0] ?? []), ALWAYS_MARKER)).toBe(1);
    expect(result.skillsDelivered.some((d) => d.loadedBy === "declared")).toBe(false);
  });
});
