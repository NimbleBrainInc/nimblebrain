import { describe, expect, test } from "bun:test";
import type { ServerDetail } from "../../src/connectors/server-detail.ts";
import { projectServerDetailToDirectoryEntry } from "../../src/registries/projection.ts";

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
            defaultScope: "user",
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
    expect(e?.defaultScope).toBe("user");
    expect(e?.tags).toEqual(["email"]);
    if (e?.install.kind === "remote-oauth") {
      expect(e.install.auth).toBe("static");
      expect(e.install.requiredScopes).toEqual(["read", "write"]);
      expect(e.install.additionalAuthorizationParams).toEqual({ access_type: "offline" });
      expect(e.install.operatorSetup?.clientSecretKey).toBe("x.client_secret");
    }
  });

  test("defaults defaultScope to 'workspace' when no NimbleBrain meta is present", () => {
    const e = projectServerDetailToDirectoryEntry(
      detail({
        remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }],
      }),
      CTX,
    );
    expect(e?.defaultScope).toBe("workspace");
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
