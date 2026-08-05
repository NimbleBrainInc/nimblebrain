/**
 * The 401-vs-503 boundary at request verification.
 *
 * `verifyRequest` returning `null` means "not authenticated" — a verdict the
 * client acts on by re-authenticating. A `TransientAuthError` means we never
 * reached a verdict. Collapsing the two logs valid users out over our own
 * outages, because the web client's post-refresh retry leg treats any 401 as
 * terminal.
 */

import { describe, expect, it } from "bun:test";
import type { EngineEvent, EventSink } from "../../../src/engine/types.ts";
import { authenticateRequest, isAuthError } from "../../../src/api/auth-middleware.ts";
import type { AuthMiddlewareOptions } from "../../../src/api/auth-middleware.ts";
import { TransientAuthError } from "../../../src/identity/provider.ts";
import type { IdentityProvider, UserIdentity } from "../../../src/identity/provider.ts";

const IDENTITY: UserIdentity = {
  id: "user_1",
  email: "a@b.c",
  displayName: "A",
  orgRole: "member",
  preferences: {},
};

/** Records audit events so a test can assert what was and wasn't audited. */
function recordingSink(): { sink: EventSink; events: EngineEvent[] } {
  const events: EngineEvent[] = [];
  return { sink: { emit: (e: EngineEvent) => events.push(e) }, events };
}

function optionsWith(verify: () => Promise<UserIdentity | null>, sink: EventSink) {
  const provider = { verifyRequest: verify } as unknown as IdentityProvider;
  return {
    mode: { type: "adapter", provider },
    internalToken: "internal-token-not-used-here",
    eventSink: sink,
  } as unknown as AuthMiddlewareOptions;
}

const req = () => new Request("https://example.test/v1/bootstrap");

describe("authenticateRequest — verdict vs unavailability", () => {
  it("maps a terminal null to 401 and audits it", async () => {
    const { sink, events } = recordingSink();
    const result = await authenticateRequest(req(), optionsWith(async () => null, sink));

    expect(isAuthError(result)).toBe(true);
    expect((result as Response).status).toBe(401);
    expect(events.filter((e) => e.type === "audit.auth_failure")).toHaveLength(1);
  });

  it("maps a TransientAuthError to 503 with Retry-After", async () => {
    const { sink } = recordingSink();
    const result = await authenticateRequest(
      req(),
      optionsWith(async () => {
        throw new TransientAuthError("jwks_unavailable", "boom");
      }, sink),
    );

    expect(isAuthError(result)).toBe(true);
    expect((result as Response).status).toBe(503);
    expect((result as Response).headers.get("Retry-After")).toBe("1");
  });

  it("does not audit an unavailability as an auth failure", async () => {
    const { sink, events } = recordingSink();
    await authenticateRequest(
      req(),
      optionsWith(async () => {
        throw new TransientAuthError("user_unresolvable", "boom");
      }, sink),
    );

    // `audit.auth_failure` is a security signal about callers. Our own
    // dependency being down is an availability event; auditing it dilutes the
    // signal and makes an outage look like an attack.
    expect(events.filter((e) => e.type === "audit.auth_failure")).toHaveLength(0);
  });

  it("lets a non-transient throw propagate rather than masking it as 503", async () => {
    const { sink } = recordingSink();
    const boom = new Error("programmer error");
    const promise = authenticateRequest(
      req(),
      optionsWith(async () => {
        throw boom;
      }, sink),
    );
    expect(await promise.then(() => null, (e) => e)).toBe(boom);
  });

  it("still returns the identity on success", async () => {
    const { sink } = recordingSink();
    const result = await authenticateRequest(req(), optionsWith(async () => IDENTITY, sink));
    expect(isAuthError(result)).toBe(false);
    expect((result as { identity?: UserIdentity }).identity).toEqual(IDENTITY);
  });
});
