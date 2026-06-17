import { describe, expect, it } from "bun:test";
import {
  ArtifactNotFoundError,
  ArtifactReadClient,
  ArtifactResolver,
  isArtifactUri,
  uriToArtifactId,
} from "../../src/host-resources/artifacts/index.ts";
import { ServiceTokenCache, type TenantIdentity } from "../../src/oauth/tenant-key-mint.ts";

// ---------------------------------------------------------------------------
// Behavioral tests for the generic artifact:// host resolver.
//
// The resolver reads from the data plane AS THE VIEWING USER: the verified
// workspace scopes a minted aud=artifacts/artifacts:read token, and the data
// plane's RLS is the enforcement point. We model that end-to-end with two fakes:
//
//   - a fake authorizer that mints a token whose claims echo the workspace the
//     runtime asked for (mirroring the real exchange), and
//   - a fake artifacts service that decodes the token's workspace, looks up the
//     row, and returns 404 if the row's workspace differs — exactly the RLS
//     behavior, exercised through the same minting/exchange machinery the
//     production path uses.
//
// No real network, no real keys; the point is the IDENTITY plumbing and the
// untrusted-bytes contract, not crypto (covered by tenant-key-mint.test.ts).
// ---------------------------------------------------------------------------

const TID = "tenant-a";
const ISSUER = "https://authorizer.test";
const DATA_PLANE = "https://artifacts.test";

// A 32-byte tenant key (the cache validates length, not content, when the
// authorizer fetch is faked).
const TENANT_KEY = Buffer.alloc(32, 7);
const IDENTITY: TenantIdentity = { tid: TID, tenantKey: TENANT_KEY };

/**
 * One artifact row in the fake store. `body` is the raw inline bytes the data
 * plane streams from `/content` for a small artifact; `presignedUrl` (with the
 * bytes under `presigned`) models a large artifact spilled to object storage,
 * where `/content` answers a 302 redirect instead of bytes.
 */
interface Row {
  workspace: string;
  mimeType: string;
  body?: Uint8Array;
  presignedUrl?: string;
}

/**
 * Build a fake `fetch` that plays BOTH the authorizer (`/token`) and the
 * artifacts service. The minted token is a JSON blob naming the workspace the
 * runtime requested; the artifacts service reads that workspace back off the
 * bearer and fences rows by it (the RLS gate).
 *
 * The service mirrors the data plane's ACTUAL two-endpoint read shape, mounted
 * under the versioned `/v1/artifacts` prefix the live service uses:
 *   - `GET /v1/artifacts/{id}`          → metadata JSON ({ mime_type, ... }), NO body
 *   - `GET /v1/artifacts/{id}/content`  → raw inline bytes (200), or a 302 redirect
 *                                        to a presigned URL for a spilled body
 * It deliberately does NOT return any inline-body field on the metadata row —
 * that would be a wire shape the service never emits.
 */
function makeDataPlaneFetch(
  rows: Record<string, Row>,
  presigned?: Record<string, Uint8Array>,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input.toString();

    // (1) Token mint at the authorizer — echo the requested workspace into the
    // minted bearer so the downstream service can fence on it.
    if (url === `${ISSUER}/token`) {
      const body = new URLSearchParams(String(init?.body ?? ""));
      const assertion = body.get("tenant_assertion") ?? "";
      // The assertion is `v1.<payloadB64url>.<mac>`; pull the workspace out.
      const payloadB64 = assertion.split(".")[1] ?? "";
      const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as {
        workspace: string;
        audience: string;
        scope: string;
      };
      const token = Buffer.from(
        JSON.stringify({
          workspace: payload.workspace,
          aud: payload.audience,
          scope: payload.scope,
        }),
      ).toString("base64url");
      return new Response(JSON.stringify({ access_token: token, expires_in: 300 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // (2) Presigned-URL leg — unauthenticated fetch of large bytes.
    if (presigned && url.startsWith("https://presigned.test/")) {
      const key = url.slice("https://presigned.test/".length);
      const bytes = presigned[key];
      if (!bytes) return new Response("gone", { status: 404 });
      return new Response(bytes, { status: 200 });
    }

    // (3) Artifacts service read — decode the bearer's workspace and fence.
    // The live service mounts its router under `/v1/artifacts`; the client must
    // hit that versioned prefix. Anything under the un-versioned `/artifacts/`
    // path falls through to the 500 below, so a dropped `/v1` fails the test.
    if (url.startsWith(`${DATA_PLANE}/v1/artifacts/`)) {
      const auth = new Headers(init?.headers).get("Authorization") ?? "";
      const bearer = auth.replace(/^Bearer\s+/, "");
      const claims = JSON.parse(Buffer.from(bearer, "base64url").toString("utf8")) as {
        workspace: string;
      };
      const rest = url.slice(`${DATA_PLANE}/v1/artifacts/`.length);
      const isContent = rest.endsWith("/content");
      const id = decodeURIComponent(isContent ? rest.slice(0, -"/content".length) : rest);
      const row = rows[id];
      // RLS: the row is invisible unless its workspace matches the caller's.
      if (!row || row.workspace !== claims.workspace) {
        return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      }

      // /content: stream inline bytes, or 302 to the presigned URL for a
      // spilled body — exactly the data plane's content endpoint.
      if (isContent) {
        if (row.presignedUrl !== undefined) {
          return new Response(null, {
            status: 302,
            headers: { location: row.presignedUrl },
          });
        }
        return new Response(row.body ?? new Uint8Array(), {
          status: 200,
          headers: { "content-type": row.mimeType },
        });
      }

      // /{id}: metadata only — never any body bytes.
      return new Response(JSON.stringify({ mime_type: row.mimeType }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("unexpected url: " + url, { status: 500 });
  }) as typeof fetch;
}

function makeResolver(
  rows: Record<string, Row>,
  presigned?: Record<string, Uint8Array>,
): ArtifactResolver {
  const dataPlaneFetch = makeDataPlaneFetch(rows, presigned);
  const cache = new ServiceTokenCache({ identity: IDENTITY, fetchImpl: dataPlaneFetch });
  const client = new ArtifactReadClient({
    config: { baseUrl: DATA_PLANE, issuer: ISSUER },
    cache,
    fetchImpl: dataPlaneFetch,
  });
  // The resolver's presigned-URL leg uses its own fetch; share the fake so the
  // presigned bytes are reachable.
  return new ArtifactResolver(client, undefined, dataPlaneFetch);
}

const WS_A = "ws_aaaa";
const WS_B = "ws_bbbb";

describe("artifact:// URI parsing", () => {
  it("recognizes the artifact scheme and extracts the id", () => {
    expect(isArtifactUri("artifact://art_123")).toBe(true);
    expect(uriToArtifactId("artifact://art_123")).toBe("art_123");
  });

  it("does not claim a non-artifact URI (caller falls through)", () => {
    expect(isArtifactUri("files://fl_1")).toBe(false);
    expect(uriToArtifactId("files://fl_1")).toBeNull();
    expect(uriToArtifactId("ui://app/view")).toBeNull();
  });

  it("rejects a malformed artifact id loudly", () => {
    expect(() => uriToArtifactId("artifact://has a space")).toThrow();
    expect(() => uriToArtifactId("artifact://../escape")).toThrow();
  });
});

describe("ArtifactResolver.read — reads as the viewing user", () => {
  it("resolves a markdown artifact in the user's own workspace", async () => {
    const resolver = makeResolver({
      art_md: {
        workspace: WS_A,
        mimeType: "text/markdown",
        body: new TextEncoder().encode("# Title\n\nbody"),
      },
    });
    const result = await resolver.read("artifact://art_md", WS_A);
    const first = result.contents[0]!;
    expect(first.uri).toBe("artifact://art_md");
    expect(first.mimeType).toBe("text/markdown");
    // text/* comes back as text, not blob.
    expect(first.text).toBe("# Title\n\nbody");
    expect(first.blob).toBeUndefined();
  });

  it("denies a read from a DIFFERENT workspace (RLS) — surfaces not-found", async () => {
    // The artifact lives in workspace A; a viewer in workspace B must not read
    // it. The fake data plane fences on the minted token's workspace, exactly
    // like RLS, and the resolver collapses the denial to not-found so existence
    // can't be probed across workspaces.
    const resolver = makeResolver({
      art_secret: {
        workspace: WS_A,
        mimeType: "text/markdown",
        body: new TextEncoder().encode("secret"),
      },
    });
    await expect(resolver.read("artifact://art_secret", WS_B)).rejects.toBeInstanceOf(
      ArtifactNotFoundError,
    );
    // ...and the legitimate owner CAN read it — proving the denial is about
    // identity, not a broken fixture.
    const owned = await resolver.read("artifact://art_secret", WS_A);
    expect(owned.contents[0]!.text).toBe("secret");
  });

  it("brokers large bodies via a presigned URL (bytes off the read path)", async () => {
    const big = new TextEncoder().encode("LARGE-BODY-CONTENT");
    const resolver = makeResolver(
      {
        art_big: {
          workspace: WS_A,
          mimeType: "text/markdown",
          presignedUrl: "https://presigned.test/art_big",
        },
      },
      { art_big: big },
    );
    const result = await resolver.read("artifact://art_big", WS_A);
    expect(result.contents[0]!.text).toBe("LARGE-BODY-CONTENT");
  });

  it("returns binary mime as a base64 blob, not text", async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const png = Buffer.from(pngBytes).toString("base64");
    const resolver = makeResolver({
      art_png: { workspace: WS_A, mimeType: "image/png", body: pngBytes },
    });
    const result = await resolver.read("artifact://art_png", WS_A);
    const first = result.contents[0]!;
    expect(first.mimeType).toBe("image/png");
    expect(first.blob).toBe(png);
    expect(first.text).toBeUndefined();
  });

  it("surfaces not-found for an id that exists in no workspace", async () => {
    const resolver = makeResolver({});
    await expect(resolver.read("artifact://nope", WS_A)).rejects.toBeInstanceOf(
      ArtifactNotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------
// Read-path cross-seam: the read CLIENT against the data plane's ACTUAL wire.
//
// The metadata endpoint (`GET /artifacts/{id}`) returns a JSON row with no body;
// the body endpoint (`GET /artifacts/{id}/content`) streams raw inline bytes or
// answers a 302 to a presigned URL. These assert the client keys off that real
// shape and returns the bytes / presigned URL — never the "neither inline nor
// presigned" fall-through that an envelope-shaped client would hit on every read.
// ---------------------------------------------------------------------------

function makeReadClient(
  rows: Record<string, Row>,
  presigned?: Record<string, Uint8Array>,
): ArtifactReadClient {
  const dataPlaneFetch = makeDataPlaneFetch(rows, presigned);
  const cache = new ServiceTokenCache({ identity: IDENTITY, fetchImpl: dataPlaneFetch });
  return new ArtifactReadClient({
    config: { baseUrl: DATA_PLANE, issuer: ISSUER },
    cache,
    fetchImpl: dataPlaneFetch,
  });
}

describe("ArtifactReadClient — reads the data plane's actual response shape", () => {
  it("returns inline bytes from the /content stream (200), not a fall-through error", async () => {
    const client = makeReadClient({
      art_inline: {
        workspace: WS_A,
        mimeType: "text/markdown",
        body: new TextEncoder().encode("# Report\n\ninline body"),
      },
    });
    const result = await client.read("art_inline", WS_A);
    expect(result.mimeType).toBe("text/markdown");
    expect(result.presignedUrl).toBeUndefined();
    expect(result.body).toBeDefined();
    expect(new TextDecoder().decode(result.body!)).toBe("# Report\n\ninline body");
  });

  it("returns the presigned URL from the /content 302 redirect for a spilled body", async () => {
    const client = makeReadClient(
      {
        art_spilled: {
          workspace: WS_A,
          mimeType: "application/pdf",
          presignedUrl: "https://presigned.test/art_spilled",
        },
      },
      { art_spilled: new Uint8Array([1, 2, 3]) },
    );
    const result = await client.read("art_spilled", WS_A);
    expect(result.mimeType).toBe("application/pdf");
    expect(result.body).toBeUndefined();
    expect(result.presignedUrl).toBe("https://presigned.test/art_spilled");
  });
});

// ---------------------------------------------------------------------------
// ArtifactReadClient.list — discovery (read_artifact / list_artifacts backing).
// Same identity plumbing as read: the workspace scopes the minted read token and
// the data plane's RLS fences the page. We model the LIST endpoint
// (GET /v1/artifacts?type=...) with a fake that echoes the bearer's workspace.
// ---------------------------------------------------------------------------

interface ListRow {
  artifact_id: string;
  uri: string;
  type: string;
  mime_type: string;
  title?: string;
  source: string;
  status: string;
  created_at: string;
}

function makeListFetch(byWorkspace: Record<string, ListRow[]>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input.toString();

    // Token mint — echo the requested workspace into the bearer (as in read).
    if (url === `${ISSUER}/token`) {
      const body = new URLSearchParams(String(init?.body ?? ""));
      const payloadB64 = (body.get("tenant_assertion") ?? "").split(".")[1] ?? "";
      const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as {
        workspace: string;
        audience: string;
        scope: string;
      };
      const token = Buffer.from(
        JSON.stringify({ workspace: payload.workspace, aud: payload.audience, scope: payload.scope }),
      ).toString("base64url");
      return new Response(JSON.stringify({ access_token: token, expires_in: 300 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // LIST endpoint: GET /v1/artifacts (no /{id}). Fence by the bearer's workspace,
    // apply the type filter the client threaded as a query param.
    if (url.startsWith(`${DATA_PLANE}/v1/artifacts`)) {
      const u = new URL(url);
      if (u.pathname !== "/v1/artifacts") return new Response("not list", { status: 500 });
      const bearer = (new Headers(init?.headers).get("Authorization") ?? "").replace(/^Bearer\s+/, "");
      const claims = JSON.parse(Buffer.from(bearer, "base64url").toString("utf8")) as {
        workspace: string;
      };
      let rows = byWorkspace[claims.workspace] ?? [];
      const type = u.searchParams.get("type");
      if (type) rows = rows.filter((r) => r.type === type);
      return new Response(JSON.stringify({ artifacts: rows, next_cursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("unexpected url: " + url, { status: 500 });
  }) as typeof fetch;
}

function makeListClient(byWorkspace: Record<string, ListRow[]>): ArtifactReadClient {
  const fetchImpl = makeListFetch(byWorkspace);
  const cache = new ServiceTokenCache({ identity: IDENTITY, fetchImpl });
  return new ArtifactReadClient({ config: { baseUrl: DATA_PLANE, issuer: ISSUER }, cache, fetchImpl });
}

describe("ArtifactReadClient.list — discovery as the viewing user", () => {
  const rows: Record<string, ListRow[]> = {
    [WS_A]: [
      {
        artifact_id: "art_1",
        uri: "artifact://art_1",
        type: "research.report",
        mime_type: "text/markdown",
        title: "Matthew Gerard",
        source: "task",
        status: "ready",
        created_at: "2026-06-16T00:00:00Z",
      },
      {
        artifact_id: "art_2",
        uri: "artifact://art_2",
        type: "other",
        mime_type: "text/plain",
        source: "task",
        status: "ready",
        created_at: "2026-06-15T00:00:00Z",
      },
    ],
    [WS_B]: [
      {
        artifact_id: "art_9",
        uri: "artifact://art_9",
        type: "research.report",
        mime_type: "text/markdown",
        title: "Other workspace",
        source: "task",
        status: "ready",
        created_at: "2026-06-16T00:00:00Z",
      },
    ],
  };

  it("lists the caller's workspace rows and maps snake_case metadata", async () => {
    const res = await makeListClient(rows).list(WS_A);
    expect(res.items.map((i) => i.artifactId)).toEqual(["art_1", "art_2"]);
    expect(res.items[0].title).toBe("Matthew Gerard");
    expect(res.items[0].uri).toBe("artifact://art_1");
    expect(res.items[0].type).toBe("research.report");
  });

  it("threads the type filter through as a query param", async () => {
    const res = await makeListClient(rows).list(WS_A, { type: "research.report" });
    expect(res.items.map((i) => i.artifactId)).toEqual(["art_1"]);
  });

  it("fences by RLS — a workspace never sees another's rows", async () => {
    const res = await makeListClient(rows).list(WS_B);
    expect(res.items.map((i) => i.artifactId)).toEqual(["art_9"]);
  });

  it("fails closed without a workspace", async () => {
    await expect(makeListClient(rows).list("")).rejects.toThrow(/workspace/);
  });

  it("forwards a positive limit but drops a non-positive one", async () => {
    const urls: string[] = [];
    const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === `${ISSUER}/token`) {
        const body = new URLSearchParams(String(init?.body ?? ""));
        const payloadB64 = (body.get("tenant_assertion") ?? "").split(".")[1] ?? "";
        const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as {
          workspace: string;
        };
        const token = Buffer.from(JSON.stringify({ workspace: payload.workspace })).toString(
          "base64url",
        );
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: token, expires_in: 300 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      urls.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ artifacts: [], next_cursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;
    const cache = new ServiceTokenCache({ identity: IDENTITY, fetchImpl });
    const client = new ArtifactReadClient({
      config: { baseUrl: DATA_PLANE, issuer: ISSUER },
      cache,
      fetchImpl,
    });

    await client.list(WS_A, { limit: 5 });
    expect(urls.at(-1)).toContain("limit=5");

    await client.list(WS_A, { limit: 0 });
    expect(urls.at(-1)).not.toContain("limit=");

    await client.list(WS_A, { limit: -3 });
    expect(urls.at(-1)).not.toContain("limit=");
  });
});
