// ---------------------------------------------------------------------------
// nb__search / tool discovery is identity-scoped, not workspace-scoped.
//
// Regression for the cross-workspace search bug: the Stage 2 aggregator
// namespaces every tool per workspace — including the system tools — so
// `nb__search` is duplicated across every workspace the identity can see.
// Each copy used to search ONLY its own workspace's registry. A model that
// invoked the personal workspace's `nb__search` could not see a tool
// (e.g. a CRM) installed in another workspace, and reported "no CRM tools
// installed" even though the bundle was running there.
//
// `Runtime.listDiscoverableTools()` (what `nb__search scope:tools` reads)
// must return the identity's full cross-workspace UNION regardless of which
// workspace is in request context. This pins exactly that: from the
// PERSONAL workspace's context, discovery still surfaces the SHARED
// workspace's tool.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it } from "bun:test";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { createTwoWorkspaceFixture, type TwoWorkspaceFixture } from "../helpers/two-workspace-fixture.ts";

let fx: TwoWorkspaceFixture | null = null;

afterEach(async () => {
  await fx?.cleanup();
  fx = null;
});

describe("tool discovery is identity-scoped (cross-workspace)", () => {
  it("from the personal workspace's context, listDiscoverableTools includes a tool installed in another workspace", async () => {
    fx = await createTwoWorkspaceFixture();

    // Request context pinned to the PERSONAL workspace — the exact frame
    // the buggy `ws_user_<id>-nb__search` call ran under.
    const names = await runWithRequestContext(
      { identity: fx.identity, workspaceId: fx.personal.id },
      () => fx!.runtime.listDiscoverableTools(),
    ).then((tools) => tools.map((t) => t.name));

    // The shared workspace's tool (the "CRM in another workspace") must be
    // discoverable even though the caller is in the personal workspace.
    expect(names).toContain(fx.shared.qualifiedToolName);
    // The caller's own workspace tool is present too — it's a union, not a swap.
    expect(names).toContain(fx.personal.qualifiedToolName);
  });

  it("the union is identity-stable: same result regardless of which workspace is in context", async () => {
    fx = await createTwoWorkspaceFixture();

    const fromShared = await runWithRequestContext(
      { identity: fx.identity, workspaceId: fx.shared.id },
      () => fx!.runtime.listDiscoverableTools(),
    ).then((t) => t.map((x) => x.name).sort());

    const fromPersonal = await runWithRequestContext(
      { identity: fx.identity, workspaceId: fx.personal.id },
      () => fx!.runtime.listDiscoverableTools(),
    ).then((t) => t.map((x) => x.name).sort());

    // Whichever workspace's copy of nb__search the model happens to call,
    // it sees the same identity-wide union — so discovery can't depend on
    // an arbitrary pick.
    expect(fromShared).toEqual(fromPersonal);
    expect(fromShared).toContain(fx.shared.qualifiedToolName);
    expect(fromShared).toContain(fx.personal.qualifiedToolName);
  });
});
