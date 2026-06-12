import { hkdfSync, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createFileStore, type FileStore } from "../../src/files/store.ts";
import {
  createDataplaneOutputStore,
  createLocalOutputStore,
  createNullOutputStore,
  decodeOutputText,
  type OutputScope,
  OutputStoreDisabledError,
} from "../../src/files/output-store.ts";
import { ServiceTokenCache, type TenantIdentity } from "../../src/oauth/tenant-key-mint.ts";

const MASTER = randomBytes(32);
const TID = "hq";
const TENANT_KEY = Buffer.from(
  hkdfSync("sha256", MASTER, Buffer.from(TID, "utf8"), Buffer.from("mcp-authorizer/v1"), 32),
);
const IDENTITY: TenantIdentity = { tid: TID, tenantKey: TENANT_KEY };
const ISSUER = "https://authz.test";
const SCOPE: OutputScope = { workspace: "ws_smoke" };

/** A fake authorizer that mints a bearer encoding the requested aud + scope, so
 *  the service fetch can assert the exact (audience, scope) the runtime minted. */
function fakeAuthorizer(): typeof fetch {
  return (async (_input, init) => {
    const body = new URLSearchParams(String(init?.body));
    const wire = body.get("tenant_assertion") ?? "";
    const payload = JSON.parse(
      Buffer.from(wire.split(".")[1] as string, "base64url").toString("utf8"),
    ) as { audience: string; scope: string };
    return Response.json({
      access_token: `tok-${payload.audience}-${payload.scope}`,
      token_type: "Bearer",
      expires_in: 300,
    });
  }) as typeof fetch;
}

function cache(): ServiceTokenCache {
  return new ServiceTokenCache({ identity: IDENTITY, fetchImpl: fakeAuthorizer(), now: () => 1000 });
}

// ---------------------------------------------------------------------------
// local backend
// ---------------------------------------------------------------------------

describe("local OutputStore", () => {
  let dir: string;
  let store: FileStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "output-store-"));
    store = createFileStore(join(dir, "files"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a body verbatim and resolves a files:// ref", async () => {
    const out = createLocalOutputStore({ resolveStore: () => store });
    const ref = await out.put(SCOPE, {
      type: "report",
      mime: "text/markdown",
      body: "# Findings\nthe answer is 42",
      title: "Deep research",
    });

    expect(ref.uri).toBe(`files://${ref.id}`);
    expect(ref.uri.startsWith("artifact://")).toBe(false);

    const got = await out.get(SCOPE, ref.id);
    expect(decodeOutputText(got)).toBe("# Findings\nthe answer is 42");
    expect(got.meta.type).toBe("report");
    expect(got.meta.title).toBe("Deep research");
    expect(got.meta.mime).toBe("text/markdown");
  });

  it("returns the FULL body for a >12K output (no truncation)", async () => {
    const out = createLocalOutputStore({ resolveStore: () => store });
    // 12K is the read_resource peek cap; prove get is uncapped well past it.
    const big = "x".repeat(13_000) + "TAIL_SENTINEL";
    const ref = await out.put(SCOPE, { type: "report", mime: "text/plain", body: big });

    const got = await out.get(SCOPE, ref.id);
    const text = decodeOutputText(got);
    expect(text.length).toBe(big.length);
    expect(text).toBe(big);
    expect(text.endsWith("TAIL_SENTINEL")).toBe(true);
    expect(got.meta.sizeBytes).toBe(big.length);
  });

  it("list returns metadata for every put, newest first", async () => {
    const out = createLocalOutputStore({ resolveStore: () => store });
    const a = await out.put(SCOPE, { type: "report", mime: "text/plain", body: "a", title: "A" });
    const b = await out.put(SCOPE, { type: "doc", mime: "text/plain", body: "bb", title: "B" });

    const metas = await out.list(SCOPE);
    expect(metas.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
    const byId = new Map(metas.map((m) => [m.id, m]));
    expect(byId.get(a.id)?.title).toBe("A");
    expect(byId.get(b.id)?.type).toBe("doc");
    expect(byId.get(b.id)?.sizeBytes).toBe(2);
  });

  it("list filters by type", async () => {
    const out = createLocalOutputStore({ resolveStore: () => store });
    await out.put(SCOPE, { type: "report", mime: "text/plain", body: "a" });
    await out.put(SCOPE, { type: "doc", mime: "text/plain", body: "b" });

    const reports = await out.list(SCOPE, { type: "report" });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.type).toBe("report");
  });
});

// ---------------------------------------------------------------------------
// dataplane backend
// ---------------------------------------------------------------------------

describe("dataplane OutputStore", () => {
  const BASE = "https://artifacts.test";

  it("put writes via POST with an aud=artifacts scope=artifacts:write bearer", async () => {
    let seen: { url: string; method: string; auth: string | null; body: unknown } | undefined;
    const svc: typeof fetch = (async (input, init) => {
      seen = {
        url: String(input),
        method: init?.method ?? "GET",
        auth: new Headers(init?.headers).get("Authorization"),
        body: JSON.parse(String(init?.body)),
      };
      return Response.json({
        artifact_id: "art_1",
        uri: "artifact://art_1",
        mime_type: "text/markdown",
        size_bytes: 6,
      });
    }) as typeof fetch;

    const out = createDataplaneOutputStore({
      baseUrl: BASE,
      issuer: ISSUER,
      cache: cache(),
      baseFetch: svc,
      idempotencyKey: () => "idem-1",
    });

    const ref = await out.put(SCOPE, {
      type: "report",
      mime: "text/markdown",
      body: "report",
      title: "Deep research",
    });

    expect(ref.id).toBe("art_1");
    // The ref surfaced to callers is files://, NOT the server's artifact:// uri.
    expect(ref.uri).toBe("files://art_1");
    expect(seen?.method).toBe("POST");
    expect(seen?.url).toBe(`${BASE}/v1/artifacts`);
    expect(seen?.auth).toBe("Bearer tok-artifacts-artifacts:write");
    expect((seen?.body as { type: string }).type).toBe("report");
  });

  it("get fetches content with a SEPARATE aud=artifacts scope=artifacts:read bearer", async () => {
    const auths: Record<string, string | null> = {};
    const svc: typeof fetch = (async (input, init) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("Authorization");
      if (url.endsWith("/content")) {
        auths.content = auth;
        return new Response("the full report bytes", {
          headers: { "content-type": "text/markdown" },
        });
      }
      auths.meta = auth;
      return Response.json({
        artifact_id: "art_1",
        uri: "artifact://art_1",
        workspace_id: "ws_smoke",
        type: "report",
        mime_type: "text/markdown",
        title: "Deep research",
        size_bytes: 21,
        citations: [{ title: "Src", url: "https://src.test" }],
        created_at: "2026-06-12T00:00:00Z",
      });
    }) as typeof fetch;

    const out = createDataplaneOutputStore({
      baseUrl: BASE,
      issuer: ISSUER,
      cache: cache(),
      baseFetch: svc,
    });

    const got = await out.get(SCOPE, "art_1");

    // Read path mints a DISTINCT read-scoped token, not the write token.
    expect(auths.content).toBe("Bearer tok-artifacts-artifacts:read");
    expect(auths.meta).toBe("Bearer tok-artifacts-artifacts:read");
    expect(decodeOutputText(got)).toBe("the full report bytes");
    expect(got.meta.uri).toBe("files://art_1");
    expect(got.meta.title).toBe("Deep research");
    expect(got.meta.citations).toEqual([{ title: "Src", url: "https://src.test" }]);
  });

  it("list reads metadata with an artifacts:read bearer", async () => {
    let auth: string | null = null;
    let url = "";
    const svc: typeof fetch = (async (input, init) => {
      url = String(input);
      auth = new Headers(init?.headers).get("Authorization");
      return Response.json({
        artifacts: [
          {
            artifact_id: "art_1",
            uri: "artifact://art_1",
            workspace_id: "ws_smoke",
            type: "report",
            mime_type: "text/markdown",
            title: "Deep research",
            size_bytes: 6,
          },
        ],
        next_cursor: null,
      });
    }) as typeof fetch;

    const out = createDataplaneOutputStore({
      baseUrl: BASE,
      issuer: ISSUER,
      cache: cache(),
      baseFetch: svc,
    });

    const metas = await out.list(SCOPE, { type: "report" });
    expect(auth).toBe("Bearer tok-artifacts-artifacts:read");
    expect(url.startsWith(`${BASE}/v1/artifacts`)).toBe(true);
    expect(url).toContain("type=report");
    expect(metas).toHaveLength(1);
    expect(metas[0]?.uri).toBe("files://art_1");
    expect(metas[0]?.type).toBe("report");
  });
});

// ---------------------------------------------------------------------------
// null backend
// ---------------------------------------------------------------------------

describe("null OutputStore", () => {
  it("rejects put/get/list with a typed disabled error", async () => {
    const out = createNullOutputStore();
    await expect(out.put(SCOPE, { type: "report", mime: "text/plain", body: "x" })).rejects.toBeInstanceOf(
      OutputStoreDisabledError,
    );
    await expect(out.get(SCOPE, "art_1")).rejects.toBeInstanceOf(OutputStoreDisabledError);
    await expect(out.list(SCOPE)).rejects.toBeInstanceOf(OutputStoreDisabledError);
    await expect(out.get(SCOPE, "art_1")).rejects.toMatchObject({ code: "output_store_disabled" });
  });
});
