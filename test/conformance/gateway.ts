/**
 * `/mcp/<wsId>` as the conformance suite sees it: a runtime on the dev
 * identity, one workspace, and an upstream MCP server installed in it as a
 * remote connector, behind a front door that maps tool names. The reference
 * server serves no skills, so a second connector (`serveSkillsConnector`)
 * serves one for the suite's Skills extension scenarios.
 *
 * The gateway names a connector's tools `<source>__<tool>`, and the suite calls
 * its fixture tools by the upstream's own names. The front door adds the prefix
 * to a `tools/call` of a bare name (body and `Mcp-Name` header) and strips it
 * from every answer, and changes nothing else, so the suite measures what passes through
 * the gateway, not how it names tools.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { startServer } from "../../src/api/server.ts";
import { DevIdentityProvider } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { serveSkillsConnector } from "../helpers/skills-connector.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

/** The connector's name in the workspace, and so its tools' prefix. */
const SOURCE = "upstream";
const PREFIX = `${SOURCE}__`;

export interface Gateway {
  /** The front door's `/mcp/<wsId>` URL, for the suite. */
  url: string;
  stop(): Promise<void>;
}

export async function startGateway(upstream: URL): Promise<Gateway> {
  const workDir = await mkdtemp(join(tmpdir(), "nb-mcp-conformance-"));
  const runtime = await Runtime.start({
    identityProvider: ({ workDir: dir, userStore }) => new DevIdentityProvider(dir, userStore),
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir,
  });
  await provisionTestWorkspace(runtime);
  const source = new McpSource(
    SOURCE,
    {
      type: "remote",
      url: upstream,
      transportConfig: { type: "streamable-http" },
      allowInsecure: true,
    },
    new NoopEventSink(),
  );
  await source.start();
  runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(source);
  const skills = serveSkillsConnector();
  const skillsSource = new McpSource(
    "demo",
    {
      type: "remote",
      url: skills.url,
      transportConfig: { type: "streamable-http" },
      allowInsecure: true,
    },
    new NoopEventSink(),
  );
  await skillsSource.start();
  runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(skillsSource);
  const server = startServer({ runtime, port: 0 });

  const front = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: (req) => forward(req, `http://localhost:${server.port}`),
  });

  return {
    url: `http://localhost:${front.port}/mcp/${TEST_WORKSPACE_ID}`,
    async stop() {
      front.stop(true);
      server.stop(true);
      await runtime.shutdown();
      skills.stop();
      await rm(workDir, { recursive: true, force: true });
    },
  };
}

async function forward(req: Request, origin: string): Promise<Response> {
  const url = new URL(req.url);
  const headers = new Headers(req.headers);
  headers.delete("content-length");
  let body: string | undefined;
  if (req.method === "POST") {
    body = await req.text();
    const prefixed = prefixToolCall(body);
    if (prefixed) {
      body = prefixed;
      const name = headers.get("mcp-name");
      if (name && !name.includes("__")) headers.set("mcp-name", PREFIX + name);
    }
  }
  const res = await fetch(`${origin}${url.pathname}${url.search}`, {
    method: req.method,
    headers,
    body,
  });
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json") && !type.includes("event-stream")) return res;

  const out = new Headers(res.headers);
  out.delete("content-length");
  out.delete("content-encoding");
  const unprefix = (s: string) => s.replaceAll(`"name":"${PREFIX}`, `"name":"`);
  if (!type.includes("event-stream")) {
    return new Response(unprefix(await res.text()), { status: res.status, headers: out });
  }
  // Rewrite whole SSE events only, so a name split across chunks is still seen.
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  const stream = res.body?.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        const end = pending.lastIndexOf("\n\n");
        if (end < 0) return;
        controller.enqueue(encoder.encode(unprefix(pending.slice(0, end + 2))));
        pending = pending.slice(end + 2);
      },
      flush(controller) {
        if (pending) controller.enqueue(encoder.encode(unprefix(pending)));
      },
    }),
  );
  return new Response(stream, { status: res.status, headers: out });
}

/** `body` with its `tools/call` name prefixed, or undefined when it is no `tools/call`. */
function prefixToolCall(body: string): string | undefined {
  let msg: { method?: unknown; params?: { name?: unknown } };
  try {
    msg = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (msg.method !== "tools/call" || typeof msg.params?.name !== "string") return undefined;
  // A name that already carries a source (a platform tool's) is left alone.
  if (msg.params.name.includes("__")) return undefined;
  msg.params.name = PREFIX + msg.params.name;
  return JSON.stringify(msg);
}
