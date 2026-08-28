import { describe, expect, test } from "bun:test";
import { buildForwardHeaders, HOOK_KID_HEADER } from "../../src/hooks/forward.ts";

function build(inbound: Record<string, string>, extra: { renames?: Record<string, string> } = {}) {
  return buildForwardHeaders({
    inbound: new Headers(inbound),
    kid: "hk_abc",
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

  test("a caller-supplied kid header cannot survive to be mistaken for ours", () => {
    const headers = build({ [HOOK_KID_HEADER]: "hk_someone_elses" });
    expect(headers.get(HOOK_KID_HEADER)).toBe("hk_abc");
  });
});

describe("the kid header", () => {
  test("is stamped from the token", () => {
    expect(build({}).get(HOOK_KID_HEADER)).toBe("hk_abc");
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
