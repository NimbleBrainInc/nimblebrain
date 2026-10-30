import { afterAll, describe, expect, it } from "bun:test";
import {
  ModelGatewayUnreachableError,
  modelGatewayFetch,
} from "../../src/runtime/model-gateway-fetch.ts";
import { createRunKey, parseRunKeyRing } from "../../src/runtime/run-key.ts";
import { runKeyJwk, runKeyRingValue } from "../helpers/run-key.ts";

// The gateway's fetch over real sockets: a gateway that drops or refuses
// connections fails the call within seconds, and a reachable gateway that is
// slow to answer is left to answer.

const runKey = createRunKey({
  ring: parseRunKeyRing(runKeyRingValue(runKeyJwk("run-1"))),
  issuer: "https://runtime.example.test",
  maxRunMs: 600_000,
});
const gatewayFetch = modelGatewayFetch(runKey, globalThis.fetch, {
  slowResponseMs: 100,
  connectTimeoutMs: 300,
  env: {},
});

const slowGateway = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch() {
    await Bun.sleep(800);
    return new Response("answered");
  },
});
afterAll(() => slowGateway.stop(true));

/** A localhost port with nothing listening on it. */
function closedPort(): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const { port } = server;
  server.stop(true);
  return port;
}

describe("the model gateway's fetch over real sockets", () => {
  it("fails within seconds against an address that drops connections", async () => {
    // TEST-NET-1 (RFC 5737) is never routed: most networks drop the SYN, some
    // answer unreachable at once. Either way the call names the gateway, fast.
    const started = Date.now();
    const err = await gatewayFetch("http://192.0.2.1:9/anthropic/v1/messages", {
      method: "POST",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelGatewayUnreachableError);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("names the gateway when nothing listens on its port", async () => {
    const err = await gatewayFetch(`http://127.0.0.1:${closedPort()}/x`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelGatewayUnreachableError);
  });

  it("waits out a reachable gateway that answers after the connect bound", async () => {
    const response = await gatewayFetch(`http://127.0.0.1:${slowGateway.port}/x`);
    expect(await response.text()).toBe("answered");
  });
});
