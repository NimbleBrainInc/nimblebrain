/**
 * A task names the skills its runs need, and every run is given them in full
 * before its first model call — never left to the model choosing to load them.
 *
 * Covers the run-start door (`executeTask` with `skills`): the body rides the
 * opening message, a declared skill bound to a tool is not held for again, an
 * unknown name refuses the run before any model call, and the run reports what
 * it was given (`skillsDelivered`). Also: a run limited by `allowedTools` can
 * still open the skill catalog.
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
import { McpSource } from "../../src/tools/mcp-source.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { type RemoteMcpFixture, startRemoteMcpServer } from "../helpers/remote-mcp-fixture.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const SERVER = "ai-nimblebrain-fixture-ledger";
const RECORD = `${SERVER}__record`;
const RUNBOOK_MARKER = "RUNBOOK-STEPS-MARKER";
const BOUND_MARKER = "RECORD-RULES-MARKER";

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
  try {
    await source.stop();
  } catch {
    // already stopped
  }
  server.close();
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("a task's declared skills", () => {
  it("reach the model in the opening message, before its first model call", async () => {
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
    expect(first).toContain(BOUND_MARKER);
    expect(first).toContain("load it with `nb__use_skill`");
    // The bound skill was declared, so its tool's first call is not held for it.
    expect(prompts.some((p) => promptText(p).includes(`Not run: ${RECORD}`))).toBe(false);
    expect(executed).toBe(1);
    expect(result.skillsDelivered).toEqual([
      { name: "ledger-runbook", loadedBy: "declared" },
      { name: "record-rules", loadedBy: "declared" },
    ]);
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
});
