import { describe, expect, it } from "bun:test";
import { watchGatewayProviders } from "../../../src/runtime/model-gateway-providers.ts";

const GATEWAY = "http://model-gateway.test/";

/** A gateway fetch that answers each call from `answers` in turn (the last repeats). */
function gatewayAnswering(answers: (() => Response)[]) {
  const urls: string[] = [];
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
    urls.push(String(input instanceof Request ? input.url : input));
    const answer = answers[Math.min(urls.length - 1, answers.length - 1)];
    return answer ? answer() : new Response(null, { status: 500 });
  }) as typeof globalThis.fetch;
  return { fetch, urls };
}

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await Bun.sleep(2);
}

describe("watchGatewayProviders", () => {
  it("asks the gateway once and keeps the providers the runtime can build", async () => {
    const gw = gatewayAnswering([
      () => Response.json({ providers: ["anthropic", "google", "mistral"] }),
    ]);
    const watch = watchGatewayProviders({ url: GATEWAY, fetch: gw.fetch });
    await until(() => watch.served() !== undefined);
    expect(watch.served()).toEqual(["anthropic", "google"]);
    expect(gw.urls).toEqual(["http://model-gateway.test/providers"]);
    watch.stop();
  });

  it("knows nothing until the gateway answers, retrying with a growing wait", async () => {
    const gw = gatewayAnswering([
      () => new Response(null, { status: 503 }),
      () => Response.json({ unexpected: true }),
      () => Response.json({ providers: ["openai"] }),
    ]);
    const watch = watchGatewayProviders(
      { url: GATEWAY, fetch: gw.fetch },
      { retryInitialMs: 5, retryMaxMs: 20 },
    );
    expect(watch.served()).toBeUndefined();
    await until(() => watch.served() !== undefined);
    expect(watch.served()).toEqual(["openai"]);
    expect(gw.urls).toHaveLength(3);
    watch.stop();
  });

  it("stops asking once stopped", async () => {
    const gw = gatewayAnswering([() => new Response(null, { status: 503 })]);
    const watch = watchGatewayProviders(
      { url: GATEWAY, fetch: gw.fetch },
      { retryInitialMs: 5, retryMaxMs: 5 },
    );
    await until(() => gw.urls.length >= 1);
    watch.stop();
    const asked = gw.urls.length;
    await Bun.sleep(30);
    expect(gw.urls.length).toBeLessThanOrEqual(asked + 1);
    expect(watch.served()).toBeUndefined();
  });
});
