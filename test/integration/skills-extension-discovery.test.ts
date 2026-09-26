/**
 * Server-published skills over a real transport (SEP-2640).
 *
 * - Only a server that declares `io.modelcontextprotocol/skills` publishes
 *   skills, and its `skills/list` is the record of what they are. A
 *   `skill://…/SKILL.md` resource is an ordinary resource otherwise.
 * - Discovery reads the listing only. A body is fetched when the skill is
 *   needed — an `always` skill when a turn composes it, an on-demand skill
 *   when it is activated — and is verified against the listed digest, size,
 *   and frontmatter before it is used.
 * - A verified body is cached by digest, and a digest that failed
 *   verification is not re-read every turn.
 */

import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { SKILLS_EXTENSION_ID } from "../../src/skills/skills-extension.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { type RemoteMcpFixture, startRemoteMcpServer } from "../helpers/remote-mcp-fixture.ts";
import {
  SKILLS_EXTENSION_CAPABILITY,
  SkillsListRequestSchema,
  skillEntryFor,
} from "../helpers/skills-server.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

const EXT_SERVER = "ai-nimblebrain-ext-mcp";
const PLAIN_SERVER = "ai-nimblebrain-plain-mcp";

function skillMd(name: string, marker: string, extra = ""): string {
  return `---\nname: ${name}\ndescription: ${name} guidance\n${extra}---\n\n${marker}\n`;
}

const ALWAYS = "metadata:\n  nimblebrain:\n    loading-strategy: always\n";

/** Everything the extension server serves over `resources/read`. */
const bodies: Record<string, string> = {
  "skill://listed/SKILL.md": skillMd("listed", "LISTED_BODY", ALWAYS),
  "skill://tampered/SKILL.md": skillMd("tampered", "TAMPERED_BODY", ALWAYS),
  // A YAML date the listing renders as a JSON string.
  "skill://ondemand/SKILL.md": skillMd("ondemand", "ONDEMAND_BODY", "released: 2026-01-01\n"),
  "skill://decoy/SKILL.md": skillMd("decoy", "DECOY_BODY", ALWAYS),
};

/** `resources/read` calls each server received, by URI. */
const reads: Record<string, string[]> = { ext: [], plain: [] };
/** Client capabilities the extension server saw on `initialize`. */
let seenClientExtensions: Record<string, unknown> | undefined;

function resourceHandlers(server: Server, log: string[]): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: Object.keys(bodies).map((uri) => ({ uri, name: uri, mimeType: "text/markdown" })),
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    log.push(request.params.uri);
    const text = bodies[request.params.uri];
    if (!text) throw new Error(`Resource not found: ${request.params.uri}`);
    return { contents: [{ uri: request.params.uri, mimeType: "text/markdown", text }] };
  });
}

function createExtensionServer(): Server {
  const server = new Server(
    { name: "ext", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {}, ...SKILLS_EXTENSION_CAPABILITY } },
  );
  server.oninitialized = () => {
    seenClientExtensions = server.getClientCapabilities()?.extensions as
      | Record<string, unknown>
      | undefined;
  };
  resourceHandlers(server, reads.ext!);
  server.setRequestHandler(SkillsListRequestSchema, async () => ({
    skills: [
      skillEntryFor("skill://listed/SKILL.md", bodies["skill://listed/SKILL.md"]!),
      skillEntryFor("skill://ondemand/SKILL.md", bodies["skill://ondemand/SKILL.md"]!),
      // Listed with the digest of different bytes than the server serves.
      {
        ...skillEntryFor("skill://tampered/SKILL.md", bodies["skill://tampered/SKILL.md"]!),
        resources: skillEntryFor("skill://tampered/SKILL.md", "not what is served").resources,
      },
    ],
  }));
  return server;
}

/** Serves the same `skill://` resources but does not declare the extension. */
function createPlainServer(): Server {
  const server = new Server(
    { name: "plain", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );
  resourceHandlers(server, reads.plain!);
  return server;
}

let lastPrompt: LanguageModelV4CallOptions["prompt"] | undefined;

function createCapturingModel(): LanguageModelV4 {
  const echo = createEchoModel();
  return {
    ...echo,
    doStream: (options: LanguageModelV4CallOptions) => {
      lastPrompt = options.prompt;
      return echo.doStream(options);
    },
  };
}

function lastPromptText(): string {
  return (lastPrompt ?? [])
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content.map((p) => ("text" in p ? p.text : "")).join(" "),
    )
    .join("\n");
}

const testDir = join(tmpdir(), `nimblebrain-skills-extension-${Date.now()}`);
let runtime: Runtime;
const sources: McpSource[] = [];
const fixtures: RemoteMcpFixture[] = [];

async function connect(name: string, make: () => Server): Promise<void> {
  const fixture = startRemoteMcpServer(make);
  fixtures.push(fixture);
  const source = new McpSource(
    name,
    { type: "remote", url: new URL(fixture.url), allowInsecure: true },
    new NoopEventSink(),
  );
  await source.start();
  sources.push(source);
  runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(source);
}

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createCapturingModel() },
    logging: { disabled: true },
    workDir: testDir,
    telemetry: { enabled: false },
  });
  await provisionTestWorkspace(runtime);
  await connect(EXT_SERVER, createExtensionServer);
  await connect(PLAIN_SERVER, createPlainServer);
});

afterAll(async () => {
  for (const source of sources) await source.stop().catch(() => {});
  for (const fixture of fixtures) fixture.close();
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("server-published skills (SEP-2640)", () => {
  it("advertises the extension to the server", () => {
    expect(seenClientExtensions?.[SKILLS_EXTENSION_ID]).toEqual({});
  });

  it("builds the catalog from the listing without reading a body", async () => {
    const names = (await runtime.listActivatableSkills(TEST_WORKSPACE_ID, null)).map((s) => s.name);
    expect(names).toContain(`connector:${EXT_SERVER}:ondemand`);
    expect(reads.ext).toEqual([]);
  });

  it("composes a verified `always` body and drops one that fails verification", async () => {
    await runtime.chat({ workspaceId: TEST_WORKSPACE_ID, message: "hello" });
    const prompt = lastPromptText();
    expect(prompt).toContain("LISTED_BODY");
    expect(prompt).not.toContain("TAMPERED_BODY");
    // Unlisted `decoy` is not a skill; `ondemand` is not needed yet.
    expect(prompt).not.toContain("DECOY_BODY");
    expect([...reads.ext!].sort()).toEqual(["skill://listed/SKILL.md", "skill://tampered/SKILL.md"]);
  });

  it("serves an unchanged body from the digest cache and does not re-read a failed digest", async () => {
    reads.ext!.length = 0;
    await runtime.chat({ workspaceId: TEST_WORKSPACE_ID, message: "again" });
    expect(lastPromptText()).toContain("LISTED_BODY");
    expect(reads.ext).toEqual([]);
  });

  it("fetches an on-demand skill's body when it is activated, verifying a YAML date", async () => {
    const skill = (await runtime.listActivatableSkills(TEST_WORKSPACE_ID, null)).find(
      (s) => s.name === `connector:${EXT_SERVER}:ondemand`,
    );
    expect(await skill?.loadBody?.()).toContain("ONDEMAND_BODY");
    expect(reads.ext).toEqual(["skill://ondemand/SKILL.md"]);
  });

  it("finds no skills on a server that does not declare the extension", async () => {
    const names = (await runtime.listActivatableSkills(TEST_WORKSPACE_ID, null)).map((s) => s.name);
    expect(names.some((n) => n.startsWith(`connector:${PLAIN_SERVER}:`))).toBe(false);
    expect(lastPromptText()).not.toContain("DECOY_BODY");
    expect(reads.plain).toEqual([]);
  });
});
