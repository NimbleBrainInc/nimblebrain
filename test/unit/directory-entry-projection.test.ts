import { describe, expect, test } from "bun:test";
import type { ServerDetail } from "../../src/connectors/server-detail.ts";
import {
  projectServerDetailToDirectoryEntry,
  serverDetailToCatalogEntry,
} from "../../src/registries/projection.ts";

const CTX = { registryId: "test", registryType: "static" as const };

function detail(over: Partial<ServerDetail> = {}): ServerDetail {
  return {
    name: "io.example/test",
    title: "Example",
    description: "An example",
    version: "1.0.0",
    ...over,
  };
}

describe("projectServerDetailToDirectoryEntry", () => {
  test("uses ServerDetail.name as the DirectoryEntry id", () => {
    const e = projectServerDetailToDirectoryEntry(
      detail({
        remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }],
      }),
      CTX,
    );
    expect(e?.id).toBe("io.example/test");
  });

  test("uses title for display name; falls back to name when title is absent", () => {
    const titled = projectServerDetailToDirectoryEntry(
      detail({
        title: "My Title",
        remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }],
      }),
      CTX,
    );
    expect(titled?.name).toBe("My Title");
    const untitled = projectServerDetailToDirectoryEntry(
      detail({
        title: undefined,
        remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }],
      }),
      CTX,
    );
    expect(untitled?.name).toBe("io.example/test");
  });

  test("picks the first icon as iconUrl (theme-aware picking is a follow-up)", () => {
    const e = projectServerDetailToDirectoryEntry(
      detail({
        icons: [
          { src: "https://a.svg", sizes: ["any"] },
          { src: "https://b.svg", sizes: ["any"] },
        ],
        remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }],
      }),
      CTX,
    );
    expect(e?.iconUrl).toBe("https://a.svg");
  });

  test("omits iconUrl when no icons are present", () => {
    const e = projectServerDetailToDirectoryEntry(
      detail({
        remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }],
      }),
      CTX,
    );
    expect(e?.iconUrl).toBeUndefined();
  });

  test("derives mpak-bundle install when packages are present", () => {
    const e = projectServerDetailToDirectoryEntry(
      detail({
        packages: [
          { registryType: "mpak", identifier: "@x/y", transport: { type: "stdio" } },
        ],
      }),
      CTX,
    );
    expect(e?.install.kind).toBe("mpak-bundle");
    if (e?.install.kind === "mpak-bundle") {
      expect(e.install.package).toBe("@x/y");
    }
  });

  test("packages take precedence over remotes (local install is reproducible)", () => {
    const e = projectServerDetailToDirectoryEntry(
      detail({
        packages: [
          { registryType: "mpak", identifier: "@x/y", transport: { type: "stdio" } },
        ],
        remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }],
      }),
      CTX,
    );
    expect(e?.install.kind).toBe("mpak-bundle");
  });

  test("derives remote-oauth install with NimbleBrain meta auth + scopes", () => {
    const e = projectServerDetailToDirectoryEntry(
      detail({
        remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }],
        _meta: {
          "ai.nimblebrain/connector": {
            auth: "static",
            requiredScopes: ["read", "write"],
            additionalAuthorizationParams: { access_type: "offline" },
            operatorSetup: {
              portalUrl: "https://example.com/portal",
              hint: "Create app",
              clientSecretKey: "x.client_secret",
            },
            tags: ["email"],
          },
        },
      }),
      CTX,
    );
    expect(e?.install.kind).toBe("remote-oauth");
    expect(e?.tags).toEqual(["email"]);
    if (e?.install.kind === "remote-oauth") {
      expect(e.install.auth).toBe("static");
      expect(e.install.requiredScopes).toEqual(["read", "write"]);
      expect(e.install.additionalAuthorizationParams).toEqual({ access_type: "offline" });
      expect(e.install.operatorSetup?.clientSecretKey).toBe("x.client_secret");
    }
  });

  test("projects provider auth + providerAuth (the platform-connector class)", () => {
    const e = projectServerDetailToDirectoryEntry(
      detail({
        remotes: [{ type: "streamable-http", url: "http://mcp-web.mcp-shared.svc/mcp" }],
        _meta: {
          "ai.nimblebrain/connector": {
            auth: "provider",
            providerAuth: { provider: "minted", config: { audience: "mcp-fleet", scope: "mcp:invoke" } },
          },
        },
      }),
      CTX,
    );
    expect(e?.install.kind).toBe("remote-oauth");
    if (e?.install.kind === "remote-oauth") {
      expect(e.install.auth).toBe("provider");
      // The operator-authored provider config is carried through verbatim — this
      // is what the install path copies into transport.auth (never tenant input).
      expect(e.install.providerAuth).toEqual({
        provider: "minted",
        config: { audience: "mcp-fleet", scope: "mcp:invoke" },
      });
    }
  });

  test("threads streamable-http transport type from remotes[0] to install action", () => {
    const e = projectServerDetailToDirectoryEntry(
      detail({
        remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }],
      }),
      CTX,
    );
    expect(e?.install.kind).toBe("remote-oauth");
    if (e?.install.kind === "remote-oauth") {
      expect(e.install.transportType).toBe("streamable-http");
    }
  });

  test("threads SSE transport type from remotes[0] to install action — SSE-only servers (PayPal, Cloudflare, Webflow, Wix)", () => {
    // Without this, handleInstallRemoteOAuth would build a default
    // streamable-http transport against an SSE server and the
    // handshake would fail. Pinning the transport at projection time
    // is the only place the source's `remote.type` is in scope.
    const e = projectServerDetailToDirectoryEntry(
      detail({
        remotes: [{ type: "sse", url: "https://example.com/sse" }],
      }),
      CTX,
    );
    expect(e?.install.kind).toBe("remote-oauth");
    if (e?.install.kind === "remote-oauth") {
      expect(e.install.transportType).toBe("sse");
    }
  });


  test("defaults remote auth to 'dcr' when meta is absent", () => {
    const e = projectServerDetailToDirectoryEntry(
      detail({
        remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }],
      }),
      CTX,
    );
    if (e?.install.kind === "remote-oauth") {
      expect(e.install.auth).toBe("dcr");
    } else {
      throw new Error("expected remote-oauth install");
    }
  });

  test("returns null when neither packages nor remotes are present", () => {
    const e = projectServerDetailToDirectoryEntry(detail(), CTX);
    expect(e).toBeNull();
  });

  test("derives remote-oauth install for SSE remote (legacy MCP-over-SSE profile)", () => {
    // Upstream `RemoteTransport` allows either streamable-http or sse;
    // we collapse both into the same `remote-oauth` install kind because
    // the install dispatcher cares about the URL, not the transport
    // variant.
    const e = projectServerDetailToDirectoryEntry(
      detail({
        remotes: [{ type: "sse", url: "https://example.com/sse" }],
      }),
      CTX,
    );
    expect(e?.install.kind).toBe("remote-oauth");
    if (e?.install.kind === "remote-oauth") {
      expect(e.install.url).toBe("https://example.com/sse");
    }
  });
});

describe("serverDetailToCatalogEntry", () => {
  test("projects an icon-less entry that has a remote (icon is cosmetic, never gates install)", () => {
    // The foot-gun this fixes: a missing icon must NOT make a connector
    // un-installable. The entry projects; iconUrl is omitted so the UI
    // falls back to a letter-avatar.
    const e = serverDetailToCatalogEntry(
      detail({
        remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }],
      }),
    );
    expect(e).not.toBeNull();
    expect(e?.id).toBe("io.example/test");
    expect(e?.url).toBe("https://example.com/mcp");
    expect(e?.iconUrl).toBeUndefined();
  });

  test("carries iconUrl through when an icon is present", () => {
    const e = serverDetailToCatalogEntry(
      detail({
        icons: [{ src: "https://a.svg", sizes: ["any"] }],
        remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }],
      }),
    );
    expect(e?.iconUrl).toBe("https://a.svg");
  });

  test("returns null without a remote — that drop stays (genuinely non-functional)", () => {
    // No remote URL = nothing to install/connect to. This is the only
    // legitimate reason to drop a catalog entry.
    const e = serverDetailToCatalogEntry(detail());
    expect(e).toBeNull();
  });

  test("returns null without a remote even when icons are present", () => {
    const e = serverDetailToCatalogEntry(
      detail({
        icons: [{ src: "https://a.svg", sizes: ["any"] }],
      }),
    );
    expect(e).toBeNull();
  });

  test("projects an icon-less provider-auth entry with providerAuth verbatim", () => {
    // The exact class that hit the bug: a platform `provider` connector with
    // no icon. Pre-fix the projection dropped it, so catalogById returned null
    // and the install failed with "not a recognized platform connector".
    const e = serverDetailToCatalogEntry(
      detail({
        remotes: [{ type: "streamable-http", url: "http://mcp-web.mcp-shared.svc/mcp" }],
        _meta: {
          "ai.nimblebrain/connector": {
            auth: "provider",
            providerAuth: { provider: "minted", config: { audience: "mcp-fleet" } },
          },
        },
      }),
    );
    expect(e).not.toBeNull();
    expect(e?.iconUrl).toBeUndefined();
    expect(e?.auth).toBe("provider");
    expect(e?.providerAuth).toEqual({ provider: "minted", config: { audience: "mcp-fleet" } });
  });
});
