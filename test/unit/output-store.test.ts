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
  type OutputStore,
  OutputStoreDisabledError,
  resolveOutputStore,
  resolveTaskRunner,
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

  it("round-trips kind/producedBy/scope and resolves a files:// ref", async () => {
    const out = createLocalOutputStore({ resolveStore: () => store });
    const ref = await out.put(SCOPE, {
      kind: "report",
      producedBy: "tool:deep_research",
      mime: "text/markdown",
      body: "# Findings\nthe answer is 42",
      title: "Deep research",
    });

    expect(ref.uri).toBe(`files://${ref.id}`);
    expect(ref.uri.startsWith("artifact://")).toBe(false);
    // The Ref carries the discriminator metadata + the fencing scope.
    expect(ref.kind).toBe("report");
    expect(ref.producedBy).toBe("tool:deep_research");
    expect(ref.scope).toEqual(SCOPE);

    const got = await out.get(SCOPE, ref.id);
    expect(decodeOutputText(got)).toBe("# Findings\nthe answer is 42");
    expect(got.meta.kind).toBe("report");
    expect(got.meta.producedBy).toBe("tool:deep_research");
    expect(got.meta.workspace).toBe(SCOPE.workspace);
    expect(got.meta.title).toBe("Deep research");
    expect(got.meta.mime).toBe("text/markdown");
  });

  it("returns the FULL body for a >12K output (no truncation)", async () => {
    const out = createLocalOutputStore({ resolveStore: () => store });
    // 12K is the read_resource peek cap; prove get is uncapped well past it.
    const big = "x".repeat(13_000) + "TAIL_SENTINEL";
    const ref = await out.put(SCOPE, { kind: "report", mime: "text/plain", body: big });

    const got = await out.get(SCOPE, ref.id);
    const text = decodeOutputText(got);
    expect(text.length).toBe(big.length);
    expect(text).toBe(big);
    expect(text.endsWith("TAIL_SENTINEL")).toBe(true);
    expect(got.meta.sizeBytes).toBe(big.length);
  });

  it("list returns metadata for every put, newest first", async () => {
    const out = createLocalOutputStore({ resolveStore: () => store });
    const a = await out.put(SCOPE, { kind: "report", mime: "text/plain", body: "a", title: "A" });
    const b = await out.put(SCOPE, { kind: "doc", mime: "text/plain", body: "bb", title: "B" });

    const metas = await out.list(SCOPE);
    expect(metas.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
    const byId = new Map(metas.map((m) => [m.id, m]));
    expect(byId.get(a.id)?.title).toBe("A");
    expect(byId.get(b.id)?.kind).toBe("doc");
    expect(byId.get(b.id)?.sizeBytes).toBe(2);
  });

  it("list filters by kind", async () => {
    const out = createLocalOutputStore({ resolveStore: () => store });
    await out.put(SCOPE, { kind: "report", mime: "text/plain", body: "a" });
    await out.put(SCOPE, { kind: "doc", mime: "text/plain", body: "b" });

    const reports = await out.list(SCOPE, { kind: "report" });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.kind).toBe("report");
  });

  it("fences across workspaces: a put in A is NOT gettable/listable in B (the 002b bug fix)", async () => {
    // ONE shared underlying FileStore — fencing must hold even when the backend
    // can't rely on a per-workspace store (the regression guard). With the
    // runtime wiring (a store rooted under workspaces/{wsId}/files) the fence is
    // additionally structural; here we prove the in-backend check.
    const out = createLocalOutputStore({ resolveStore: () => store });
    const A: OutputScope = { workspace: "ws_alpha" };
    const B: OutputScope = { workspace: "ws_beta" };

    const ref = await out.put(A, {
      kind: "report",
      mime: "text/plain",
      body: "alpha-only secret",
      title: "Alpha report",
    });

    // Retrievable in A.
    const inA = await out.get(A, ref.id);
    expect(decodeOutputText(inA)).toBe("alpha-only secret");
    expect((await out.list(A)).map((m) => m.id)).toContain(ref.id);

    // NOT retrievable in B — get rejects, list excludes it.
    await expect(out.get(B, ref.id)).rejects.toThrow(/not found/);
    expect((await out.list(B)).map((m) => m.id)).not.toContain(ref.id);
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
      kind: "report",
      producedBy: "tool:deep_research",
      mime: "text/markdown",
      body: "report",
      title: "Deep research",
    });

    expect(ref.id).toBe("art_1");
    // The ref surfaced to callers is files://, NOT the server's artifact:// uri.
    expect(ref.uri).toBe("files://art_1");
    expect(ref.kind).toBe("report");
    expect(ref.producedBy).toBe("tool:deep_research");
    expect(ref.scope).toEqual(SCOPE);
    expect(seen?.method).toBe("POST");
    expect(seen?.url).toBe(`${BASE}/v1/artifacts`);
    expect(seen?.auth).toBe("Bearer tok-artifacts-artifacts:write");
    // `kind` is sent as the artifacts `type`; `producedBy` as `source`.
    expect((seen?.body as { type: string }).type).toBe("report");
    expect((seen?.body as { source?: string }).source).toBe("tool:deep_research");
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
        source: "tool:deep_research",
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
    expect(got.meta.kind).toBe("report");
    expect(got.meta.producedBy).toBe("tool:deep_research");
    expect(got.meta.workspace).toBe("ws_smoke");
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

    const metas = await out.list(SCOPE, { kind: "report" });
    expect(auth).toBe("Bearer tok-artifacts-artifacts:read");
    expect(url.startsWith(`${BASE}/v1/artifacts`)).toBe(true);
    expect(url).toContain("type=report");
    expect(metas).toHaveLength(1);
    expect(metas[0]?.uri).toBe("files://art_1");
    expect(metas[0]?.kind).toBe("report");
  });
});

// ---------------------------------------------------------------------------
// null backend
// ---------------------------------------------------------------------------

describe("null OutputStore", () => {
  it("rejects put/get/list with a typed disabled error", async () => {
    const out = createNullOutputStore();
    await expect(out.put(SCOPE, { kind: "report", mime: "text/plain", body: "x" })).rejects.toBeInstanceOf(
      OutputStoreDisabledError,
    );
    await expect(out.get(SCOPE, "art_1")).rejects.toBeInstanceOf(OutputStoreDisabledError);
    await expect(out.list(SCOPE)).rejects.toBeInstanceOf(OutputStoreDisabledError);
    await expect(out.get(SCOPE, "art_1")).rejects.toMatchObject({ code: "output_store_disabled" });
  });
});

// ---------------------------------------------------------------------------
// provider selection (task 005)
// ---------------------------------------------------------------------------

describe("resolveOutputStore", () => {
  const DATAPLANE = {} as OutputStore;
  const LOCAL = {} as OutputStore;
  const makeDataplane = () => DATAPLANE;
  const makeLocal = () => LOCAL;
  const URL = "https://artifacts.test";

  it("defaults to local when nothing is configured (zero-infra)", () => {
    const sel = resolveOutputStore({ makeDataplane, makeLocal });
    expect(sel.kind).toBe("local");
    expect(sel.store).toBe(LOCAL);
    expect(sel.reason).toContain("local");
  });

  it("selects dataplane when issuer + URL are present", () => {
    const sel = resolveOutputStore({ issuer: ISSUER, dataplaneUrl: URL, makeDataplane, makeLocal });
    expect(sel.kind).toBe("dataplane");
    expect(sel.store).toBe(DATAPLANE);
  });

  it("stays local when only one of issuer/URL is present", () => {
    expect(resolveOutputStore({ issuer: ISSUER, makeDataplane, makeLocal }).kind).toBe("local");
    expect(resolveOutputStore({ dataplaneUrl: URL, makeDataplane, makeLocal }).kind).toBe("local");
  });

  it("forces null with NB_OUTPUT_STORE=none even when the data plane is configured", () => {
    const sel = resolveOutputStore({
      force: "none",
      issuer: ISSUER,
      dataplaneUrl: URL,
      makeDataplane,
      makeLocal,
    });
    expect(sel.kind).toBe("null");
    // the disabled store is real, not a stub — every method rejects.
    return expect(sel.store.get(SCOPE, "x")).rejects.toBeInstanceOf(OutputStoreDisabledError);
  });

  it("forces local with NB_OUTPUT_STORE=local even when the data plane is configured", () => {
    const sel = resolveOutputStore({
      force: "local",
      issuer: ISSUER,
      dataplaneUrl: URL,
      makeDataplane,
      makeLocal,
    });
    expect(sel.kind).toBe("local");
    expect(sel.store).toBe(LOCAL);
  });

  it("forced dataplane with no URL fails closed to null (not local)", () => {
    const sel = resolveOutputStore({ force: "dataplane", makeDataplane, makeLocal });
    expect(sel.kind).toBe("null");
    expect(sel.reason).toContain("fail closed");
  });
});

describe("resolveTaskRunner", () => {
  const URL = "https://nimbletasks.test";

  it("defaults to null when no data plane is configured", () => {
    const sel = resolveTaskRunner({});
    expect(sel.kind).toBe("null");
    expect(sel.dataplane).toBeUndefined();
  });

  it("selects dataplane when issuer + nimbletasks URL are present", () => {
    const sel = resolveTaskRunner({ issuer: ISSUER, nimbletasksUrl: URL });
    expect(sel.kind).toBe("dataplane");
    expect(sel.dataplane).toEqual({ baseUrl: URL, issuer: ISSUER });
  });

  it("forces null with NB_TASK_RUNNER=none even when configured", () => {
    const sel = resolveTaskRunner({ force: "none", issuer: ISSUER, nimbletasksUrl: URL });
    expect(sel.kind).toBe("null");
  });
});
