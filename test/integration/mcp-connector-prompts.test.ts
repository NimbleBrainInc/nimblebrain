/**
 * What a client outside NimbleBrain gets of a connector's prompts through
 * `/mcp/<wsId>`: each prompt under `<source>__<prompt>`, as its tools are named,
 * fetched from the connector that serves it, and completions asked of the
 * connector that owns the prompt or resource template.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { newMcpClient } from "../helpers/mcp-client.ts";
import { NOTE_TEMPLATE, PROMPT_NAME, servePromptsConnector } from "../helpers/prompts-connector.ts";
import { serveSkillsConnector } from "../helpers/skills-connector.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

let prompts: ReturnType<typeof servePromptsConnector>;
let noCompletions: ReturnType<typeof servePromptsConnector>;
let noPrompts: ReturnType<typeof serveSkillsConnector>;
let runtime: Runtime;
let handle: ServerHandle;
let workDir: string;
let c: Client;
/** The template only the connector without completions lists. */
const QUIET_TEMPLATE = "quiet://{id}";

async function install(name: string, url: URL): Promise<void> {
  const source = new McpSource(
    name,
    { type: "remote", url, transportConfig: { type: "streamable-http" }, allowInsecure: true },
    new NoopEventSink(),
  );
  await source.start();
  runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(source);
}

beforeAll(async () => {
  prompts = servePromptsConnector();
  noCompletions = servePromptsConnector({ completions: false, template: QUIET_TEMPLATE });
  noPrompts = serveSkillsConnector();
  workDir = await mkdtemp(join(tmpdir(), "nb-mcp-prompts-"));
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir,
  });
  await provisionTestWorkspace(runtime);
  // The same connector twice, so its prompt is listed under two sources; one
  // that declares no completions; and one that declares no prompts at all.
  await install("alpha", prompts.url);
  await install("beta", prompts.url);
  await install("gamma", noCompletions.url);
  await install("plain", noPrompts.url);
  handle = startServer({ runtime, port: 0 });
  c = newMcpClient({ name: "prompts-test", version: "1.0.0" });
  await c.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://localhost:${handle.port}/mcp/${TEST_WORKSPACE_ID}`),
    ),
  );
});

afterAll(async () => {
  await c.close();
  handle.stop(true);
  await runtime.shutdown();
  prompts.stop();
  noCompletions.stop();
  noPrompts.stop();
  rmSync(workDir, { recursive: true, force: true });
});

describe("/mcp/<wsId> serves its connectors' prompts", () => {
  it("declares prompts and completions", () => {
    expect(c.getServerCapabilities()).toMatchObject({ prompts: {}, completions: {} });
  });

  it("lists each connector's prompts under its source name, as cacheable results", async () => {
    const listed = await c.request({ method: "prompts/list", params: {} });
    expect(listed.prompts.map((p) => p.name)).toEqual([
      `alpha__${PROMPT_NAME}`,
      `beta__${PROMPT_NAME}`,
      `gamma__${PROMPT_NAME}`,
    ]);
    expect(listed.prompts[0]?.arguments).toEqual([
      { name: "name", description: "Who to greet.", required: true },
    ]);
    expect(listed).toMatchObject({ ttlMs: 0, cacheScope: "private" });
  });

  it("gets a prompt from the connector that serves it, with its arguments", async () => {
    const got = await c.getPrompt({ name: `beta__${PROMPT_NAME}`, arguments: { name: "Ada" } });
    expect(got.messages).toEqual([
      { role: "user", content: { type: "text", text: "Hello, Ada." } },
    ]);
  });

  it("refuses a prompt no connector serves with -32602", async () => {
    for (const name of [
      PROMPT_NAME,
      `missing__${PROMPT_NAME}`,
      `plain__${PROMPT_NAME}`,
      "alpha__",
    ]) {
      await expect(c.getPrompt({ name })).rejects.toMatchObject({ code: -32602 });
    }
  });

  it("refuses a cursor with -32602", async () => {
    await expect(
      c.request({ method: "prompts/list", params: { cursor: "next" } }),
    ).rejects.toMatchObject({ code: -32602 });
  });
});

describe("/mcp/<wsId> completes from the connector that owns the reference", () => {
  it("completes a prompt argument", async () => {
    const res = await c.complete({
      ref: { type: "ref/prompt", name: `alpha__${PROMPT_NAME}` },
      argument: { name: "name", value: "A" },
    });
    expect(res.completion.values).toEqual(["Ada", "Alan"]);
  });

  it("completes a resource template variable", async () => {
    const res = await c.complete({
      ref: { type: "ref/resource", uri: NOTE_TEMPLATE },
      argument: { name: "id", value: "10" },
    });
    expect(res.completion.values).toEqual(["101", "102"]);
  });

  it("answers no values for a reference whose connector declares no completions", async () => {
    for (const ref of [
      { type: "ref/prompt" as const, name: `gamma__${PROMPT_NAME}` },
      { type: "ref/resource" as const, uri: QUIET_TEMPLATE },
    ]) {
      const res = await c.complete({ ref, argument: { name: "id", value: "" } });
      expect(res.completion).toEqual({ values: [], hasMore: false });
    }
  });

  it("refuses a reference no connector owns with -32602", async () => {
    await expect(
      c.complete({
        ref: { type: "ref/prompt", name: `missing__${PROMPT_NAME}` },
        argument: { name: "name", value: "" },
      }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      c.complete({
        ref: { type: "ref/resource", uri: "nope://{id}" },
        argument: { name: "id", value: "" },
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });
});
