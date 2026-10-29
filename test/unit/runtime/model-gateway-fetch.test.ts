import { describe, expect, it } from "bun:test";
import { modelGatewayFetch } from "../../../src/runtime/model-gateway-fetch.ts";
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
