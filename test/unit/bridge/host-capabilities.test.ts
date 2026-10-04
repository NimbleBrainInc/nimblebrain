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
import { NIMBLEBRAIN_EXTENSIONS, UPLOAD_FILES_METHOD } from "../../../web/src/bridge/extensions.ts";
import {
  buildHostCapabilities,
  TASKS_EXTENSION_ID,
} from "../../../web/src/bridge/host-capabilities.ts";
import { SCHEMA_BY_METHOD } from "../../../web/src/bridge/validate.ts";

/**
 * The extension identifiers the handshake offers `appName`. The Files app is
 * offered every one, so its declaration is the one pinned against the bridge.
 */
function declaredExtensions(appName = "files"): string[] {
  const { experimental } = buildHostCapabilities(appName) as {
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
    const caps = buildHostCapabilities("files");
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

  test("the tasks extension is declared under its identifier, as an empty object", () => {
    // The official ext-apps `App` parses the handshake result against the spec
    // schema, which has no `tasks` field and strips one. `experimental`, keyed
    // by the registered extension identifier, is the one slot that survives.
    // The extension has no settings: an app opts each call in on the request.
    const { experimental } = buildHostCapabilities("db-query") as {
      experimental: Record<string, object>;
    };
    expect(TASKS_EXTENSION_ID).toBe("io.modelcontextprotocol/tasks");
    expect(experimental[TASKS_EXTENSION_ID]).toEqual({});
    expect(Object.keys(buildHostCapabilities("files"))).not.toContain("tasks");
  });

  test("upload-files is offered to the Files app and no other", () => {
    // It stores what an app hands over with no step the user takes, so an app
    // that is not the platform's own never sees it declared.
    expect(declaredExtensions("files")).toContain(UPLOAD_FILES_METHOD);
    expect(declaredExtensions("db-query")).not.toContain(UPLOAD_FILES_METHOD);
  });
});
