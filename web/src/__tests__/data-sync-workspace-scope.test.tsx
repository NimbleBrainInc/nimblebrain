// ---------------------------------------------------------------------------
// useDataSync — a change in another workspace is not your change
//
// The same app installed in two workspaces has the same bare `data-app`, so a
// change in one must not send the other's iframe to re-fetch.
//
// Two filters, and this is the narrower one. The server already scopes the
// fan-out to the caller's workspace MEMBERSHIPS (`broadcast`'s third argument,
// pinned in test/unit/sse-event-manager.test.ts). Membership is the broader
// set — a user in both A and B receives both — so narrowing to the workspace
// actually on screen still has to happen here.
//
// The filter is deliberately POSITIVE-mismatch only. Two cases must still be
// delivered, and both are load-bearing:
//   - an event with no `wsId` — an identity-door call (`conversations`, `files`,
//     `automations`) belongs to no workspace at all;
//   - a browser with no active workspace — there is nothing to compare against.
// Dropping either would turn a scoping fix into a silent no-refresh bug for the
// apps that were working before the field existed.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderHook } from "@testing-library/react";

let activeWorkspaceId: string | null = null;

mock.module("../api/client", () => ({
  getActiveWorkspaceId: () => activeWorkspaceId,
}));

const { useDataSync } = await import("../hooks/useDataSync");

/** The hook's returned callback, rendered for real. */
function makeHandler(): ReturnType<typeof useDataSync> {
  return renderHook(() => useDataSync()).result.current;
}

/**
 * The iframes `flush` will find, and what each received.
 *
 * `document.querySelectorAll` is stubbed rather than mounting real elements:
 * happy-dom's selector parser throws on `iframe[data-app]` in this environment,
 * which has nothing to do with the behaviour under test.
 */
function mountIframes(...apps: string[]): Array<{ app: string; sent: unknown[] }> {
  const frames = apps.map((app) => {
    const sent: unknown[] = [];
    return {
      app,
      sent,
      el: { dataset: { app }, contentWindow: { postMessage: (m: unknown) => sent.push(m) } },
    };
  });
  // biome-ignore lint/suspicious/noExplicitAny: narrow stub for one selector
  (document as any).querySelectorAll = (selector: string) =>
    selector === "iframe[data-app]" ? frames.map((f) => f.el) : [];
  return frames;
}

const WS_A = "ws_00000000000000aa";
const WS_B = "ws_00000000000000bb";

describe("useDataSync — workspace scoping", () => {
  beforeEach(() => {
    activeWorkspaceId = null;
  });

  test("a change in ANOTHER workspace never reaches the iframe", async () => {
    activeWorkspaceId = WS_A;
    const [frame] = mountIframes("db-query");
    const onDataChanged = makeHandler();

    onDataChanged({
      server: "db-query",
      tool: "save_query",
      wsId: WS_B,
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 150));

    expect(frame.sent).toEqual([]);
  });

  test("a change in MY workspace reaches it", async () => {
    activeWorkspaceId = WS_A;
    const [frame] = mountIframes("db-query");
    const onDataChanged = makeHandler();

    onDataChanged({
      server: "db-query",
      tool: "save_query",
      wsId: WS_A,
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 150));

    expect(frame.sent).toHaveLength(1);
  });

  test("an event with no workspace still reaches it (identity door)", async () => {
    activeWorkspaceId = WS_A;
    const [frame] = mountIframes("files");
    const onDataChanged = makeHandler();

    onDataChanged({ server: "files", tool: "create", timestamp: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 150));

    expect(frame.sent).toHaveLength(1);
  });

  test("with no active workspace, nothing is filtered out", async () => {
    activeWorkspaceId = null;
    const [frame] = mountIframes("db-query");
    const onDataChanged = makeHandler();

    onDataChanged({
      server: "db-query",
      tool: "save_query",
      wsId: WS_B,
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 150));

    expect(frame.sent).toHaveLength(1);
  });
});
