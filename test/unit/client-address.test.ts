import { describe, expect, test } from "bun:test";
import {
  clientAddressFor,
  DEFAULT_TRUSTED_PROXY_HOPS,
  trustedProxyHops,
  TRUSTED_PROXY_HOPS_ENV,
} from "../../src/api/client-address.ts";

function headers(xff?: string): Headers {
  return new Headers(xff === undefined ? {} : { "x-forwarded-for": xff });
}

describe("clientAddressFor", () => {
  test("takes the right-most entry with one trusted hop", () => {
    // Each proxy APPENDS what it saw, so the right-most entry is the one our
    // own load balancer wrote — the only one a caller cannot author.
    expect(clientAddressFor(headers("9.9.9.9, 203.0.113.7"), "10.0.0.1", 1)).toBe("203.0.113.7");
  });

  test("counts back from the right for a longer trusted chain", () => {
    expect(
      clientAddressFor(headers("9.9.9.9, 203.0.113.7, 198.51.100.4"), "10.0.0.1", 2),
    ).toBe("203.0.113.7");
  });

  test("ignores entries a caller prepended", () => {
    // The forged entries sit to the LEFT of what our proxy appended, so they
    // cannot move the key. This is the property the whole rule exists for: a
    // flooding host must not be able to pick a fresh bucket per request.
    const forged = clientAddressFor(headers("evil-1, evil-2, 203.0.113.7"), "10.0.0.1", 1);
    const honest = clientAddressFor(headers("203.0.113.7"), "10.0.0.1", 1);
    expect(forged).toBe(honest);
  });

  test("falls back to the socket peer when there is no forwarded chain", () => {
    expect(clientAddressFor(headers(), "10.0.0.1", 1)).toBe("10.0.0.1");
  });

  test("falls back to the peer when the chain is shorter than the trusted hop count", () => {
    // Fewer entries than proxies we expect means the request did not come
    // through them, so none of its entries were appended by us — reaching left
    // would land in caller-written territory.
    expect(clientAddressFor(headers("9.9.9.9"), "10.0.0.1", 3)).toBe("10.0.0.1");
  });

  test("tolerates whitespace and empty entries", () => {
    expect(clientAddressFor(headers("  9.9.9.9 ,  , 203.0.113.7  "), null, 1)).toBe("203.0.113.7");
  });

  test("collapses to one shared bucket only when nothing identifies the caller", () => {
    expect(clientAddressFor(headers(), null, 1)).toBe("unknown");
    expect(clientAddressFor(headers(), "   ", 1)).toBe("unknown");
  });
});

describe("trustedProxyHops", () => {
  test("defaults to one — the shared load balancer in front of a tenant", () => {
    expect(trustedProxyHops({})).toBe(DEFAULT_TRUSTED_PROXY_HOPS);
    expect(DEFAULT_TRUSTED_PROXY_HOPS).toBe(1);
  });

  test("honors an explicit count", () => {
    expect(trustedProxyHops({ [TRUSTED_PROXY_HOPS_ENV]: "2" })).toBe(2);
  });

  test.each([
    ["not a number", "many"],
    ["zero", "0"],
    ["negative", "-1"],
  ])("falls back to the default for %s rather than trusting more hops", (_label, value) => {
    // Too FEW hops collapses buckets (availability); too MANY lets the caller
    // choose their own key (bypass). A typo has to fail toward the first.
    expect(trustedProxyHops({ [TRUSTED_PROXY_HOPS_ENV]: value })).toBe(DEFAULT_TRUSTED_PROXY_HOPS);
  });
});
