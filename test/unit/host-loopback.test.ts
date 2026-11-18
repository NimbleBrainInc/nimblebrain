import { afterEach, describe, expect, test } from "bun:test";
import type { FetchLike } from "@modelcontextprotocol/server";
import {
  _resetHostLoopbackForTest,
  isLoopbackHostname,
  loopbackDial,
  parseHostAlias,
  resolveHostLoopback,
  setHostLoopbackAlias,
} from "../../src/connectors/runtime/host-loopback.ts";
import { validateConnectorUrl } from "../../src/connectors/runtime/url-validator.ts";
import { createSsrfGuardedFetch } from "../../src/tools/ssrf-guarded-fetch.ts";

const ALIAS = "host.docker.internal";

afterEach(() => _resetHostLoopbackForTest());

describe("resolveHostLoopback (the local-install gate)", () => {
  test.each([
    [ALIAS, "dev", ALIAS],
    [`  ${ALIAS} `, "dev", ALIAS],
    ["127.0.0.1", "dev", "127.0.0.1"],
    [ALIAS, "workos", null],
    [ALIAS, "oidc", null],
    [ALIAS, undefined, null],
    [undefined, "dev", null],
    ["", "dev", null],
    ["   ", "dev", null],
    [`${ALIAS}:8000`, "dev", null],
    [`http://${ALIAS}`, "dev", null],
    [`${ALIAS}/path`, "dev", null],
    [`user@${ALIAS}`, "dev", null],
  ] as const)("env %p with adapter %p → %p", (env, adapter, expected) => {
    expect(resolveHostLoopback(env, adapter)).toBe(expected);
  });

  test("parseHostAlias lowercases and keeps a bare IPv6 literal", () => {
    expect(parseHostAlias("Host.Docker.Internal")).toBe(ALIAS);
    expect(parseHostAlias("[::1]")).toBe("::1");
  });
});

describe("isLoopbackHostname", () => {
  test.each([
    ["localhost", true],
    ["LOCALHOST", true],
    ["127.0.0.1", true],
    ["::1", true],
    ["[::1]", true],
    ["127.0.0.2", false],
    ["10.0.0.1", false],
    [ALIAS, false],
    ["example.com", false],
  ])("%p → %p", (host, expected) => {
    expect(isLoopbackHostname(host)).toBe(expected);
  });
});

describe("loopbackDial", () => {
  test.each([
    ["http://localhost:8000/mcp?x=1", "http://host.docker.internal:8000/mcp?x=1", "localhost:8000"],
    ["http://127.0.0.1:8000/mcp", "http://host.docker.internal:8000/mcp", "127.0.0.1:8000"],
    ["http://[::1]:8000/mcp", "http://host.docker.internal:8000/mcp", "[::1]:8000"],
    ["http://localhost/mcp", "http://host.docker.internal/mcp", "localhost"],
  ])("dials %p at %p with Host %p", (input, dialed, host) => {
    const out = loopbackDial(new URL(input), { method: "POST" }, ALIAS);
    expect(out.url.toString()).toBe(dialed);
    expect(new Headers(out.init?.headers).get("host")).toBe(host);
    expect(out.init?.method).toBe("POST");
  });

  test("keeps the caller's other headers", () => {
    const out = loopbackDial(
      new URL("http://localhost:8000/mcp"),
      { headers: { Accept: "application/json" } },
      ALIAS,
    );
    const headers = new Headers(out.init?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("host")).toBe("localhost:8000");
  });

  test("an IPv6 alias is bracketed in the dialed URL", () => {
    const out = loopbackDial(new URL("http://localhost:8000/mcp"), undefined, "fd00::1");
    expect(out.url.host).toBe("[fd00::1]:8000");
  });

  test("leaves a non-loopback URL untouched", () => {
    const url = new URL("https://mcp.example.com/mcp");
    const init = { method: "GET" };
    const out = loopbackDial(url, init, ALIAS);
    expect(out.url).toBe(url);
    expect(out.init).toBe(init);
  });

  test("leaves a loopback URL untouched with no alias set", () => {
    const url = new URL("http://localhost:8000/mcp");
    const out = loopbackDial(url, undefined);
    expect(out.url).toBe(url);
    expect(out.init).toBeUndefined();
  });

  test("reads the process alias by default", () => {
    setHostLoopbackAlias(ALIAS);
    expect(loopbackDial(new URL("http://localhost:1/x"), undefined).url.hostname).toBe(ALIAS);
  });
});

describe("the SSRF-guarded fetch with the alias set", () => {
  function recorder(routes: Record<string, { status: number; location?: string }>) {
    const calls: Array<{ url: string; host: string | null }> = [];
    const fetch: FetchLike = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, host: new Headers(init?.headers).get("host") });
      const route = routes[url];
      if (!route) throw new Error(`no route for ${url}`);
      return new Response(null, {
        status: route.status,
        headers: route.location ? { location: route.location } : undefined,
      });
    };
    return { fetch, calls };
  }

  test("validates the stored URL and dials the alias", async () => {
    setHostLoopbackAlias(ALIAS);
    const { fetch, calls } = recorder({ "http://host.docker.internal:8000/mcp": { status: 200 } });
    const guarded = createSsrfGuardedFetch(fetch, { allowInsecure: true, fleetInternal: false });
    const res = await guarded("http://localhost:8000/mcp");
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { url: "http://host.docker.internal:8000/mcp", host: "localhost:8000" },
    ]);
  });

  test("a same-origin redirect is resolved and validated against the stored URL", async () => {
    setHostLoopbackAlias(ALIAS);
    const { fetch, calls } = recorder({
      "http://host.docker.internal:8000/mcp": { status: 307, location: "/mcp/" },
      "http://host.docker.internal:8000/mcp/": { status: 200 },
    });
    const guarded = createSsrfGuardedFetch(fetch, { allowInsecure: true, fleetInternal: false });
    expect((await guarded("http://localhost:8000/mcp")).status).toBe(200);
    expect(calls.map((c) => c.host)).toEqual(["localhost:8000", "localhost:8000"]);
  });

  test("a redirect to the alias itself is cross-origin and refused", async () => {
    setHostLoopbackAlias(ALIAS);
    const { fetch } = recorder({
      "http://host.docker.internal:8000/mcp": {
        status: 302,
        location: "http://host.docker.internal:9000/admin",
      },
    });
    const guarded = createSsrfGuardedFetch(fetch, { allowInsecure: true, fleetInternal: false });
    await expect(guarded("http://localhost:8000/mcp")).rejects.toThrow(/cross-origin/);
  });

  test("private ranges and metadata hosts stay refused with the gate on", async () => {
    setHostLoopbackAlias(ALIAS);
    const { fetch, calls } = recorder({});
    const guarded = createSsrfGuardedFetch(fetch, { allowInsecure: true, fleetInternal: false });
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5:8000/mcp",
      "http://192.168.1.10/mcp",
      "http://metadata.google.internal/computeMetadata/v1/",
      `http://${ALIAS}:8000/mcp`,
    ]) {
      await expect(guarded(url)).rejects.toThrow();
    }
    expect(calls).toEqual([]);
  });

  test("validateConnectorUrl still refuses plain http to the alias and to private ranges", () => {
    for (const url of [`http://${ALIAS}:8000/mcp`, "http://10.1.2.3/mcp", "http://[fd00::1]/mcp"]) {
      expect(() => validateConnectorUrl(new URL(url), { allowInsecure: true })).toThrow();
    }
    expect(() =>
      validateConnectorUrl(new URL("http://[::1]:8000/mcp"), { allowInsecure: true }),
    ).not.toThrow();
  });
});
