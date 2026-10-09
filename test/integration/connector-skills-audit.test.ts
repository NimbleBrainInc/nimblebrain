/**
 * `manage_connectors list_bound_skills` / `read_bound_skill` through a real
 * Runtime: the read-only audit of every skill a workspace's connectors put into
 * the model's context. A fixture server publishes an `always` skill and a
 * `dynamic` one through the Skills extension, and a second connector has a
 * curated overlay materialized on disk.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/server";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import {
  CONNECTOR_SKILLS_SUBDIR,
  materializeConnectorSkill,
} from "../../src/skills/connector-skill-store.ts";
import { createManageConnectorsTool } from "../../src/tools/connector-tools.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { type RemoteMcpFixture, startRemoteMcpServer } from "../helpers/remote-mcp-fixture.ts";
import { SKILLS_EXTENSION_CAPABILITY, serveSkills } from "../helpers/skills-server.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const SERVER = "acme-docs";
const OVERLAY_SERVER = "acme-mail";

const ALWAYS_BODY = `---
name: house-style
description: Formatting rules for every document.
metadata:
  nimblebrain:
    loading-strategy: always
    priority: 20
---

Use sentence case in headings.`;

const DYNAMIC_BODY = `---
name: publishing
description: How to publish a draft.
metadata:
  nimblebrain:
    loading-strategy: dynamic
    tool-affinity: [publish]
    triggers: [publish this]
---

Call publish only after preview.`;

const DRIFTED_BODY = `---
name: drifted
description: Served content differs from the listing.
---

Listed body.`;

const VANISHED_BODY = `---
name: vanished
description: Listed but not readable.
---

Never served.`;

function createFixtureServer(): Server {
  const server = new Server(
    { name: "docs", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {}, ...SKILLS_EXTENSION_CAPABILITY } },
  );
  server.setRequestHandler("tools/list", async () => ({
    tools: [
      { name: "publish", description: "Publish", inputSchema: { type: "object", properties: {} } },
    ],
  }));
  server.setRequestHandler("tools/call", async () => ({
    content: [{ type: "text", text: "done" }],
  }));
  const bodies: Record<string, string> = {
    "skill://house-style/SKILL.md": ALWAYS_BODY,
    "skill://publishing/SKILL.md": DYNAMIC_BODY,
    "skill://drifted/SKILL.md": DRIFTED_BODY,
    "skill://vanished/SKILL.md": VANISHED_BODY,
  };
  serveSkills(server, () => bodies);
  // `drifted` reads back different bytes than its listing's digest; `vanished`
  // is listed but cannot be read.
  const served: Record<string, string | undefined> = {
    ...bodies,
    "skill://drifted/SKILL.md": `${DRIFTED_BODY}\nAppended after listing.`,
    "skill://vanished/SKILL.md": undefined,
  };
  server.setRequestHandler("resources/read", async (request) => {
    const text = served[request.params.uri];
    if (text === undefined) throw new Error(`Resource not found: ${request.params.uri}`);
    return { contents: [{ uri: request.params.uri, mimeType: "text/markdown", text }] };
  });
  return server;
}

const testDir = join(tmpdir(), `nimblebrain-connector-skills-audit-${Date.now()}`);
let runtime: Runtime;
let source: McpSource;
let fixture: RemoteMcpFixture;
let tool: ReturnType<typeof createManageConnectorsTool>;

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir: testDir,
    telemetry: { enabled: false },
  });
  await provisionTestWorkspace(runtime);

  fixture = startRemoteMcpServer(createFixtureServer);
  source = new McpSource(
    SERVER,
    { type: "remote", url: new URL(fixture.url), allowInsecure: true },
    new NoopEventSink(),
  );
  await source.start();
  runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(source);

  materializeConnectorSkill({
    connectorSkillsDir: runtime
      .getWorkspaceContext(TEST_WORKSPACE_ID)
      .getDataPath(CONNECTOR_SKILLS_SUBDIR),
    serverName: OVERLAY_SERVER,
    overlayBody: "---\nname: mail-usage\ndescription: Mail guidance\n---\n\nConfirm the recipient.",
    source: "connector:acme-mail@v0.1.0",
    now: "2026-01-01T00:00:00.000Z",
  });

  tool = createManageConnectorsTool({
    runtime,
    getIdentity: () => DEV_IDENTITY,
    getWorkspaceId: () => TEST_WORKSPACE_ID,
  });
});

afterAll(async () => {
  try {
    await source.stop();
  } catch {
    // already stopped
  }
  fixture.close();
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

function text(result: { content?: unknown }): string {
  return (result.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "";
}

describe("manage_connectors — connector skill audit", () => {
  it("lists published skills with how each loads, beside the overlays", async () => {
    const result = await tool.handler({ action: "list_bound_skills" });
    expect(result.isError).toBe(false);
    const data = result.structuredContent as {
      overlays: Array<{ server: string; name: string; source?: string }>;
      published: Array<Record<string, unknown>>;
    };

    expect(data.overlays).toHaveLength(1);
    expect(data.overlays[0]).toMatchObject({
      server: OVERLAY_SERVER,
      name: "mail-usage",
      source: "connector:acme-mail@v0.1.0",
    });

    const byName = new Map(data.published.map((p) => [p.name, p]));
    expect(byName.get("house-style")).toMatchObject({
      server: SERVER,
      uri: "skill://house-style/SKILL.md",
      description: "Formatting rules for every document.",
      loadingStrategy: "always",
      priority: 20,
      mechanism: "always",
    });
    expect(byName.get("publishing")).toMatchObject({
      server: SERVER,
      loadingStrategy: "dynamic",
      toolAffinity: [`${SERVER}__publish`],
      triggers: ["publish this"],
      mechanism: "tool_affinity",
    });
    expect(text(result)).toContain(`${SERVER}: house-style`);
  });

  it("reads a published skill's body as the model receives it", async () => {
    const result = await tool.handler({
      action: "read_bound_skill",
      serverName: SERVER,
      skillName: "publishing",
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent as { kind: string; body: string };
    expect(data.kind).toBe("published");
    expect(data.body).toContain("Call publish only after preview.");
    // Frontmatter is stripped: the model never sees it.
    expect(data.body).not.toContain("loading-strategy");
  });

  it("reads an overlay's body", async () => {
    const result = await tool.handler({
      action: "read_bound_skill",
      serverName: OVERLAY_SERVER,
      skillName: "mail-usage",
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent as { kind: string; body: string };
    expect(data.kind).toBe("overlay");
    expect(data.body).toContain("Confirm the recipient.");
  });

  it("refuses a skill the workspace does not have", async () => {
    const missing = await tool.handler({
      action: "read_bound_skill",
      serverName: SERVER,
      skillName: "nope",
    });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("list_bound_skills");

    const unnamed = await tool.handler({ action: "read_bound_skill", serverName: SERVER });
    expect(unnamed.isError).toBe(true);
  });

  it("refuses a body the server cannot serve as listed", async () => {
    const drifted = await tool.handler({
      action: "read_bound_skill",
      serverName: SERVER,
      skillName: "drifted",
    });
    expect(drifted.isError).toBe(true);
    expect(text(drifted)).toContain("does not match its skills listing");

    const vanished = await tool.handler({
      action: "read_bound_skill",
      serverName: SERVER,
      skillName: "vanished",
    });
    expect(vanished.isError).toBe(true);
    expect(text(vanished)).toContain(`"${SERVER}" did not return "vanished"`);
  });
});
