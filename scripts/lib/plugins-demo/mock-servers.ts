/**
 * The MCP servers behind the demo's connected plugins, and the ones that fail.
 *
 * Each mock is a real Streamable-HTTP MCP server on a loopback port, built on
 * the test suite's `startRemoteMcpServer` and `serveSkills`, so the runtime
 * connects to it exactly as it connects to any server added by URL. A mock
 * lists its tools, answers every call with canned text, publishes its skills
 * under the MCP Skills Extension, and serves its `ui://` view.
 *
 * Ports are chosen by the OS, so the seed writes each connector's URL on every
 * launch (`seed.ts`).
 */

import { Server } from "@modelcontextprotocol/server";
import { MCP_APP_MIME_TYPE } from "../../../src/tools/apps-extension.ts";
import { startRemoteMcpServer } from "../../../test/helpers/remote-mcp-fixture.ts";
import { SKILLS_EXTENSION_CAPABILITY, serveSkills } from "../../../test/helpers/skills-server.ts";
import type { MockServer, MockSkill } from "./fixtures.ts";

/** The `ui://` resource a mock's view is served at. */
export function appResourceUri(mock: MockServer): string {
  return `ui://${mock.serverName}/app`;
}

/** The `SKILL.md` text a mock publishes for `skill`, bound to its tools. */
export function skillMarkdown(skill: MockSkill): string {
  const affinity = skill.tools.map((name) => `      - ${name}`).join("\n");
  return `---
name: ${skill.name}
description: ${JSON.stringify(skill.description)}
metadata:
  nimblebrain:
    loading-strategy: dynamic
    tool-affinity:
${affinity}
---

${skill.body}
`;
}

function appHtml(mock: MockServer): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${mock.title}</title>
<style>body{font-family:system-ui,sans-serif;margin:24px;color:#222}p{color:#666}</style></head>
<body><h1>${mock.app?.label ?? mock.title}</h1><p>${mock.description}. Demo data from the plugins demo.</p></body></html>`;
}

function buildServer(mock: MockServer): Server {
  const skillFiles: Record<string, string> = Object.fromEntries(
    (mock.skills ?? []).map((s) => [`skill://${s.name}/SKILL.md`, skillMarkdown(s)]),
  );
  const hasSkills = Object.keys(skillFiles).length > 0;
  const server = new Server(
    { name: mock.serverName, title: mock.title, version: "1.0.0" },
    {
      capabilities: {
        tools: {},
        resources: {},
        ...(hasSkills ? SKILLS_EXTENSION_CAPABILITY : {}),
      },
    },
  );
  server.setRequestHandler("tools/list", async () => ({
    tools: mock.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: "object", properties: {} },
    })),
  }));
  server.setRequestHandler("tools/call", async (request) => ({
    content: [
      {
        type: "text",
        text: `${mock.title} demo: ${request.params.name} ran with no real data behind it.`,
      },
    ],
  }));
  const appUri = appResourceUri(mock);
  server.setRequestHandler("resources/list", async () => ({
    resources: [
      ...(mock.app ? [{ uri: appUri, name: mock.app.label, mimeType: MCP_APP_MIME_TYPE }] : []),
      ...Object.keys(skillFiles).map((uri) => ({ uri, name: uri, mimeType: "text/markdown" })),
    ],
  }));
  server.setRequestHandler("resources/read", async (request) => {
    const uri = request.params.uri;
    if (mock.app && uri === appUri) {
      return { contents: [{ uri, mimeType: MCP_APP_MIME_TYPE, text: appHtml(mock) }] };
    }
    const text = skillFiles[uri];
    if (!text) throw new Error(`Resource not found: ${uri}`);
    return { contents: [{ uri, mimeType: "text/markdown", text }] };
  });
  if (hasSkills) serveSkills(server, () => skillFiles);
  return server;
}

export interface MockFleet {
  /** The URL of each mock, by server name. */
  urls: Map<string, string>;
  /** URLs that do not start: nothing listening, HTTP 503, and a path that 404s. */
  failing: { closed: string; error: string; wrongPath: string };
  close: () => void;
}

/** A loopback port nothing listens on: bound by the OS, then released. */
function closedPort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 204 }) });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("[plugins-demo] the OS gave no port");
  return port;
}

/** Start every mock in `mocks`, plus the servers the failing plugins point at. */
export function startMockFleet(mocks: readonly MockServer[]): MockFleet {
  const started = mocks.map((mock) => ({
    mock,
    fixture: startRemoteMcpServer(() => buildServer(mock)),
  }));
  const unavailable = Bun.serve({
    port: 0,
    fetch: () => new Response("Down for maintenance", { status: 503 }),
  });
  const first = started[0];
  if (!first) throw new Error("[plugins-demo] no mock servers to start");
  return {
    urls: new Map(started.map(({ mock, fixture }) => [mock.serverName, fixture.url])),
    failing: {
      closed: `http://localhost:${closedPort()}/mcp`,
      error: `http://localhost:${unavailable.port}/mcp`,
      // The fixture serves `/mcp` and answers 404 for any other path.
      wrongPath: first.fixture.url.replace(/\/mcp$/, "/v1/mcp"),
    },
    close() {
      for (const { fixture } of started) fixture.close();
      unavailable.stop(true);
    },
  };
}
