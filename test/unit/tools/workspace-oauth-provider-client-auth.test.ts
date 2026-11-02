import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auth, type FetchLike } from "@modelcontextprotocol/client";
import { WorkspaceOAuthProvider } from "../../../src/tools/workspace-oauth-provider.ts";
import {
  installTestCredentialStore,
  resetTestCredentialStore,
} from "../../helpers/credential-store.ts";

// Client authentication on a vendor's token endpoint belongs to the MCP SDK: the
// provider defines no `addClientAuthentication`, so the SDK picks the method and
// applies it. These run the SDK's real `auth()` against a fake vendor and read the
// token request it sends, for each shape of client a connector can have.

const WS_ID = "ws_0076759dbbe19fcc";
const VENDOR = "https://vendor.example";
const CALLBACK = "http://localhost:27247/v1/mcp-auth/callback";

interface TokenRequest {
  authorization: string | null;
  body: URLSearchParams;
}

/** A fake vendor advertising `methods`. Records each token request it receives. */
function fakeVendor(methods: string[]): { fetchFn: FetchLike; requests: TokenRequest[] } {
  const requests: TokenRequest[] = [];
  const fetchFn: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
      return Response.json({
        issuer: VENDOR,
        authorization_endpoint: `${VENDOR}/authorize`,
        token_endpoint: `${VENDOR}/token`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: methods,
      });
    }
    if (url.pathname === "/token") {
      requests.push({
        authorization: new Headers(init?.headers).get("authorization"),
        body: new URLSearchParams(String(init?.body)),
      });
      return Response.json({
        access_token: "access-next",
        token_type: "Bearer",
        refresh_token: "refresh-next",
        expires_in: 3600,
      });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchFn, requests };
}

describe("WorkspaceOAuthProvider client auth, through the SDK", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-client-auth-"));
    mkdirSync(join(workDir, "workspaces", WS_ID), { recursive: true });
    installTestCredentialStore(workDir);
  });

  afterEach(() => {
    resetTestCredentialStore();
    rmSync(workDir, { recursive: true, force: true });
  });

  function provider(
    staticClient?: ConstructorParameters<typeof WorkspaceOAuthProvider>[0]["staticClient"],
  ): WorkspaceOAuthProvider {
    return new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: WS_ID },
      serverName: "vendor-srv",
      callbackUrl: CALLBACK,
      ...(staticClient ? { staticClient } : {}),
    });
  }

  /** The code exchange, which a first connect and a Reconnect both end in. */
  async function exchange(p: WorkspaceOAuthProvider, methods: string[]): Promise<TokenRequest> {
    const vendor = fakeVendor(methods);
    await p.saveCodeVerifier("the-verifier");
    const result = await auth(p, {
      serverUrl: `${VENDOR}/mcp`,
      authorizationCode: "the-code",
      fetchFn: vendor.fetchFn,
    });
    expect(result).toBe("AUTHORIZED");
    expect(vendor.requests).toHaveLength(1);
    const request = vendor.requests[0] as TokenRequest;
    expect(request.body.get("grant_type")).toBe("authorization_code");
    expect(request.body.get("code_verifier")).toBe("the-verifier");
    return request;
  }

  async function refresh(p: WorkspaceOAuthProvider, methods: string[]): Promise<TokenRequest> {
    const vendor = fakeVendor(methods);
    await p.saveTokens({ access_token: "old", token_type: "Bearer", refresh_token: "old-refresh" });
    const result = await auth(p, { serverUrl: `${VENDOR}/mcp`, fetchFn: vendor.fetchFn });
    expect(result).toBe("AUTHORIZED");
    expect(vendor.requests).toHaveLength(1);
    const request = vendor.requests[0] as TokenRequest;
    expect(request.body.get("grant_type")).toBe("refresh_token");
    expect(request.body.get("refresh_token")).toBe("old-refresh");
    return request;
  }

  const basic = (id: string, secret: string) => `Basic ${btoa(`${id}:${secret}`)}`;

  it("leaves client auth to the SDK", () => {
    expect("addClientAuthentication" in provider()).toBe(false);
  });

  describe.each([
    ["code exchange", exchange],
    ["refresh", refresh],
  ] as const)("%s", (_name, run) => {
    it("static client configured for client_secret_post sends id and secret in the body", async () => {
      const request = await run(
        provider({
          clientId: "static-id",
          clientSecret: "s3cret",
          tokenEndpointAuthMethod: "client_secret_post",
        }),
        ["client_secret_basic", "client_secret_post"],
      );
      expect(request.authorization).toBeNull();
      expect(request.body.get("client_id")).toBe("static-id");
      expect(request.body.get("client_secret")).toBe("s3cret");
    });

    it("static client configured for client_secret_basic sends HTTP Basic", async () => {
      const request = await run(
        provider({
          clientId: "static-id",
          clientSecret: "s3cret",
          tokenEndpointAuthMethod: "client_secret_basic",
        }),
        ["client_secret_basic", "client_secret_post"],
      );
      expect(request.authorization).toBe(basic("static-id", "s3cret"));
      expect(request.body.get("client_id")).toBeNull();
      expect(request.body.get("client_secret")).toBeNull();
    });

    it("public client sends its id in the body and no secret", async () => {
      const request = await run(
        provider({ clientId: "public-id", tokenEndpointAuthMethod: "none" }),
        ["none"],
      );
      expect(request.authorization).toBeNull();
      expect(request.body.get("client_id")).toBe("public-id");
      expect(request.body.get("client_secret")).toBeNull();
    });

    it("dynamically registered client uses the method it registered with", async () => {
      const p = provider();
      await p.saveClientInformation({
        client_id: "dcr-id",
        client_secret: "dcr-secret",
        redirect_uris: [CALLBACK],
        token_endpoint_auth_method: "client_secret_post",
      });
      const request = await run(p, ["client_secret_basic", "client_secret_post"]);
      expect(request.authorization).toBeNull();
      expect(request.body.get("client_id")).toBe("dcr-id");
      expect(request.body.get("client_secret")).toBe("dcr-secret");
    });

    it("sends nothing of ours beyond the OAuth parameters", async () => {
      const request = await run(
        provider({ clientId: "public-id", tokenEndpointAuthMethod: "none" }),
        ["none"],
      );
      expect(request.body.get("tenant_assertion")).toBeNull();
    });
  });
});
