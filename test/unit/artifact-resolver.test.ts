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

/** One artifact row in the fake store. */
interface Row {
  workspace: string;
  mimeType: string;
  bodyText?: string;
  bodyBase64?: string;
  presignedUrl?: string;
}

/**
 * Build a fake `fetch` that plays BOTH the authorizer (`/token`) and the
 * artifacts service (`/artifacts/:id`). The minted token is a JSON blob naming
 * the workspace the runtime requested; the artifacts service reads that
 * workspace back off the bearer and fences rows by it (the RLS gate).
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
    if (url.startsWith(`${DATA_PLANE}/artifacts/`)) {
      const auth = new Headers(init?.headers).get("Authorization") ?? "";
      const bearer = auth.replace(/^Bearer\s+/, "");
      const claims = JSON.parse(Buffer.from(bearer, "base64url").toString("utf8")) as {
        workspace: string;
      };
      const id = decodeURIComponent(url.slice(`${DATA_PLANE}/artifacts/`.length));
      const row = rows[id];
      // RLS: the row is invisible unless its workspace matches the caller's.
      if (!row || row.workspace !== claims.workspace) {
        return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      }
      const envelope: Record<string, unknown> = { mime_type: row.mimeType };
      if (row.bodyText !== undefined) envelope.body_text = row.bodyText;
      if (row.bodyBase64 !== undefined) envelope.body_base64 = row.bodyBase64;
      if (row.presignedUrl !== undefined) envelope.presigned_url = row.presignedUrl;
      return new Response(JSON.stringify(envelope), {
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
      art_md: { workspace: WS_A, mimeType: "text/markdown", bodyText: "# Title\n\nbody" },
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
      art_secret: { workspace: WS_A, mimeType: "text/markdown", bodyText: "secret" },
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
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    const resolver = makeResolver({
      art_png: { workspace: WS_A, mimeType: "image/png", bodyBase64: png },
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
