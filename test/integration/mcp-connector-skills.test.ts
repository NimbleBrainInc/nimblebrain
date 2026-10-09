/**
 * What a client outside NimbleBrain gets of a connector's guidance through
 * `/mcp/<wsId>`: the connector's server instructions, under its source name and
 * contained, and its skills through the MCP Skills extension (SEP-2640), whose
 * files read through `resources/read`.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { SKILLS_EXTENSION_ID } from "../../src/skills/skills-extension.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { newMcpClient } from "../helpers/mcp-client.ts";
import {
  CONNECTOR_INSTRUCTIONS,
  SKILL_NAME,
  SKILL_REFERENCE_URI,
  SKILL_URI,
  serveSkillsConnector,
} from "../helpers/skills-connector.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

/** A workspace with the same connector installed twice, under two names. */
const TWICE_WORKSPACE_ID = "ws_005c47492e176e75";

const SkillsListSchema = z.looseObject({
  skills: z.array(z.looseObject({ uri: z.string(), frontmatter: z.looseObject({}) })),
  ttlMs: z.number(),
  cacheScope: z.string(),
});
const SkillsGetSchema = z.looseObject({ skill: z.looseObject({ uri: z.string() }) });

let connector: ReturnType<typeof serveSkillsConnector>;
let runtime: Runtime;
let handle: ServerHandle;
let workDir: string;

async function install(wsId: string, name: string): Promise<void> {
  const source = new McpSource(
    name,
    {
      type: "remote",
      url: connector.url,
      transportConfig: { type: "streamable-http" },
      allowInsecure: true,
    },
    new NoopEventSink(),
  );
  await source.start();
  runtime.getRegistryForWorkspace(wsId).addSource(source);
}

beforeAll(async () => {
  connector = serveSkillsConnector();
  workDir = await mkdtemp(join(tmpdir(), "nb-mcp-skills-"));
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir,
  });
  await provisionTestWorkspace(runtime);
  await install(TEST_WORKSPACE_ID, "demo");
  await provisionTestWorkspace(runtime, TWICE_WORKSPACE_ID, "Twice");
  await install(TWICE_WORKSPACE_ID, "demo");
  await install(TWICE_WORKSPACE_ID, "demo_copy");
  handle = startServer({ runtime, port: 0 });
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  connector.stop();
  rmSync(workDir, { recursive: true, force: true });
});

async function client(wsId: string = TEST_WORKSPACE_ID): Promise<Client> {
  const c = newMcpClient({ name: "skills-test", version: "1.0.0" });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`http://localhost:${handle.port}/mcp/${wsId}`)),
  );
  return c;
}

describe("/mcp/<wsId> serves its connectors' guidance", () => {
  let c: Client;

  beforeAll(async () => {
    c = await client();
  });

  afterAll(async () => {
    await c.close();
  });

  it("serves each connector's instructions under its source name, contained", () => {
    const instructions = c.getInstructions() ?? "";
    expect(instructions).toContain("## Connector `demo`");
    expect(instructions).toContain("`demo__<tool>`");
    expect(instructions).toContain(
      `<connector-instructions>\n${CONNECTOR_INSTRUCTIONS}\n</connector-instructions>`,
    );
  });

  it("declares the skills extension", () => {
    expect(Object.keys(c.getServerCapabilities()?.extensions ?? {})).toContain(SKILLS_EXTENSION_ID);
  });

  it("lists the connector's skills as cacheable results", async () => {
    const listed = await c.request({ method: "skills/list", params: {} }, SkillsListSchema);
    expect(listed.skills.map((s) => s.uri)).toEqual([SKILL_URI]);
    expect(listed.skills[0]?.frontmatter).toMatchObject({ name: SKILL_NAME });
    expect(listed).toMatchObject({ ttlMs: 0, cacheScope: "private" });
  });

  it("gets a skill by its URI", async () => {
    const got = await c.request(
      { method: "skills/get", params: { uri: SKILL_URI } },
      SkillsGetSchema,
    );
    expect(got.skill.uri).toBe(SKILL_URI);
  });

  it("refuses an unknown skill URI and any cursor with -32602", async () => {
    await expect(
      c.request(
        { method: "skills/get", params: { uri: "skill://nope/SKILL.md" } },
        SkillsGetSchema,
      ),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      c.request({ method: "skills/list", params: { cursor: "next" } }, SkillsListSchema),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("reads a skill's files through resources/read", async () => {
    for (const uri of [SKILL_URI, SKILL_REFERENCE_URI]) {
      const read = await c.readResource({ uri });
      expect((read.contents[0] as { text?: string }).text).toBeTruthy();
    }
  });
});

describe("/mcp/<wsId> with one skill served by two connectors", () => {
  it("leaves the skill out, since a read could reach either", async () => {
    const c = await client(TWICE_WORKSPACE_ID);
    try {
      const listed = await c.request({ method: "skills/list", params: {} }, SkillsListSchema);
      expect(listed.skills).toEqual([]);
    } finally {
      await c.close();
    }
  });
});
