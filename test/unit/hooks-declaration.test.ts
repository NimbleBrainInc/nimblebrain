import { describe, expect, test } from "bun:test";
import type { HostManifestMeta } from "../../src/bundles/types.ts";
import {
  isForwardablePath,
  parseHookDeclarations,
  resolveForwardUrl,
  STRIPPED_REQUEST_HEADERS,
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

  test("refuses a rename whose name is not an HTTP token", () => {
    const decl = parseHookDeclarations(
      meta([{ ...GOOD, header_renames: { "bad header": "x-ok", "x-ok": "also bad" } }]),
    )[0];
    expect(decl?.header_renames).toBeUndefined();
  });
});

describe("isForwardablePath", () => {
  test.each([
    "/ingest/acme",
    "/ingest/acme?v=2",
    "/a",
  ])("accepts %s", (route) => {
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
});

describe("the stripped header class", () => {
  test("covers every identity header a caller could try to assert", () => {
    for (const name of [
      "authorization",
      "x-api-key",
      "x-tenant-id",
      "x-workspace-id",
      "x-subject-token",
      "x-user-id",
    ]) {
      expect(STRIPPED_REQUEST_HEADERS.has(name)).toBe(true);
    }
  });

  test("includes the runtime's own kid header", () => {
    // It is set from the token after the strip. Leaving it forwardable would
    // let a caller supply one, which is how an informational header becomes an
    // identity header by accident.
    expect(STRIPPED_REQUEST_HEADERS.has("x-nb-hook-kid")).toBe(true);
  });
});
