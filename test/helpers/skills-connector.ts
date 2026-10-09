import { createHash } from "node:crypto";
import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import { z } from "zod";
import { SKILLS_EXTENSION_ID } from "../../src/skills/skills-extension.ts";

/**
 * A 2026-07-28 connector that serves one skill through the MCP Skills extension
 * (SEP-2640) and server instructions that point at it, over HTTP. `/mcp/<wsId>`
 * tests install it to check what a client outside NimbleBrain gets of a
 * connector's skills and instructions.
 */
export const SKILL_NAME = "demo-skill";
export const SKILL_URI = `skill://${SKILL_NAME}/SKILL.md`;
export const SKILL_REFERENCE_URI = `skill://${SKILL_NAME}/references/guide.md`;
export const CONNECTOR_INSTRUCTIONS = `Read ${SKILL_URI} before calling this connector's tools.`;

const FILES: Record<string, string> = {
  [SKILL_URI]: `---\nname: ${SKILL_NAME}\ndescription: How to use the demo connector.\n---\n# Demo\n\nSee references/guide.md.\n`,
  [SKILL_REFERENCE_URI]: "# Guide\n\nCall `echo` with a message.\n",
};

function entry() {
  return {
    uri: SKILL_URI,
    frontmatter: { name: SKILL_NAME, description: "How to use the demo connector." },
    resources: Object.entries(FILES).map(([uri, text]) => ({
      uri,
      digest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
      size: Buffer.byteLength(text),
    })),
  };
}

const CACHE = { ttlMs: 0, cacheScope: "private" } as const;

function build(): Server {
  const server = new Server(
    { name: "skills-fixture", version: "1.0.0" },
    {
      capabilities: { tools: {}, resources: {}, extensions: { [SKILLS_EXTENSION_ID]: {} } },
      instructions: CONNECTOR_INSTRUCTIONS,
    },
  );
  server.setRequestHandler("tools/list", async () => ({
    tools: [
      {
        name: "echo",
        description: "Echoes.",
        inputSchema: { type: "object" as const, properties: {} },
      },
    ],
  }));
  server.setRequestHandler("tools/call", async () => ({
    content: [{ type: "text" as const, text: "echo" }],
  }));
  server.setRequestHandler("resources/list", async () => ({
    resources: [
      {
        uri: SKILL_URI,
        name: SKILL_NAME,
        description: "How to use the demo connector.",
        mimeType: "text/markdown",
      },
      {
        uri: SKILL_REFERENCE_URI,
        name: `${SKILL_NAME}/references/guide.md`,
        mimeType: "text/markdown",
      },
    ],
  }));
  server.setRequestHandler("resources/read", async (request) => {
    const text = FILES[request.params.uri];
    if (text === undefined) throw new Error(`Resource not found: ${request.params.uri}`);
    return { contents: [{ uri: request.params.uri, mimeType: "text/markdown", text }] };
  });
  server.setRequestHandler(
    "skills/list",
    { params: z.looseObject({ cursor: z.string().optional() }).optional() },
    async () => ({ skills: [entry()], ...CACHE }),
  );
  server.setRequestHandler(
    "skills/get",
    { params: z.looseObject({ uri: z.string() }) },
    async (p) => {
      if (p.uri !== SKILL_URI) throw new Error(`Unknown skill URI: ${p.uri}`);
      return { skill: entry(), ...CACHE };
    },
  );
  return server;
}

/** Serve the fixture on a free port; resolves its `/mcp` URL and a stop function. */
export function serveSkillsConnector(): { url: URL; stop: () => void } {
  const handler = createMcpHandler(build);
  const server = Bun.serve({ port: 0, fetch: (request) => handler.fetch(request) });
  return { url: new URL(`http://localhost:${server.port}/mcp`), stop: () => server.stop(true) };
}
