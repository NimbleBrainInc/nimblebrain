import { describe, expect, test } from "bun:test";
import type { AutomationRunTrigger } from "../../../../src/bundles/automations/src/scheduler.ts";
import type { Automation } from "../../../../src/bundles/automations/src/types.ts";
import type { UserIdentity } from "../../../../src/identity/provider.ts";
import { resolveExecutorContext } from "../../../../src/tools/platform/automations.ts";
import type { RequestContext } from "../../../../src/runtime/request-context.ts";

// The automation under test is owned by, and focused on, workspace A.
const automation = {
  id: "nb-morning-sweep",
  ownerId: "usr_owner_a",
  workspaceId: "ws_a_shared",
} as Automation;

// An ambient request context for a DIFFERENT workspace B — the stale context a
// scheduler timer can capture when an automation is created/edited from a chat
// in workspace B (AsyncLocalStorage propagates through the re-arm `setTimeout`).
const otherWorkspaceCtx: RequestContext = {
  identity: { id: "usr_other_b", email: "b@example.com", displayName: "B", orgRole: "member" } as UserIdentity,
  scope: {
    kind: "workspace",
    workspaceId: "ws_b_other",
    workspaceAgents: null,
    workspaceModelOverride: null,
  },
};

describe("resolveExecutorContext", () => {
  // The bug: a scheduled run inheriting workspace B's context ran focused on B,
  // not its own workspace A. The scheduled path must IGNORE ambient context.
  test("scheduled run ignores an ambient (leaked) workspace context", () => {
    const ctx = resolveExecutorContext(automation, "scheduled", otherWorkspaceCtx);
    expect(ctx.workspaceId).toBe("ws_a_shared");
    expect(ctx.identity).toEqual({ id: "usr_owner_a" });
  });

  test("scheduled run uses the automation's owner + provenance when no ambient context", () => {
    const ctx = resolveExecutorContext(automation, "scheduled", undefined);
    expect(ctx.workspaceId).toBe("ws_a_shared");
    expect(ctx.identity).toEqual({ id: "usr_owner_a" });
  });

  // A manual test-button run is dispatched synchronously inside the clicking
  // user's genuine context, so it legitimately uses it.
  test("manual run uses the ambient request context", () => {
    const ctx = resolveExecutorContext(automation, "manual", otherWorkspaceCtx);
    expect(ctx.workspaceId).toBe("ws_b_other");
    expect(ctx.identity).toEqual(otherWorkspaceCtx.identity);
  });

  test("manual run falls back to the automation's owner + provenance with no ambient context", () => {
    const ctx = resolveExecutorContext(automation, "manual", undefined);
    expect(ctx.workspaceId).toBe("ws_a_shared");
    expect(ctx.identity).toEqual({ id: "usr_owner_a" });
  });

  // An identity-scoped ambient context (no workspace) must not leak a workspace
  // into a manual run; it falls back to the automation's provenance.
  test("manual run with an identity-scope context falls back to provenance workspace", () => {
    const identityCtx: RequestContext = {
      identity: { id: "usr_other_b", email: "b@example.com", displayName: "B", orgRole: "member" } as UserIdentity,
      scope: { kind: "identity" },
    };
    const ctx = resolveExecutorContext(automation, "manual", identityCtx);
    expect(ctx.workspaceId).toBe("ws_a_shared");
    expect(ctx.identity).toEqual(identityCtx.identity);
  });

  test("scheduled run with an automation lacking owner/workspace yields undefined fields", () => {
    const ctx = resolveExecutorContext({ id: "x" } as Automation, "scheduled", otherWorkspaceCtx);
    expect(ctx.workspaceId).toBeUndefined();
    expect(ctx.identity).toBeUndefined();
  });

  // Fail-closed: only an explicit "manual" reads ambient context. An unknown or
  // missing trigger (e.g. an untyped/test caller, or a future trigger value)
  // must fall through to the isolated owner/provenance path — never the ambient
  // workspace — so a new dispatch path that forgets to opt in can't leak.
  test("an unknown/undefined trigger does NOT read ambient context", () => {
    const ctx = resolveExecutorContext(
      automation,
      undefined as unknown as AutomationRunTrigger,
      otherWorkspaceCtx,
    );
    expect(ctx.workspaceId).toBe("ws_a_shared");
    expect(ctx.identity).toEqual({ id: "usr_owner_a" });
  });
});
