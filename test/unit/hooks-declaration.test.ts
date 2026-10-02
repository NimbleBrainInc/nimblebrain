import { describe, expect, test } from "bun:test";
import type { HostManifestMeta } from "../../src/connectors/runtime/types.ts";
import {
  HookRouteRefusedError,
  isForwardablePath,
  isStrippedRequestHeader,
  parseHookDeclarations,
  resolveForwardUrl,
  routeNamesMcpEndpoint,
} from "../../src/hooks/declaration.ts";

function meta(hooks: unknown): HostManifestMeta {
  return { host_version: "1.2", hooks } as unknown as HostManifestMeta;
}

const GOOD = {
  vendor: "acme",
  route: "/ingest/acme",
  register_tool: "set_webhook_url",
  description: "Campaign events",
};

describe("parseHookDeclarations", () => {
  test("keeps a well-formed declaration", () => {
    expect(parseHookDeclarations(meta([GOOD]))).toEqual([GOOD]);
  });

  test("is absent-tolerant", () => {
    expect(parseHookDeclarations(undefined)).toEqual([]);
    expect(parseHookDeclarations(meta(undefined))).toEqual([]);
    expect(parseHookDeclarations(meta("not an array"))).toEqual([]);
  });

  test.each([
    ["a vendor that is not a slug", { ...GOOD, vendor: "Acme Corp" }],
    ["a missing register_tool", { ...GOOD, register_tool: "" }],
    ["a relative route", { ...GOOD, route: "ingest/acme" }],
    ["a protocol-relative route", { ...GOOD, route: "//evil.test/x" }],
    ["a traversing route", { ...GOOD, route: "/ingest/../../admin" }],
    ["a non-object entry", "nope"],
  ])("drops %s without dropping the rest of the manifest", (_label, bad) => {
    // One bad stream costs that stream, never the install — the same tolerance
    // the host extension documents for placements.
    expect(parseHookDeclarations(meta([bad, GOOD]))).toEqual([GOOD]);
  });

  test("keeps only the first declaration for a vendor", () => {
    const second = { ...GOOD, route: "/ingest/other" };
    expect(parseHookDeclarations(meta([GOOD, second]))).toEqual([GOOD]);
  });

  test("normalizes header renames to lowercase", () => {
    const decl = parseHookDeclarations(
      meta([{ ...GOOD, header_renames: { Authorization: "X-Acme-Signature" } }]),
    )[0];
    expect(decl?.header_renames).toEqual({ authorization: "x-acme-signature" });
  });

  test("refuses a rename INTO the stripped identity class", () => {
    // Otherwise a rename would re-open the hole the strip exists to close.
    const decl = parseHookDeclarations(
      meta([{ ...GOOD, header_renames: { "x-acme-sig": "x-workspace-id" } }]),
    )[0];
    expect(decl?.header_renames).toBeUndefined();
  });

  test("refuses a rename FROM the browser's cookie", () => {
    // A rename out of the stripped class exists for vendor signatures; no vendor
    // signs with the cookie, and the connector must not be able to ask for it.
    const decl = parseHookDeclarations(
      meta([{ ...GOOD, header_renames: { Cookie: "x-acme-cookie" } }]),
    )[0];
    expect(decl?.header_renames).toBeUndefined();
  });

  test("refuses a rename whose name is not an HTTP token", () => {
    const decl = parseHookDeclarations(
      meta([{ ...GOOD, header_renames: { "bad header": "x-ok", "x-ok": "also bad" } }]),
    )[0];
    expect(decl?.header_renames).toBeUndefined();
  });
});

describe("isForwardablePath", () => {
  test.each(["/ingest/acme", "/ingest/acme?v=2", "/a"])("accepts %s", (route) => {
    expect(isForwardablePath(route)).toBe(true);
  });

  test.each([
    ["empty", ""],
    ["relative", "ingest/acme"],
    ["protocol-relative", "//evil.test/x"],
    ["backslash authority", "/\\evil.test/x"],
    ["traversal", "/a/../b"],
    ["fragment", "/a#b"],
    ["absolute url", "https://evil.test/x"],
    ["embedded space", "/a b"],
    ["embedded newline", "/a\nHost: evil.test"],
    ["embedded null", "/a\u0000b"],
  ])("refuses %s", (_label, route) => {
    expect(isForwardablePath(route)).toBe(false);
  });
});

describe("routeNamesMcpEndpoint", () => {
  const MCP = "https://connector.internal/mcp";

  // Each of these is a path the server would route to its MCP endpoint, and the
  // forward would carry the workspace's credential there.
  test.each([
    ["the endpoint itself", "/mcp"],
    ["a path under it", "/mcp/messages"],
    ["a trailing slash", "/mcp/"],
    ["a query on the endpoint", "/mcp?session=1"],
    ["a percent-encoded endpoint", "/%6Dcp"],
    ["a percent-encoded separator", "/mcp%2Fx"],
    ["an encoded dot-dot segment", "/ingest/%2e%2e/mcp"],
    ["a mixed dot-dot segment", "/ingest/.%2E/mcp"],
    ["a dot segment", "/./mcp"],
    ["an undecodable escape", "/ingest/%zz"],
  ])("refuses %s", (_label, route) => {
    expect(routeNamesMcpEndpoint(route, MCP)).toBe(true);
  });

  test.each([
    ["the fleet convention", "/ingest/acme"],
    ["a sibling that only shares a prefix", "/mcpx"],
    ["a sibling path", "/webhooks/mcp"],
  ])("allows %s", (_label, route) => {
    expect(routeNamesMcpEndpoint(route, MCP)).toBe(false);
  });

  test("ignores a trailing slash on the endpoint", () => {
    expect(routeNamesMcpEndpoint("/mcp", "https://connector.internal/mcp/")).toBe(true);
    expect(routeNamesMcpEndpoint("/ingest/acme", "https://connector.internal/mcp/")).toBe(false);
  });

  test("refuses only the root itself when the endpoint is mounted at the root", () => {
    // Every path lies under `/`, so the prefix rule would refuse every hook on
    // a server whose MCP endpoint is its root.
    expect(routeNamesMcpEndpoint("/", "https://connector.internal/")).toBe(true);
    expect(routeNamesMcpEndpoint("/ingest/acme", "https://connector.internal/")).toBe(false);
  });

  test("a literal dot-dot route never reaches the comparison", () => {
    // `isForwardablePath` refuses it first; the encoded forms above are what
    // get past that check, and the resolved path is what catches them.
    expect(isForwardablePath("/ingest/../mcp")).toBe(false);
  });
});

describe("resolveForwardUrl", () => {
  const BASE = "https://connector.internal/mcp";

  test("resolves an absolute route against the connector's origin", () => {
    expect(resolveForwardUrl(BASE, "/ingest/acme").toString()).toBe(
      "https://connector.internal/ingest/acme",
    );
  });

  test("preserves a query string", () => {
    expect(resolveForwardUrl(BASE, "/ingest/acme?v=2").toString()).toBe(
      "https://connector.internal/ingest/acme?v=2",
    );
  });

  test.each([
    ["a protocol-relative route", "//evil.test/steal"],
    ["an absolute url", "https://evil.test/steal"],
  ])("refuses %s — the forward carries a platform token", (_label, route) => {
    expect(() => resolveForwardUrl(BASE, route)).toThrow(/forwardable|origin/);
  });

  test.each(["/mcp", "/mcp/", "/%6dcp", "/ingest/%2e%2e/mcp"])(
    "refuses %s, which names the connector's MCP endpoint",
    (route) => {
      expect(() => resolveForwardUrl(BASE, route)).toThrow(HookRouteRefusedError);
    },
  );
});

describe("the stripped header class", () => {
  test("covers every identity header a caller could try to assert", () => {
    for (const name of [
      "authorization",
      "cookie",
      "x-api-key",
      "x-tenant-id",
      "x-workspace-id",
      "x-subject-token",
      "x-user-id",
    ]) {
      expect(isStrippedRequestHeader(name)).toBe(true);
    }
  });

  test.each(["x-nb-hook-kid", "x-nb-something-nobody-has-invented-yet", "x-nb-"])(
    "strips %s by namespace rule, not by name",
    (name) => {
      // The point of the rule: the NEXT member inherits the property instead of
      // a hole. A name list admits every header nobody remembered to add.
      expect(isStrippedRequestHeader(name)).toBe(true);
    },
  );

  test("leaves the general path a denylist so vendor signatures pass", () => {
    // The runtime cannot enumerate the headers a vendor signs, and those must
    // reach the receiving server's verifier or origin verification is
    // impossible by construction.
    for (const name of ["stripe-signature", "x-acme-signature", "content-type", "user-agent"]) {
      expect(isStrippedRequestHeader(name)).toBe(false);
    }
  });
});
