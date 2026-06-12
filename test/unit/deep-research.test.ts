import { hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { createDeepResearchTool, type DeepResearchContext } from "../../src/tools/deep-research.ts";
import type { OutputStore, PutInput, Ref } from "../../src/files/output-store.ts";
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

/**
 * NimbleTasks stub modelling the deep-research task lifecycle: create task →
 * status transitions → terminal result. `statuses` drives the GET /tasks/:id
 * sequence; the trailing value sticks once exhausted. Persistence is NOT here
 * anymore — it goes through the injected OutputStore (the seam).
 */
function tasksPlane(opts: {
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
    throw new Error(`unexpected request ${method} ${url}`);
  };
  return { fetchImpl, calls };
}

/** Recording fake OutputStore. `put` captures the input + returns a `files://`
 *  ref; `throwOnPut` makes the write fail to drive the persistence-failure path. */
function fakeStore(opts: { throwOnPut?: boolean } = {}) {
  const puts: Array<{ scope: { workspace: string }; input: PutInput }> = [];
  const store: OutputStore = {
    async put(scope, input): Promise<Ref> {
      puts.push({ scope, input });
      if (opts.throwOnPut) throw new Error("artifacts service 503");
      const bodyLen =
        typeof input.body === "string" ? input.body.length : input.body.byteLength;
      return {
        id: "out_1",
        uri: "files://out_1",
        mime: input.mime,
        sizeBytes: bodyLen,
        kind: input.kind,
        scope,
        producedBy: input.producedBy,
      };
    },
    async get() {
      throw new Error("not used");
    },
    async list() {
      return [];
    },
  };
  return { store, puts };
}

function ctxFor(
  fetchImpl: typeof fetch,
  store: OutputStore | null,
  over: Partial<DeepResearchContext> = {},
): DeepResearchContext {
  // Clock advances 1s per read so the poll deadline is reachable in finite steps.
  let clock = 0;
  return {
    getWorkspaceId: () => "ws_smoke",
    taskRunner: { baseUrl: TASKS_URL, issuer: "https://authz.test" },
    store,
    cache: mintingCache(),
    baseFetch: fetchImpl,
    now: () => (clock += 1000),
    sleep: async () => {},
    pollIntervalMs: 1,
    maxWaitMs: 60_000,
    ...over,
  };
}

const REPORT = "# Findings\n\nThe answer is forty-two and here is the supporting evidence.\n";

const ENVELOPE_RESULT = {
  isError: false,
  content: [{ type: "text", text: "{}" }],
  structuredContent: {
    report: REPORT,
    sources: [
      { title: "A", url: "https://a.test", source_domain: "a.test" },
      { title: "B", url: "https://b.test", source_domain: "b.test" },
    ],
    query: "what is x",
    provider: "exa",
    completed_at: "2026-06-12T00:00:00Z",
  },
};

function textOf(res: { content: unknown[] }): string {
  const block = res.content.find(
    (b) => (b as { type?: string }).type === "text",
  ) as { text: string } | undefined;
  return block?.text ?? "";
}

function resourceLinkOf(res: { content: unknown[] }) {
  return res.content.find((b) => (b as { type?: string }).type === "resource_link") as
    | { type: string; uri: string; name?: string; mimeType?: string }
    | undefined;
}

describe("nb__deep_research", () => {
  it("persists the report through the store and returns a resource_link + short summary (NOT the report inline)", async () => {
    const dp = tasksPlane({ statuses: ["working", "completed"], result: ENVELOPE_RESULT });
    const fs = fakeStore();
    const tool = createDeepResearchTool(ctxFor(dp.fetchImpl, fs.store));

    const res = await tool.handler({ query: "what is x" });

    expect(res.isError).toBeFalsy();

    // The result is a SHORT one-line text summary + a resource_link to the
    // stored output. The report text does NOT live in `content` — so the
    // conversation log persists the REF, not a ~17KB jsonl line replayed every
    // turn. (No worker-envelope marker, no report body, in the text block.)
    const text = textOf(res);
    expect(text).toContain("Deep research complete");
    expect(text).toContain("2 sources");
    expect(text).not.toContain("# Findings");
    expect(text).not.toContain("forty-two");
    // The text instructs the model NOT to reproduce the report (the UI renders
    // it) — this is what stops the model re-emitting the full report (the box +
    // duplicate-text + per-turn replay bug).
    expect(text).toContain("Do NOT reproduce");
    // Still small — a directive, not the report (report would be ~17KB).
    expect(text.length).toBeLessThan(500);

    // The resource_link points at the stored `files://<id>` ref.
    const link = resourceLinkOf(res);
    expect(link).toBeDefined();
    expect(link?.uri).toBe("files://out_1");
    expect(link?.mimeType).toBe("text/markdown");
    expect(link?.name).toContain("Deep research");

    // The FULL report IS persisted to the store (full body, with citations).
    expect(fs.puts).toHaveLength(1);
    const put = fs.puts[0]!;
    expect(put.scope.workspace).toBe("ws_smoke");
    expect(put.input.kind).toBe("report");
    expect(put.input.producedBy).toBe("tool:deep_research");
    expect(put.input.mime).toBe("text/markdown");
    expect(put.input.body).toBe(REPORT);
    expect(put.input.citations).toHaveLength(2);

    // structuredContent carries the ref, not the report.
    expect(res.structuredContent).toMatchObject({
      output_id: "out_1",
      uri: "files://out_1",
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
  });

  it("falls back to a BOUNDED INLINE report when no store resolves (off-platform)", async () => {
    const dp = tasksPlane({ statuses: ["completed"], result: ENVELOPE_RESULT });
    const tool = createDeepResearchTool(ctxFor(dp.fetchImpl, null));

    const res = await tool.handler({ query: "what is x" });

    expect(res.isError).toBeFalsy();
    // No store ⇒ the REAL report is returned inline so research still works.
    const text = textOf(res);
    expect(text).toContain("# Findings");
    expect(text).toContain("forty-two");
    expect(text).toContain("do not add facts that are not in it");
    // No resource_link without a store.
    expect(resourceLinkOf(res)).toBeUndefined();
    expect(res.structuredContent).toMatchObject({ inline_fallback: true });
  });

  it("bounds an over-cap inline report when no store resolves", async () => {
    const big = `# Big\n\n${"x".repeat(20_000)}`;
    const result = { isError: false, structuredContent: { report: big, sources: [], query: "q" } };
    const dp = tasksPlane({ statuses: ["completed"], result });
    const tool = createDeepResearchTool(ctxFor(dp.fetchImpl, null));

    const res = await tool.handler({ query: "q" });
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain("[Report truncated");
    expect(res.structuredContent).toMatchObject({ report_truncated: true, inline_fallback: true });
  });

  it("inline-falls-back the REAL report (no fabrication) when OutputStore.put fails", async () => {
    const dp = tasksPlane({ statuses: ["completed"], result: ENVELOPE_RESULT });
    const fs = fakeStore({ throwOnPut: true });
    const tool = createDeepResearchTool(ctxFor(dp.fetchImpl, fs.store));

    const res = await tool.handler({ query: "what is x" });

    // The write failed, but we HAVE the real report — return it inline (real
    // content, not a fabrication), never an empty success.
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain("# Findings");
    expect(text).toContain("forty-two");
    expect(text).toContain("couldn't save it durably");
    // No resource_link — there's no durable ref to point at.
    expect(resourceLinkOf(res)).toBeUndefined();
    // The put WAS attempted (the real report, full).
    expect(fs.puts).toHaveLength(1);
    expect(fs.puts[0]!.input.body).toBe(REPORT);
    expect(res.structuredContent).toMatchObject({ inline_fallback: true });
  });

  it("returns immediately when the task is already terminal on create", async () => {
    const dp = tasksPlane({ createStatus: "completed", statuses: [], result: ENVELOPE_RESULT });
    const fs = fakeStore();
    const tool = createDeepResearchTool(ctxFor(dp.fetchImpl, fs.store));

    const res = await tool.handler({ query: "what is x" });

    expect(res.isError).toBeFalsy();
    // No GET /tasks/:id poll needed — create returned terminal.
    expect(dp.calls.some((c) => c.url === `${TASKS_URL}/v1/tasks/task_abc`)).toBe(false);
    expect(fs.puts).toHaveLength(1);
  });

  it("falls back to the JSON text content block when structuredContent is absent", async () => {
    const result = {
      isError: false,
      content: [{ type: "text", text: JSON.stringify({ report: "plain report", sources: [] }) }],
    };
    const dp = tasksPlane({ statuses: ["completed"], result });
    const fs = fakeStore();
    const tool = createDeepResearchTool(ctxFor(dp.fetchImpl, fs.store));

    const res = await tool.handler({ query: "q" });
    expect(res.isError).toBeFalsy();
    expect(fs.puts[0]!.input.body).toBe("plain report");
  });

  it("FAILS HARD (no store write, no fabrication) when the task fails", async () => {
    const dp = tasksPlane({ statuses: ["failed"] });
    const fs = fakeStore();
    const tool = createDeepResearchTool(ctxFor(dp.fetchImpl, fs.store));

    const res = await tool.handler({ query: "q" });
    expect(res.isError).toBe(true);
    // No real report ⇒ never touch the store.
    expect(fs.puts).toHaveLength(0);
  });

  it("times out (no store write) when the task never reaches a terminal status", async () => {
    const dp = tasksPlane({ statuses: ["working"] });
    const fs = fakeStore();
    // Tight deadline: the advancing clock crosses it after a couple of polls.
    const tool = createDeepResearchTool(ctxFor(dp.fetchImpl, fs.store, { maxWaitMs: 2500 }));

    const res = await tool.handler({ query: "q" });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain("taking longer than expected");
    expect(text).not.toContain("task_abc");
    expect(fs.puts).toHaveLength(0);
  });

  it("humanizes a service/cert failure — no raw technical detail in the result", async () => {
    const svc: typeof fetch = async () => {
      throw new Error(
        "mint POST to https://mcp-authorizer.mcp-shared.svc/token failed: " +
          "unable to verify the first certificate",
      );
    };
    const fs = fakeStore();
    const tool = createDeepResearchTool(ctxFor(svc, fs.store));

    const res = await tool.handler({ query: "q" });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain("temporarily unavailable");
    expect(text).not.toContain("certificate");
    expect(text).not.toContain("mcp-authorizer");
    expect(text).not.toContain("https://");
    expect(fs.puts).toHaveLength(0);
  });

  it("errors when no workspace is bound", async () => {
    const dp = tasksPlane({ statuses: ["completed"], result: ENVELOPE_RESULT });
    const fs = fakeStore();
    const tool = createDeepResearchTool(ctxFor(dp.fetchImpl, fs.store, { getWorkspaceId: () => null }));

    const res = await tool.handler({ query: "q" });
    expect(res.isError).toBe(true);
    expect(dp.calls).toHaveLength(0);
    expect(fs.puts).toHaveLength(0);
  });

  it("rejects an empty query before any network call", async () => {
    const dp = tasksPlane({ statuses: ["completed"], result: ENVELOPE_RESULT });
    const fs = fakeStore();
    const tool = createDeepResearchTool(ctxFor(dp.fetchImpl, fs.store));

    const res = await tool.handler({ query: "   " });
    expect(res.isError).toBe(true);
    expect(dp.calls).toHaveLength(0);
    expect(fs.puts).toHaveLength(0);
  });
});
