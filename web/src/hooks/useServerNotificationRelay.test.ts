/**
 * The web shell's half of the server-notification relay: a `server.notification`
 * SSE event becomes the MCP message the server sent, posted verbatim to that
 * server's iframes on the workspace on screen.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { getActiveWorkspaceId, setActiveWorkspaceId } from "../api/client";
import { useServerNotificationRelay } from "./useServerNotificationRelay";

const LIST_CHANGED = "notifications/resources/list_changed";

// happy-dom cannot parse an attribute selector, so `querySelectorAll` is
// stubbed for the one the hook asks — the same stub `useDataSync.test.ts` uses.
let originalQSA: typeof document.querySelectorAll | undefined;
let fakeIframes: HTMLIFrameElement[] = [];

function mountIframe(appName: string): unknown[] {
  const inbox: unknown[] = [];
  fakeIframes.push({
    dataset: { app: appName },
    contentWindow: { postMessage: (data: unknown) => inbox.push(data) },
  } as unknown as HTMLIFrameElement);
  if (!originalQSA) {
    originalQSA = document.querySelectorAll.bind(document);
    const fallback = originalQSA;
    document.querySelectorAll = ((selector: string) =>
      selector === "iframe[data-app]"
        ? (fakeIframes as unknown as NodeListOf<Element>)
        : fallback(selector)) as typeof document.querySelectorAll;
  }
  return inbox;
}

function relay() {
  return renderHook(() => useServerNotificationRelay()).result.current;
}

let previousWorkspace: string | null;
beforeEach(() => {
  previousWorkspace = getActiveWorkspaceId();
  setActiveWorkspaceId("ws_a");
});

afterEach(() => {
  setActiveWorkspaceId(previousWorkspace);
  if (originalQSA) document.querySelectorAll = originalQSA;
  originalQSA = undefined;
  fakeIframes = [];
});

describe("useServerNotificationRelay", () => {
  test("posts the notification verbatim to every iframe of that server, and no other", () => {
    const sidebar = mountIframe("notes");
    const inline = mountIframe("notes");
    const other = mountIframe("tasks");

    relay()({
      server: "notes",
      workspaceId: "ws_a",
      method: LIST_CHANGED,
      params: { _meta: { n: 1 } },
    });

    const expected = { jsonrpc: "2.0", method: LIST_CHANGED, params: { _meta: { n: 1 } } };
    expect(sidebar).toEqual([expected]);
    expect(inline).toEqual([expected]);
    expect(other).toEqual([]);
  });

  test("a notification with no params is posted with none", () => {
    const inbox = mountIframe("notes");
    relay()({ server: "notes", workspaceId: "ws_a", method: LIST_CHANGED });
    expect(inbox).toEqual([{ jsonrpc: "2.0", method: LIST_CHANGED }]);
  });

  test("a method the host does not relay to views is dropped", () => {
    const inbox = mountIframe("notes");
    relay()({ server: "notes", workspaceId: "ws_a", method: "notifications/message" });
    expect(inbox).toEqual([]);
  });

  test("a notification for a workspace that is not on screen is dropped", () => {
    const inbox = mountIframe("notes");
    relay()({ server: "notes", workspaceId: "ws_b", method: LIST_CHANGED });
    expect(inbox).toEqual([]);
  });

  test("before the active workspace is known, it is delivered rather than lost", () => {
    setActiveWorkspaceId(null);
    const inbox = mountIframe("notes");
    relay()({ server: "notes", workspaceId: "ws_b", method: LIST_CHANGED });
    expect(inbox).toHaveLength(1);
  });
});
