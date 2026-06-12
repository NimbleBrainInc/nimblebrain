import { hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { createDeepResearchTool, type DeepResearchContext } from "../../src/tools/deep-research.ts";
import { ServiceTokenCache, type TenantIdentity } from "../../src/oauth/tenant-key-mint.ts";

const MASTER = randomBytes(32);
const TID = "hq";
const TENANT_KEY = Buffer.from(
  hkdfSync("sha256", MASTER, Buffer.from(TID, "utf8"), Buffer.from("mcp-authorizer/v1"), 32),
);
const IDENTITY: TenantIdentity = { tid: TID, tenantKey: TENANT_KEY };

/** Authorizer stub that mints an aud-encoding token so service fetches can be
 *  asserted to carry the right bearer. */
function mintingCache(): ServiceTokenCache {
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = new URLSearchParams(String(init?.body));
    const wire = body.get("tenant_assertion") ?? "";
    const payload = JSON.parse(
      Buffer.from(wire.split(".")[1] as string, "base64url").toString("utf8"),
    ) as { audience: string };
    return Response.json({
      access_token: `tok-${payload.audience}`,
      token_type: "Bearer",
      expires_in: 300,
    });
  };
  return new ServiceTokenCache({ identity: IDENTITY, fetchImpl, now: () => 1000 });
}

const TASKS_URL = "https://nt.test";
const ARTIFACTS_URL = "https://art.test";

/**
 * Data-plane stub modelling the full deep-research lifecycle: create task →
 * status transitions → terminal result → artifact write. `statuses` drives the
 * GET /tasks/:id sequence; the trailing value sticks once exhausted.
 */
function dataPlane(opts: {
  createStatus?: string;
  statuses: string[];
  result?: unknown;
  resultAvailable?: boolean;
}) {
  const calls: { method: string; url: string; auth: string | null; body?: unknown }[] = [];
  let statusIdx = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("Authorization");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, auth, body });

    if (url === `${TASKS_URL}/v1/tasks` && method === "POST") {
      return Response.json({ task_id: "task_abc", status: opts.createStatus ?? "working" });
    }
    if (url.endsWith("/v1/tasks/task_abc/result")) {
      return Response.json({
        available: opts.resultAvailable ?? true,
        result: opts.result ?? null,
      });
    }
    if (url === `${TASKS_URL}/v1/tasks/task_abc`) {
      const status = opts.statuses[Math.min(statusIdx, opts.statuses.length - 1)] ?? "working";
      statusIdx += 1;
      return Response.json({ task_id: "task_abc", status });
    }
    if (url === `${ARTIFACTS_URL}/v1/artifacts` && method === "POST") {
      return Response.json({
        artifact_id: "art_1",
        uri: "artifact://art_1",
        mime_type: "text/markdown",
        size_bytes: 42,
      });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  };
  return { fetchImpl, calls };
}

function ctxFor(fetchImpl: typeof fetch, over: Partial<DeepResearchContext> = {}): DeepResearchContext {
  // Clock advances 1s per read so the poll deadline is reachable in finite steps.
  let clock = 0;
  return {
    getWorkspaceId: () => "ws_smoke",
    issuer: "https://authz.test",
    nimbletasksUrl: TASKS_URL,
    artifactsUrl: ARTIFACTS_URL,
    cache: mintingCache(),
    baseFetch: fetchImpl,
    now: () => (clock += 1000),
    sleep: async () => {},
    pollIntervalMs: 1,
    maxWaitMs: 60_000,
    ...over,
  };
}

const ENVELOPE_RESULT = {
  isError: false,
  content: [{ type: "text", text: "{}" }],
  structuredContent: {
    report: "# Findings\n\nThe answer.\n",
    sources: [
      { title: "A", url: "https://a.test", source_domain: "a.test" },
      { title: "B", url: "https://b.test", source_domain: "b.test" },
    ],
    query: "what is x",
    provider: "exa",
    completed_at: "2026-06-12T00:00:00Z",
  },
};

describe("nb__deep_research", () => {
  it("creates the task, polls to completion, and writes the report artifact", async () => {
    const dp = dataPlane({ statuses: ["working", "completed"], result: ENVELOPE_RESULT });
    const tool = createDeepResearchTool(ctxFor(dp.fetchImpl));

    const res = await tool.handler({ query: "what is x" });

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      artifact_id: "art_1",
      uri: "artifact://art_1",
      sources: 2,
      task_id: "task_abc",
    });

    // Task created with the right type + audit breadcrumbs, on the fleet audience.
    const create = dp.calls.find((c) => c.url === `${TASKS_URL}/v1/tasks` && c.method === "POST");
    expect(create?.auth).toBe("Bearer tok-mcp-fleet");
    expect(create?.body).toMatchObject({
      task_type: "research.deep_research",
      input: { query: "what is x" },
      mcp_server: "web",
      tool_name: "deep_research",
    });
    expect(String((create?.body as { idempotency_key: string }).idempotency_key)).toMatch(/^dr-/);

    // Artifact written on the artifacts audience, with the markdown report + citations.
    const write = dp.calls.find((c) => c.url === `${ARTIFACTS_URL}/v1/artifacts`);
    expect(write?.auth).toBe("Bearer tok-artifacts");
    const wbody = write?.body as { body_b64: string; mime_type: string; citations: unknown[] };
    expect(wbody.mime_type).toBe("text/markdown");
    expect(Buffer.from(wbody.body_b64, "base64").toString("utf8")).toContain("# Findings");
    expect(wbody.citations).toHaveLength(2);
  });

  it("returns immediately when the task is already terminal on create", async () => {
    const dp = dataPlane({ createStatus: "completed", statuses: [], result: ENVELOPE_RESULT });
    const tool = createDeepResearchTool(ctxFor(dp.fetchImpl));

    const res = await tool.handler({ query: "what is x" });

    expect(res.isError).toBeFalsy();
    // No GET /tasks/:id poll needed — create returned terminal.
    expect(dp.calls.some((c) => c.url === `${TASKS_URL}/v1/tasks/task_abc`)).toBe(false);
  });

  it("falls back to the JSON text content block when structuredContent is absent", async () => {
    const result = {
      isError: false,
      content: [{ type: "text", text: JSON.stringify({ report: "plain report", sources: [] }) }],
    };
    const dp = dataPlane({ statuses: ["completed"], result });
    const tool = createDeepResearchTool(ctxFor(dp.fetchImpl));

    const res = await tool.handler({ query: "q" });
    expect(res.isError).toBeFalsy();
    const write = dp.calls.find((c) => c.url === `${ARTIFACTS_URL}/v1/artifacts`);
    const wbody = write?.body as { body_b64: string };
    expect(Buffer.from(wbody.body_b64, "base64").toString("utf8")).toBe("plain report");
  });

  it("errors (without writing an artifact) when the task fails", async () => {
    const dp = dataPlane({ statuses: ["failed"] });
    const tool = createDeepResearchTool(ctxFor(dp.fetchImpl));

    const res = await tool.handler({ query: "q" });
    expect(res.isError).toBe(true);
    expect(dp.calls.some((c) => c.url === `${ARTIFACTS_URL}/v1/artifacts`)).toBe(false);
  });

  it("times out (no artifact) when the task never reaches a terminal status", async () => {
    const dp = dataPlane({ statuses: ["working"] });
    // Tight deadline: the advancing clock crosses it after a couple of polls.
    const tool = createDeepResearchTool(ctxFor(dp.fetchImpl, { maxWaitMs: 2500 }));

    const res = await tool.handler({ query: "q" });
    expect(res.isError).toBe(true);
    // User-facing text is humanized — the raw "timed out / task <id>" detail
    // goes to the logs, not the result.
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("taking longer than expected");
    expect(text).not.toContain("task_abc");
    expect(dp.calls.some((c) => c.url === `${ARTIFACTS_URL}/v1/artifacts`)).toBe(false);
  });

  it("humanizes a service/cert failure — no raw technical detail in the result", async () => {
    // The mint/data-plane fetch throws like a TLS verification failure.
    const svc: typeof fetch = async () => {
      throw new Error(
        "mint POST to https://mcp-authorizer.mcp-shared.svc/token failed: " +
          "unable to verify the first certificate",
      );
    };
    const tool = createDeepResearchTool(ctxFor(svc));

    const res = await tool.handler({ query: "q" });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("temporarily unavailable");
    // None of the raw detail leaks to the user.
    expect(text).not.toContain("certificate");
    expect(text).not.toContain("mcp-authorizer");
    expect(text).not.toContain("https://");
  });

  it("errors when no workspace is bound", async () => {
    const dp = dataPlane({ statuses: ["completed"], result: ENVELOPE_RESULT });
    const tool = createDeepResearchTool(ctxFor(dp.fetchImpl, { getWorkspaceId: () => null }));

    const res = await tool.handler({ query: "q" });
    expect(res.isError).toBe(true);
    expect(dp.calls).toHaveLength(0);
  });

  it("rejects an empty query before any network call", async () => {
    const dp = dataPlane({ statuses: ["completed"], result: ENVELOPE_RESULT });
    const tool = createDeepResearchTool(ctxFor(dp.fetchImpl));

    const res = await tool.handler({ query: "   " });
    expect(res.isError).toBe(true);
    expect(dp.calls).toHaveLength(0);
  });
});
