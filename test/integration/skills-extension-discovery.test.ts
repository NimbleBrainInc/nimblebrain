/**
 * Server-published skill discovery over a real transport, both ways a server
 * can publish (SEP-2640):
 *
 * - A server that declares `io.modelcontextprotocol/skills` is enumerated with
 *   `skills/list`. Its listing is the record of what is a skill, so a
 *   `skill://…/SKILL.md` resource it does not list is not one, and a listed
 *   `SKILL.md` whose bytes do not match the listed digest is not loaded.
 * - A server that does not declare it is enumerated with `resources/list`.
 *
 * Read through `listActivatableSkills`, the set a turn can activate.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { SKILLS_EXTENSION_ID } from "../../src/skills/skills-extension.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { type RemoteMcpFixture, startRemoteMcpServer } from "../helpers/remote-mcp-fixture.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

const EXT_SERVER = "ai-nimblebrain-ext-mcp";
const PLAIN_SERVER = "ai-nimblebrain-plain-mcp";

function skillMd(name: string, marker: string): string {
  return `---\nname: ${name}\ndescription: ${name} guidance\n---\n\n${marker}\n`;
}

const bodies: Record<string, string> = {
  "skill://listed/SKILL.md": skillMd("listed", "LISTED_BODY"),
  "skill://tampered/SKILL.md": skillMd("tampered", "TAMPERED_BODY"),
  "skill://decoy/SKILL.md": skillMd("decoy", "DECOY_BODY"),
};

function entry(uri: string, name: string, text: string) {
  const bytes = new TextEncoder().encode(text);
  return {
    uri,
    frontmatter: { name, description: `${name} guidance` },
    resources: [
      { uri, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, size: bytes.length },
    ],
  };
}

const SkillsListRequestSchema = z.object({
  method: z.literal("skills/list"),
  params: z.object({ cursor: z.string().optional() }).loose().optional(),
});

/** Client capabilities the extension server saw on `initialize`. */
let seenClientExtensions: Record<string, unknown> | undefined;

function readHandler(server: Server): void {
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const text = bodies[request.params.uri];
    if (!text) throw new Error(`Resource not found: ${request.params.uri}`);
    return { contents: [{ uri: request.params.uri, mimeType: "text/markdown", text }] };
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  // Every `skill://` resource is listed, including ones the skills listing omits.
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: Object.keys(bodies).map((uri) => ({ uri, name: uri, mimeType: "text/markdown" })),
  }));
}

function createExtensionServer(): Server {
  const server = new Server(
    { name: "ext", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {}, extensions: { [SKILLS_EXTENSION_ID]: {} } } },
  );
  server.oninitialized = () => {
    seenClientExtensions = server.getClientCapabilities()?.extensions as
      | Record<string, unknown>
      | undefined;
  };
  readHandler(server);
  server.setRequestHandler(SkillsListRequestSchema, async () => ({
    skills: [
      entry("skill://listed/SKILL.md", "listed", bodies["skill://listed/SKILL.md"]!),
      // Listed with the digest of different bytes than the server serves.
      entry("skill://tampered/SKILL.md", "tampered", "not what is served"),
    ],
  }));
  return server;
}

function createPlainServer(): Server {
  const server = new Server(
    { name: "plain", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );
  readHandler(server);
  return server;
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
    model: { provider: "custom", adapter: createEchoModel() },
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

describe("server skill discovery (SEP-2640)", () => {
  it("advertises the extension to the server", () => {
    expect(seenClientExtensions?.[SKILLS_EXTENSION_ID]).toEqual({});
  });

  it("takes an extension server's skills from skills/list, verified", async () => {
    const names = (await runtime.listActivatableSkills(TEST_WORKSPACE_ID, null)).map((s) => s.name);
    const ext = names.filter((n) => n.startsWith(`connector:${EXT_SERVER}:`));
    // `decoy` is a skill:// resource the listing omits; `tampered` fails its digest.
    expect(ext).toEqual([`connector:${EXT_SERVER}:listed`]);
  });

  it("takes a non-declaring server's skills from resources/list", async () => {
    const names = (await runtime.listActivatableSkills(TEST_WORKSPACE_ID, null)).map((s) => s.name);
    const plain = names.filter((n) => n.startsWith(`connector:${PLAIN_SERVER}:`)).sort();
    expect(plain).toEqual([
      `connector:${PLAIN_SERVER}:decoy`,
      `connector:${PLAIN_SERVER}:listed`,
      `connector:${PLAIN_SERVER}:tampered`,
    ]);
  });
});
