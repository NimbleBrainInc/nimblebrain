/**
 * A skill bound to a tool is in the model's context before that tool's first
 * call executes — in chat and in a task run, and for every source: a fixture
 * bundle's own published skill and a workspace skill bound to the bundle's tool
 * reach the model on the same call.
 *
 * At the moment the fixture server executes `draft_email`, the prompt the model
 * acted on must already carry both bodies; delivering the guidance after the
 * call does not satisfy it. A turn that never calls the tool composes neither
 * body, so the cached system prefix is the same whatever tools the turn starts
 * with.
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
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { type RemoteMcpFixture, startRemoteMcpServer } from "../helpers/remote-mcp-fixture.ts";
import { SKILLS_EXTENSION_CAPABILITY, serveSkills } from "../helpers/skills-server.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const SERVER = "ai-nimblebrain-fixture-outreach";
const DRAFT = `${SERVER}__draft_email`;
const BUNDLE_MARKER = "BUNDLE-DRAFTING-RULES-MARKER";
const TENANT_MARKER = "TENANT-COPY-RULES-MARKER";
const GREETING = "hey there";

const SKILL_URI = "skill://drafting/SKILL.md";
const SKILL_MD = [
  "---",
  "name: drafting",
  "description: How to draft outreach email.",
  "metadata:",
  "  nimblebrain:",
  "    tool-affinity:",
  "      - draft_email",
  "---",
  "",
  `# Drafting\n\n${BUNDLE_MARKER}`,
].join("\n");

/** The bundle's guide: listed first, so it rides `<app-guide>` when the app is focused. */
const GUIDE_URI = "skill://outreach/SKILL.md";
const GUIDE_MARKER = "BUNDLE-APP-GUIDE-MARKER";
const GUIDE_MD = [
  "---",
  "name: outreach",
  "description: What the outreach app does.",
  "metadata:",
  "  nimblebrain:",
  "    tool-affinity: []",
  "---",
  "",
  `# Outreach\n\n${GUIDE_MARKER}`,
].join("\n");

/** Prompts the model was called with, and the prompt index each execution followed. */
let prompts: LanguageModelV4CallOptions["prompt"][] = [];
let executedAfterPrompt: number[] = [];

function createFixtureServer(): Server {
  const bodies: Record<string, string> = { [GUIDE_URI]: GUIDE_MD, [SKILL_URI]: SKILL_MD };
  const server = new Server(
    { name: "outreach", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {}, ...SKILLS_EXTENSION_CAPABILITY } },
  );
  server.setRequestHandler("tools/list", async () => ({
    tools: [
      {
        name: "draft_email",
        description: "Draft an email",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));
  server.setRequestHandler("tools/call", async () => {
    executedAfterPrompt.push(prompts.length - 1);
    return { content: [{ type: "text", text: "drafted" }] };
  });
  serveSkills(server, () => bodies);
  server.setRequestHandler("resources/read", async (r) => {
    const text = bodies[r.params.uri];
    if (!text) throw new Error(`Resource not found: ${r.params.uri}`);
    return { contents: [{ uri: r.params.uri, mimeType: "text/markdown", text }] };
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

/** Calls `draft_email` until it runs (re-issuing a held call), then answers. */
function draftingModel() {
  return createMockModel((options) => {
    prompts.push(options.prompt);
    const system = options.prompt.find((m) => m.role === "system");
    if (
      typeof system?.content === "string" &&
      system.content.includes("Generate a 3-6 word title")
    ) {
      return { content: [{ type: "text", text: "title" }] };
    }
    const lastTool = options.prompt.findLast((m) => m.role === "tool");
    const ran = lastTool !== undefined && promptText([lastTool]).includes("drafted");
    if (ran) return { content: [{ type: "text", text: "Drafted the email." }] };
    // A greeting calls no tool.
    const lastUser = options.prompt.findLast((m) => m.role === "user");
    if (lastUser && promptText([lastUser]).includes(GREETING)) {
      return { content: [{ type: "text", text: "Hello." }] };
    }
    return {
      content: [
        {
          type: "tool-call",
          toolCallId: `call-${prompts.length}`,
          toolName: DRAFT,
          input: "{}",
        },
      ],
      finishReason: "tool-calls",
    };
  });
}

const testDir = join(tmpdir(), `nimblebrain-skill-before-call-${Date.now()}`);
let runtime: Runtime;
let source: McpSource;
let server: RemoteMcpFixture;

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: draftingModel(),
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
  const registry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
  registry.addSource(source);

  // The tenant's own copy rules, bound to the bundle's drafting tool.
  const created = await runWithRequestContext(
    { identity: DEV_IDENTITY, workspaceId: TEST_WORKSPACE_ID },
    () =>
      registry.execute({
        id: "create-tenant-skill",
        name: "skills__create",
        input: {
          scope: "workspace",
          manifest: {
            name: "tenant-copy-rules",
            description: "Our house rules for outbound copy.",
            toolAffinity: [DRAFT],
          },
          body: `${TENANT_MARKER} — sign every email with the team name.`,
        },
      }),
  );
  expect(created.isError, extractText(created.content)).toBeFalsy();
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

/** The prompt the model acted on when `draft_email` first executed. */
function promptAtFirstExecution(): string {
  const at = executedAfterPrompt[0];
  expect(at).toBeDefined();
  return promptText(prompts[at as number] ?? []);
}

describe("a bound skill governs its tool's first call", () => {
  it("in chat with the tool proxied: both bodies precede the first execution", async () => {
    prompts = [];
    executedAfterPrompt = [];
    // `nb__*` leaves the bundle's tool out of the turn-start set, so nothing is
    // composed for it up front; the model reaches it by promotion.
    await runtime.chat({
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      message: "write the intro email",
      allowedTools: ["nb__*"],
    });
    const text = promptAtFirstExecution();
    expect(text).toContain(BUNDLE_MARKER);
    expect(text).toContain(TENANT_MARKER);
    // Nothing was composed up front, so the first call was held for both.
    expect(prompts.some((p) => promptText(p).includes(`Not run: ${DRAFT}`))).toBe(true);
    expect(executedAfterPrompt).toHaveLength(1);
  });

  it("in chat with the tool direct: both bodies precede the first execution", async () => {
    prompts = [];
    executedAfterPrompt = [];
    await runtime.chat({
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      message: "write the intro email",
      allowedTools: [DRAFT],
    });
    // A direct tool composes nothing up front either: the first call is held.
    expect(promptText(prompts[0] ?? [])).not.toContain(BUNDLE_MARKER);
    expect(prompts.some((p) => promptText(p).includes(`Not run: ${DRAFT}`))).toBe(true);
    const text = promptAtFirstExecution();
    expect(text).toContain(BUNDLE_MARKER);
    expect(text).toContain(TENANT_MARKER);
  });

  it("in a task run: both bodies precede the first execution", async () => {
    prompts = [];
    executedAfterPrompt = [];
    await runtime.executeTask({
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      prompt: "Write the intro email.",
      allowedTools: [DRAFT],
    });
    const text = promptAtFirstExecution();
    expect(text).toContain(BUNDLE_MARKER);
    expect(text).toContain(TENANT_MARKER);
  });
});

describe("a turn that calls no bound tool", () => {
  /** The system message of the first model call: the cached prefix. */
  function systemOf(p: LanguageModelV4CallOptions["prompt"] | undefined): string {
    const system = p?.find((m) => m.role === "system");
    return typeof system?.content === "string" ? system.content : "";
  }

  async function greet(allowedTools?: string[]): Promise<LanguageModelV4CallOptions["prompt"]> {
    prompts = [];
    executedAfterPrompt = [];
    await runtime.chat({
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      message: GREETING,
      appContext: { appName: "outreach", serverName: SERVER },
      ...(allowedTools ? { allowedTools } : {}),
    });
    expect(executedAfterPrompt).toHaveLength(0);
    return prompts[0] ?? [];
  }

  it("composes the app guide and no bound skill, with the bound tool focused and direct", async () => {
    const text = promptText(await greet([DRAFT]));
    expect(text).toContain(GUIDE_MARKER);
    expect(text).not.toContain(BUNDLE_MARKER);
    expect(text).not.toContain(TENANT_MARKER);
    expect(text).not.toContain("<layer3-skill>");
  });

  it("keeps the cached prefix byte-identical whatever tools the turn starts with", async () => {
    const direct = systemOf(await greet([DRAFT]));
    const proxied = systemOf(await greet(["nb__*"]));
    const everything = systemOf(await greet());
    expect(direct.length).toBeGreaterThan(0);
    expect(proxied).toBe(direct);
    expect(everything).toBe(direct);
  });
});
