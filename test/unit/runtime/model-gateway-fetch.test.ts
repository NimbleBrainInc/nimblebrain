import { describe, expect, it } from "bun:test";
import { isRetryable } from "../../../src/engine/retry.ts";
import { buildModelResolver } from "../../../src/model/registry.ts";
import { callModel } from "../../../src/model/stream.ts";
import {
  type GatewayConnect,
  ModelGatewayUnreachableError,
  modelGatewayFetch,
} from "../../../src/runtime/model-gateway-fetch.ts";
import { runWithRequestContext } from "../../../src/runtime/request-context.ts";
import {
  createRunKey,
  MODEL_CREDENTIAL_LEEWAY_MS,
  MODEL_GATEWAY_AUDIENCE,
  parseRunKeyRing,
} from "../../../src/runtime/run-key.ts";
import { fakeFetch } from "../../helpers/fake-fetch.ts";
import { runKeyJwk, runKeyRingValue, verifyAsGateway } from "../../helpers/run-key.ts";

// A provider reached through the model gateway carries no key of its own: each
// call presents a model credential minted for it, naming the run it belongs to.

const ISSUER = "https://runtime.example.test";
const runKey = createRunKey({
  ring: parseRunKeyRing(runKeyRingValue(runKeyJwk("run-1"))),
  issuer: ISSUER,
  maxRunMs: 600_000,
});

/** Send one call through the gateway fetch and return the headers it went out with. */
async function sent(init: RequestInit): Promise<Headers> {
  let headers = new Headers();
  const base = fakeFetch(async (_input, i) => {
    headers = new Headers(i?.headers);
    return new Response("{}");
  });
  await modelGatewayFetch(runKey, base)("http://gateway.test/anthropic/v1/messages", init);
  return headers;
}

async function claimsOf(headers: Headers): Promise<Record<string, unknown>> {
  const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const { claims } = await verifyAsGateway(token, runKey.keySet(), {
    issuer: ISSUER,
    audience: MODEL_GATEWAY_AUDIENCE,
  });
  return claims;
}

describe("the model gateway's fetch", () => {
  it("presents a credential naming the run and its workspace, and no provider key", async () => {
    const headers = await runWithRequestContext(
      { identity: null, credentialSubject: "run_abc", workspaceId: "ws_acme" },
      () =>
        sent({
          headers: {
            "x-api-key": "via-model-gateway",
            "x-goog-api-key": "via-model-gateway",
            authorization: "Bearer via-model-gateway",
            "anthropic-version": "2023-06-01",
          },
        }),
    );
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("x-goog-api-key")).toBeNull();
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    const claims = await claimsOf(headers);
    expect(claims).toMatchObject({ sub: "run_abc", workspace: "ws_acme" });
    // Minted for the call alone: a minute plus the gateway's leeway.
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(
      (60_000 + MODEL_CREDENTIAL_LEEWAY_MS) / 1000 + 1,
    );
  });

  it("gives a call outside any run a subject of its own, so it shares no budget", async () => {
    const first = await claimsOf(await sent({}));
    const second = await claimsOf(await sent({}));
    expect(String(first.sub)).toStartWith("call_");
    expect(first.sub).not.toBe(second.sub);
    expect(first.workspace).toBe("none");
  });
});

// A gateway that drops connections leaves Bun's fetch, which has no connect
// timeout, waiting until the model stream's first-content watchdog (90s) fires,
// once per retry. The gateway's fetch checks a slow call's gateway is reachable
// and fails the call within seconds when it is not; it never bounds a response.

/** A call that never answers: it settles only when its signal aborts. */
const hangingFetch = (calls: { signal?: AbortSignal }[] = []) =>
  fakeFetch(
    (_input, init) =>
      new Promise<Response>((_, reject) => {
        const signal = init?.signal ?? undefined;
        calls.push({ signal });
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );

/** A gateway that accepts no connection: the connect settles only when aborted. */
const dropping: GatewayConnect = (_host, _port, signal) =>
  new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

/** A gateway that accepts every connection. */
const accepting: GatewayConnect = async () => {};

const FAST = { slowResponseMs: 20, connectTimeoutMs: 50, env: {} };

describe("the model gateway's fetch, when the gateway cannot be reached", () => {
  it("fails a call to a gateway that drops connections within the connect bound, and abandons the call", async () => {
    const calls: { signal?: AbortSignal }[] = [];
    const gatewayFetch = modelGatewayFetch(runKey, hangingFetch(calls), {
      ...FAST,
      connect: dropping,
    });
    const started = Date.now();
    const err = await gatewayFetch("http://gateway.test/anthropic/v1/messages", {}).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ModelGatewayUnreachableError);
    expect((err as Error).message).toBe(
      "The model gateway is unreachable: no connection within 50ms",
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls[0]?.signal?.aborted).toBe(true);
    // Nothing reached the client, so the engine re-issues it.
    expect(isRetryable(err)).toBe(true);
  });

  it("checks the gateway the call goes to, on its scheme's port", async () => {
    const targets: string[] = [];
    const record: GatewayConnect = async (host, port) => {
      targets.push(`${host}:${port}`);
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    };
    for (const url of ["https://gw.test/x", "http://gw.test:8080/x", "http://[::1]/x"]) {
      await modelGatewayFetch(runKey, hangingFetch(), { ...FAST, connect: record })(url).catch(
        () => {},
      );
    }
    expect(targets).toEqual(["gw.test:443", "gw.test:8080", "::1:80"]);
  });

  it("names the gateway when the call itself fails to connect", async () => {
    const refused = fakeFetch(async () => {
      throw Object.assign(new TypeError("Unable to connect"), { code: "ECONNREFUSED" });
    });
    const err = await modelGatewayFetch(runKey, refused, { ...FAST, connect: accepting })(
      "http://gateway.test/x",
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelGatewayUnreachableError);
    expect((err as Error).message).toBe(
      "The model gateway is unreachable: could not connect (ECONNREFUSED)",
    );
  });

  it("leaves a slow response to a reachable gateway alone, however long it takes", async () => {
    const slow = fakeFetch(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response("ok")), 300)),
    );
    const response = await modelGatewayFetch(runKey, slow, { ...FAST, connect: accepting })(
      "http://gateway.test/x",
    );
    expect(await response.text()).toBe("ok");
  });

  it("lets a caller's abort through as itself, not as an unreachable gateway", async () => {
    const caller = new AbortController();
    const reason = new Error("cancelled by the caller");
    setTimeout(() => caller.abort(reason), 30);
    const err = await modelGatewayFetch(runKey, hangingFetch(), {
      slowResponseMs: 10,
      connectTimeoutMs: 1_000,
      env: {},
      connect: dropping,
    })("http://gateway.test/x", { signal: caller.signal }).catch((e: unknown) => e);
    expect(err).toBe(reason);
  });

  it("does not check a gateway behind a proxy, which a direct connect would not test", async () => {
    let checked = false;
    const slow = fakeFetch(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response("ok")), 100)),
    );
    const response = await modelGatewayFetch(runKey, slow, {
      ...FAST,
      env: { HTTPS_PROXY: "http://proxy.test:3128" },
      connect: async () => {
        checked = true;
        throw new Error("unreachable");
      },
    })("http://gateway.test/x");
    expect(await response.text()).toBe("ok");
    expect(checked).toBe(false);
  });

  it("fails a model call as an unreachable gateway, not a stream stall", async () => {
    const resolve = buildModelResolver(
      {},
      {
        url: "http://gateway.test",
        fetch: modelGatewayFetch(runKey, hangingFetch(), { ...FAST, connect: dropping }),
      },
    );
    const err = await callModel(
      resolve("anthropic:claude-sonnet-4-6"),
      { prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }] },
      () => {},
      undefined,
      undefined,
      undefined,
      { firstContentMs: 5_000 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelGatewayUnreachableError);
  });
});
