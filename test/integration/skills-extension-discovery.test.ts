/**
 * Server-published skills over a real transport (SEP-2640), on both protocol
 * eras.
 *
 * - A server's `skills/list` is the record of what its skills are; a
 *   `skill://…/SKILL.md` resource it does not list is an ordinary resource.
 * - On a 2026-07-28 connection only a server that declares
 *   `io.modelcontextprotocol/skills` is asked. On a 2025-era connection the
 *   legacy `initialize` result may not carry the declaration, so an
 *   undeclared server is asked once per discovery window, and `-32601` means
 *   it has none.
 * - Discovery reads the listing only. A body is fetched when the skill is
 *   needed — an `always` skill when a turn composes it, an on-demand skill
 *   when it is activated — and is verified against the listed digest, size,
 *   and frontmatter before it is used. A verified body is cached by digest,
 *   and a digest that failed verification is not re-read every turn.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/client";
import {
  createMcpHandler,
  legacyStatelessFallback,
  Server,
  type ServerCapabilities,
} from "@modelcontextprotocol/server";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { log } from "../../src/observability/log.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { SKILLS_EXTENSION_ID } from "../../src/skills/skills-extension.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { handleSkillsList, skillEntryFor } from "../helpers/skills-server.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

function skillMd(name: string, marker: string, extra = ""): string {
  return `---\nname: ${name}\ndescription: ${name} guidance\n${extra}---\n\n${marker}\n`;
}

const ALWAYS = "metadata:\n  nimblebrain:\n    loading-strategy: always\n";

/** Everything each fixture serves over `resources/read`, keyed by URI. */
const bodies: Record<string, string> = {
  "skill://listed/SKILL.md": skillMd("listed", "LISTED_BODY", ALWAYS),
  "skill://tampered/SKILL.md": skillMd("tampered", "TAMPERED_BODY", ALWAYS),
  // A YAML date the listing renders as a JSON string.
  "skill://ondemand/SKILL.md": skillMd("ondemand", "ONDEMAND_BODY", "released: 2026-01-01\n"),
  "skill://decoy/SKILL.md": skillMd("decoy", "DECOY_BODY", ALWAYS),
};

/** The listing the extension-serving fixtures answer with. */
function listing() {
  return {
    skills: [
      skillEntryFor("skill://listed/SKILL.md", bodies["skill://listed/SKILL.md"]!),
      skillEntryFor("skill://ondemand/SKILL.md", bodies["skill://ondemand/SKILL.md"]!),
      // Listed with the digest of different bytes than the server serves.
      {
        ...skillEntryFor("skill://tampered/SKILL.md", bodies["skill://tampered/SKILL.md"]!),
        resources: skillEntryFor("skill://tampered/SKILL.md", "not what is served").resources,
      },
    ],
  };
}

/** A fixture server: resources always, the extension declared and/or served as asked. */
function buildServer(opts: { declares: boolean; serves: boolean }): Server {
  const capabilities: ServerCapabilities = {
    tools: {},
    resources: {},
    ...(opts.declares ? { extensions: { [SKILLS_EXTENSION_ID]: {} } } : {}),
  };
  const server = new Server({ name: "skills-fixture", version: "1.0.0" }, { capabilities });
  server.setRequestHandler("tools/list", async () => ({ tools: [] }));
  server.setRequestHandler("resources/list", async () => ({
    resources: Object.keys(bodies).map((uri) => ({ uri, name: uri, mimeType: "text/markdown" })),
  }));
  server.setRequestHandler("resources/read", async (request) => {
    const text = bodies[request.params.uri];
    if (!text) throw new Error(`Resource not found: ${request.params.uri}`);
    return { contents: [{ uri: request.params.uri, mimeType: "text/markdown", text }] };
  });
  if (opts.serves) handleSkillsList(server, listing);
  return server;
}

type Fetch = (request: Request) => Promise<Response>;

interface Recorded {
  url: string;
  close: () => void;
  /** Methods received, with the `resources/read` URIs. */
  calls: string[];
  /** Client capability extensions seen, on `initialize` or any request envelope. */
  claimed: Array<Record<string, unknown>>;
}

/** Serve `fetch`, recording each JSON-RPC method and the extensions the client claimed. */
function record(fetch: Fetch): Recorded {
  const calls: string[] = [];
  const claimed: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method === "POST") {
        const body = (await request
          .clone()
          .json()
          .catch(() => null)) as {
          method?: string;
          params?: Record<string, unknown> & { _meta?: Record<string, unknown> };
        } | null;
        if (body?.method) {
          const uri = body.params?.uri;
          calls.push(typeof uri === "string" ? `${body.method} ${uri}` : body.method);
          const caps = (
            body.method === "initialize"
              ? body.params?.capabilities
              : body.params?._meta?.[CLIENT_CAPABILITIES_META_KEY]
          ) as { extensions?: Record<string, unknown> } | undefined;
          if (caps) claimed.push(caps.extensions ?? {});
        }
      }
      return fetch(request);
    },
  });
  return {
    url: `http://localhost:${server.port}/mcp`,
    close: () => server.stop(true),
    calls,
    claimed,
  };
}

const modern = (opts: { declares: boolean; serves: boolean }): Fetch =>
  createMcpHandler(() => buildServer(opts)).fetch;
const legacy = (opts: { declares: boolean; serves: boolean }): Fetch =>
  legacyStatelessFallback(() => buildServer(opts));

/** The connectors under test, by registry name. */
const FIXTURES = {
  // 2026-07-28, declares and serves: the SEP's own shape.
  "modern-declared": () => modern({ declares: true, serves: true }),
  // 2026-07-28, serves but does not declare: not asked.
  "modern-undeclared": () => modern({ declares: false, serves: true }),
  // 2025 era, serves but cannot declare (the Python SDK's legacy handshake).
  "legacy-undeclared": () => legacy({ declares: false, serves: true }),
  // 2025 era, no extension at all: asked once, `-32601`.
  "legacy-none": () => legacy({ declares: false, serves: false }),
} as const;
type FixtureName = keyof typeof FIXTURES;

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
const served = {} as Record<FixtureName, Recorded>;

async function activatableNames(): Promise<string[]> {
  return (await runtime.listActivatableSkills(TEST_WORKSPACE_ID, null)).map((s) => s.name);
}

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: devProvider,
    model: { provider: "custom", adapter: createCapturingModel() },
    logging: { disabled: true },
    workDir: testDir,
    telemetry: { enabled: false },
  });
  await provisionTestWorkspace(runtime);
  for (const name of Object.keys(FIXTURES) as FixtureName[]) {
    served[name] = record(FIXTURES[name]());
    const source = new McpSource(
      name,
      { type: "remote", url: new URL(served[name].url), allowInsecure: true },
      new NoopEventSink(),
    );
    await source.start();
    sources.push(source);
    runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(source);
  }
});

afterAll(async () => {
  for (const source of sources) await source.stop().catch(() => {});
  for (const name of Object.keys(served) as FixtureName[]) served[name].close();
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("the client claim", () => {
  it("rides the 2025 initialize and every 2026-07-28 envelope", () => {
    for (const name of ["modern-declared", "legacy-none"] as const) {
      const claims = served[name].claimed;
      expect(claims.length).toBeGreaterThan(0);
      for (const extensions of claims) expect(extensions[SKILLS_EXTENSION_ID]).toEqual({});
    }
  });
});

describe("discovery by era", () => {
  it("lists a declaring modern server's skills without reading a body", async () => {
    const names = await activatableNames();
    expect(names).toContain("connector:modern-declared:ondemand");
    expect(served["modern-declared"].calls.some((c) => c.startsWith("resources/read"))).toBe(false);
  });

  it("does not ask an undeclared modern server", () => {
    expect(served["modern-undeclared"].calls).not.toContain("skills/list");
  });

  it("asks an undeclared 2025-era server, and takes the skills it lists", async () => {
    expect(served["legacy-undeclared"].calls).toContain("skills/list");
    expect(await activatableNames()).toContain("connector:legacy-undeclared:ondemand");
  });

  it("reads -32601 from a 2025-era server as no skills, quietly and once per window", async () => {
    const names = await activatableNames();
    expect(names.some((n) => n.startsWith("connector:legacy-none:"))).toBe(false);
    const asked = served["legacy-none"].calls.filter((c) => c === "skills/list").length;
    expect(asked).toBe(1);

    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      await runtime.chat({
        identity: DEV_IDENTITY,
        workspaceId: TEST_WORKSPACE_ID,
        message: "quiet",
      });
      const degraded = warn.mock.calls
        .map((c) => c[1] as Record<string, unknown> | undefined)
        .filter((f) => f?.event === "skills.composition.degraded" && f.server === "legacy-none");
      expect(degraded).toEqual([]);
    } finally {
      warn.mockRestore();
    }
    expect(served["legacy-none"].calls.filter((c) => c === "skills/list").length).toBe(asked);
  });

  it("never treats an unlisted skill:// resource as a skill", async () => {
    const names = await activatableNames();
    expect(names.some((n) => n.startsWith("connector:modern-undeclared:"))).toBe(false);
    expect(names.some((n) => n.endsWith(":decoy"))).toBe(false);
  });
});

describe("bodies on need", () => {
  const reads = () =>
    served["modern-declared"].calls.filter((c) => c.startsWith("resources/read")).sort();

  it("composes a verified `always` body and drops one that fails verification", async () => {
    await runtime.chat({
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      message: "hello",
    });
    const prompt = lastPromptText();
    expect(prompt).toContain("LISTED_BODY");
    expect(prompt).not.toContain("TAMPERED_BODY");
    expect(prompt).not.toContain("DECOY_BODY");
    expect(reads()).toEqual([
      "resources/read skill://listed/SKILL.md",
      "resources/read skill://tampered/SKILL.md",
    ]);
  });

  it("serves an unchanged body from the digest cache and does not re-read a failed digest", async () => {
    const before = reads().length;
    await runtime.chat({
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      message: "again",
    });
    expect(lastPromptText()).toContain("LISTED_BODY");
    expect(reads().length).toBe(before);
  });

  // A failure is what one server returned. It must not lock the same digest
  // out of another workspace or server that serves the right bytes.
  it("remembers a verification failure per workspace and server, not per digest", async () => {
    const text = bodies["skill://listed/SKILL.md"]!;
    const entry = skillEntryFor("skill://shared/SKILL.md", text);
    const internals = runtime as unknown as {
      fetchVerifiedSkillText: (ws: string, server: string, e: unknown) => Promise<unknown>;
      loadServerSkillBody: (ws: string, server: string, e: unknown) => Promise<unknown>;
      skillBodyCache: Map<string, string>;
    };
    // The listed body may already be verified by an earlier test; start cold.
    internals.skillBodyCache.clear();
    const fetch = spyOn(internals, "fetchVerifiedSkillText");
    try {
      fetch.mockImplementationOnce(async () => ({ ok: false, reason: "unverified" }));
      expect(await internals.loadServerSkillBody("ws_00079598e311c160", "impostor", entry)).toEqual(
        {
          ok: false,
          reason: "unverified",
        },
      );
      fetch.mockImplementationOnce(async () => ({ ok: true, text }));
      expect(await internals.loadServerSkillBody("ws_001c32f121060ff3", "honest", entry)).toEqual({
        ok: true,
        body: expect.stringContaining("LISTED_BODY"),
      });
    } finally {
      fetch.mockRestore();
    }
  });

  it("fetches an on-demand skill's body when it is activated, verifying a YAML date", async () => {
    const skill = (await runtime.listActivatableSkills(TEST_WORKSPACE_ID, null)).find(
      (s) => s.name === "connector:modern-declared:ondemand",
    );
    const loaded = await skill?.loadBody?.();
    expect(loaded).toEqual({ ok: true, body: expect.stringContaining("ONDEMAND_BODY") });
    expect(reads()).toContain("resources/read skill://ondemand/SKILL.md");
  });
});
