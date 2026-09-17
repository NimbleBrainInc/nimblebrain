/**
 * Serving a method and declaring it are one decision.
 *
 * `@nimblebrain/synapse` checks the host's `ui/initialize` declaration before
 * it sends: `callTool` and `readServerResource` reject with
 * `HostCapabilityError` without `serverTools`/`serverResources`, `sendMessage`
 * and `updateModelContext` send nothing without `message`/`updateModelContext`,
 * and each NimbleBrain extension is gated on its identifier appearing in
 * `hostCapabilities.experimental`. A method the bridge serves but does not
 * declare is therefore one no app can reach — and it fails the way undeclared
 * capabilities always do: silently, in the app, at the call site, with nothing
 * on either side looking wrong.
 *
 * So this pins the two lists to each other rather than pinning either to a
 * hand-written expectation. `SCHEMA_BY_METHOD` is what the host accepts off the
 * wire; `buildHostCapabilities()` is what it promises. Add an extension to one
 * and this fails until it is in the other.
 */

import { describe, expect, test } from "bun:test";
import { NIMBLEBRAIN_EXTENSIONS } from "../../../web/src/bridge/extensions.ts";
import {
  buildHostCapabilities,
  TASKS_EXTENSION_ID,
} from "../../../web/src/bridge/host-capabilities.ts";
import { SCHEMA_BY_METHOD } from "../../../web/src/bridge/validate.ts";

/** The extension identifiers the handshake offers. */
function declaredExtensions(): string[] {
  const { experimental } = buildHostCapabilities() as {
    experimental: Record<string, object>;
  };
  return Object.keys(experimental);
}

describe("the host declares what it serves", () => {
  test("every ai.nimblebrain method the bridge accepts is declared", () => {
    const accepted = Object.keys(SCHEMA_BY_METHOD).filter((m) => m.startsWith("ai.nimblebrain/"));
    // A guard that asserts nothing is worse than no guard: if the prefix ever
    // changes, this would pass over an empty set.
    expect(accepted.length).toBe(NIMBLEBRAIN_EXTENSIONS.length);
    for (const method of accepted) {
      expect(declaredExtensions(), `${method} is served but not declared`).toContain(method);
    }
  });

  test("every declared extension is one the bridge accepts", () => {
    // The other direction: a declaration the bridge cannot answer is a promise
    // it breaks, and the app waits on a request nothing will reply to.
    // Keys, not `toHaveProperty`: these names contain dots, which that matcher
    // reads as a path into the object.
    const accepted = Object.keys(SCHEMA_BY_METHOD);
    for (const method of NIMBLEBRAIN_EXTENSIONS) {
      expect(accepted, `${method} is declared but not served`).toContain(method);
    }
  });

  test("the spec capabilities the SDK gates on are all declared", () => {
    // Each names a `case` in the bridge. Without the declaration the SDK either
    // throws at the call site or drops the send on the floor.
    const caps = buildHostCapabilities();
    for (const name of [
      "openLinks",
      "downloadFile",
      "serverTools",
      "serverResources",
      "message",
      "updateModelContext",
    ]) {
      expect(Object.keys(caps), `${name} is served but not declared`).toContain(name);
    }
  });

  test("tasks is declared under the extension identifier the SDK reads", () => {
    // The official ext-apps `App` parses the handshake result against the spec
    // schema, which has no `tasks` field and strips one. `experimental`, keyed
    // by the registered extension identifier, is the one slot that survives.
    expect(declaredExtensions()).toContain(TASKS_EXTENSION_ID);
    expect(Object.keys(buildHostCapabilities())).not.toContain("tasks");
  });
});
