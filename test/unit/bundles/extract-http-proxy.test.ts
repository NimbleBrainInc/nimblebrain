import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { extractHttpProxy } from "../../../src/bundles/defaults.ts";

// Quiet the warn() spam — these tests trigger validation rejections by design.
const originalWarn = console.warn;
beforeAll(() => {
  console.warn = () => {};
});
afterAll(() => {
  console.warn = originalWarn;
});

describe("extractHttpProxy", () => {
  test("returns null when meta is undefined", () => {
    expect(extractHttpProxy(undefined)).toBeNull();
  });

  test("returns null when http-proxy key is absent", () => {
    expect(extractHttpProxy({})).toBeNull();
  });

  test("returns null when http-proxy is not an object", () => {
    expect(extractHttpProxy({ "ai.nimblebrain/http-proxy": "nope" })).toBeNull();
    expect(extractHttpProxy({ "ai.nimblebrain/http-proxy": 42 })).toBeNull();
    expect(extractHttpProxy({ "ai.nimblebrain/http-proxy": null })).toBeNull();
  });

  test("returns null when target is missing", () => {
    expect(
      extractHttpProxy({
        "ai.nimblebrain/http-proxy": { mount: "preview" },
      }),
    ).toBeNull();
  });

  test("returns null when mount is missing", () => {
    expect(
      extractHttpProxy({
        "ai.nimblebrain/http-proxy": { target: "http://127.0.0.1:4321" },
      }),
    ).toBeNull();
  });

  test("returns null when target is not a parseable URL", () => {
    expect(
      extractHttpProxy({
        "ai.nimblebrain/http-proxy": { target: "not a url at all", mount: "preview" },
      }),
    ).toBeNull();
  });

  test("returns null when target uses a non-http(s) protocol", () => {
    expect(
      extractHttpProxy({
        "ai.nimblebrain/http-proxy": { target: "file:///etc/passwd", mount: "preview" },
      }),
    ).toBeNull();
    expect(
      extractHttpProxy({
        "ai.nimblebrain/http-proxy": { target: "ftp://127.0.0.1/x", mount: "preview" },
      }),
    ).toBeNull();
    expect(
      extractHttpProxy({
        "ai.nimblebrain/http-proxy": { target: "javascript:alert(1)", mount: "preview" },
      }),
    ).toBeNull();
  });

  test("rejects non-loopback hosts (SSRF guard)", () => {
    const offLoopback = [
      "http://example.com",
      "http://169.254.169.254", // AWS metadata
      "http://10.0.0.1", // RFC1918
      "http://192.168.1.1",
      "http://172.16.0.1",
      "http://0.0.0.0", // wildcard, not loopback
    ];
    for (const target of offLoopback) {
      expect(
        extractHttpProxy({
          "ai.nimblebrain/http-proxy": { target, mount: "preview" },
        }),
      ).toBeNull();
    }
  });

  test("accepts each loopback hostname (127.0.0.1, ::1, localhost)", () => {
    for (const target of ["http://127.0.0.1:4321", "http://[::1]:4321", "http://localhost:4321"]) {
      const result = extractHttpProxy({
        "ai.nimblebrain/http-proxy": { target, mount: "preview" },
      });
      expect(result).not.toBeNull();
      expect(result?.target).toBe(target);
    }
  });

  test("loopback host check is case-insensitive (LocalHost)", () => {
    const result = extractHttpProxy({
      "ai.nimblebrain/http-proxy": { target: "http://LocalHost:4321", mount: "preview" },
    });
    expect(result).not.toBeNull();
  });

  test("rejects mount with embedded slashes", () => {
    expect(
      extractHttpProxy({
        "ai.nimblebrain/http-proxy": {
          target: "http://127.0.0.1:4321",
          mount: "deep/nested",
        },
      }),
    ).toBeNull();
  });

  test("rejects empty mount after slash trimming", () => {
    expect(
      extractHttpProxy({
        "ai.nimblebrain/http-proxy": { target: "http://127.0.0.1:4321", mount: "/" },
      }),
    ).toBeNull();
    expect(
      extractHttpProxy({
        "ai.nimblebrain/http-proxy": { target: "http://127.0.0.1:4321", mount: "" },
      }),
    ).toBeNull();
  });

  test("normalizes mount by trimming leading and trailing slashes", () => {
    const r = extractHttpProxy({
      "ai.nimblebrain/http-proxy": {
        target: "http://127.0.0.1:4321",
        mount: "/preview/",
      },
    });
    expect(r?.mount).toBe("preview");
  });

  test("websocket defaults to false when not declared or non-true", () => {
    const a = extractHttpProxy({
      "ai.nimblebrain/http-proxy": { target: "http://127.0.0.1:4321", mount: "preview" },
    });
    expect(a?.websocket).toBe(false);

    const b = extractHttpProxy({
      "ai.nimblebrain/http-proxy": {
        target: "http://127.0.0.1:4321",
        mount: "preview",
        websocket: "yes", // truthy but not strictly true
      },
    });
    expect(b?.websocket).toBe(false);
  });

  test("websocket=true is preserved", () => {
    const r = extractHttpProxy({
      "ai.nimblebrain/http-proxy": {
        target: "http://127.0.0.1:4321",
        mount: "preview",
        websocket: true,
      },
    });
    expect(r?.websocket).toBe(true);
  });

  test("returns the original target string verbatim (not the parsed URL)", () => {
    const target = "http://127.0.0.1:4321/some/path?q=1";
    const r = extractHttpProxy({
      "ai.nimblebrain/http-proxy": { target, mount: "preview" },
    });
    expect(r?.target).toBe(target);
  });
});
