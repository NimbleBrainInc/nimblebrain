import { describe, expect, test } from "bun:test";
import { buildForwardHeaders } from "../../src/hooks/forward.ts";

function build(inbound: Record<string, string>, extra: { renames?: Record<string, string> } = {}) {
  return buildForwardHeaders({
    inbound: new Headers(inbound),
    renames: extra.renames,
    credentialHeaders: {},
  });
}

describe("what survives the forward", () => {
  test("a vendor's own headers pass through", () => {
    // The strip list is an exception to pass-through, not the other way round:
    // a vendor signs headers the runtime cannot enumerate, and inverting this to
    // an allowlist would silently break every signing vendor we have not met.
    const headers = build({
      "content-type": "application/json",
      "stripe-signature": "t=1,v1=deadbeef",
      "x-acme-delivery-id": "d_123",
      "user-agent": "Acme-Webhooks/1.0",
    });
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("stripe-signature")).toBe("t=1,v1=deadbeef");
    expect(headers.get("x-acme-delivery-id")).toBe("d_123");
    expect(headers.get("user-agent")).toBe("Acme-Webhooks/1.0");
  });

  test.each([
    "authorization",
    "x-api-key",
    "x-tenant-id",
    "x-workspace-id",
    "x-subject-token",
    "x-user-id",
  ])("an inbound %s never reaches the connector", (name) => {
    // A delivery is an anonymous request. The only identity on the forwarded
    // request is what the edge injects after verifying the runtime's own token.
    expect(build({ [name]: "forged" }).get(name)).toBeNull();
  });

  test.each(["traceparent", "tracestate", "host", "connection", "transfer-encoding"])(
    "an inbound %s is dropped as a hop header",
    (name) => {
      expect(build({ [name]: "x" }).get(name)).toBeNull();
    },
  );

  test.each(["x-nb-hook-kid", "x-nb-anything", "x-nb-", "X-NB-Upper"])(
    "an inbound %s is stripped by the reserved-namespace rule",
    (name) => {
      // `x-nb-*` is reserved: only the edge may place a header there, and it
      // strips the whole prefix because it cannot tell a stamped member from a
      // forged one. The runtime sits AHEAD of the edge, so the rule is only
      // true if this hop refuses to pass one through too.
      expect(build({ [name]: "forged" }).get(name)).toBeNull();
    },
  );
});

describe("the kid does not travel", () => {
  test("no header is added to the forward at all", () => {
    // The forward carries exactly what came in, minus the stripped classes,
    // plus the connection's own credential — and nothing else. A stamped
    // `x-nb-hook-kid` would be dropped one hop later by the edge's namespace
    // rule, reaching nothing; kid correlation lives in the runtime's log.
    const inbound = { "content-type": "application/json", "x-acme-id": "d_1" };
    const headers = build(inbound);
    expect([...headers.keys()].sort()).toEqual(["content-type", "x-acme-id"]);
  });
});

describe("declared header renames", () => {
  test("move a stripped-class header to a name that survives", () => {
    // A vendor that authenticates on `Authorization` cannot otherwise reach its
    // own verifier, and no replay can restore a header that never arrived.
    const headers = build(
      { authorization: "Bearer vendor-secret" },
      { renames: { authorization: "x-acme-signature" } },
    );
    expect(headers.get("x-acme-signature")).toBe("Bearer vendor-secret");
    expect(headers.get("authorization")).toBeNull();
  });

  test("apply to a header that would have passed through anyway", () => {
    const headers = build({ "x-old": "v" }, { renames: { "x-old": "x-new" } });
    expect(headers.get("x-new")).toBe("v");
    expect(headers.get("x-old")).toBeNull();
  });
});

describe("the connection's own credential", () => {
  test("cannot be displaced by an inbound header of the same name", () => {
    const headers = buildForwardHeaders({
      inbound: new Headers({ "x-connector-key": "attacker-value" }),
      kid: "hk_abc",
      credentialHeaders: { "x-connector-key": "operator-value" },
    });
    expect(headers.get("x-connector-key")).toBe("operator-value");
  });
});
