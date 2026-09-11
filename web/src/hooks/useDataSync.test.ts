// ---------------------------------------------------------------------------
// useDataSync — postMessage shape (issue #99 regression pin)
//
// `data.changed` fan-out targets srcdoc iframes (null origin). `postMessage`'s
// targetOrigin must stay `"*"` — the literal "null" string is rejected by
// the browser. Pin the shape so any tightening attempt has to also solve
// the null-origin problem (sandbox-proxy work in iframe.ts).
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, test } from "bun:test";
import {
  JSONRPCNotificationSchema,
  ResourceListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { renderHook } from "@testing-library/react";
import { useDataSync } from "./useDataSync";

interface CapturedPost {
  data: unknown;
  targetOrigin: string;
}

let originalQSA: typeof document.querySelectorAll;
let fakeIframes: HTMLIFrameElement[] = [];

afterEach(() => {
  if (originalQSA) document.querySelectorAll = originalQSA;
  fakeIframes = [];
});

function installIframeStub(appName: string): CapturedPost[] {
  const posts: CapturedPost[] = [];
  const iframe = {
    dataset: { app: appName },
    contentWindow: {
      postMessage(data: unknown, targetOrigin: string) {
        posts.push({ data, targetOrigin });
      },
    },
  } as unknown as HTMLIFrameElement;
  fakeIframes.push(iframe);

  // Patch once per test: a second stub in the same test would otherwise bind
  // the patched function as the "original", and `afterEach` would restore that.
  if (fakeIframes.length === 1) {
    originalQSA = document.querySelectorAll.bind(document);
    document.querySelectorAll = ((selector: string) => {
      if (selector === "iframe[data-app]") {
        return fakeIframes as unknown as NodeListOf<Element>;
      }
      return originalQSA(selector);
    }) as typeof document.querySelectorAll;
  }

  return posts;
}

describe("useDataSync postMessage", () => {
  test("posts data.changed with targetOrigin '*' (null-origin srcdoc constraint)", async () => {
    const posts = installIframeStub("synapse-research");
    const { result } = renderHook(() => useDataSync());

    result.current({
      server: "synapse-research",
      tool: "search",
      timestamp: "2026-05-14T00:00:00Z",
    });

    // Debounce window is 100 ms; wait past it.
    await new Promise((r) => setTimeout(r, 150));

    expect(posts.length).toBe(1);
    expect(posts[0]?.targetOrigin).toBe("*");
    expect((posts[0]?.data as { method?: string })?.method).toBe("synapse/data-changed");
  });
});

// ---------------------------------------------------------------------------
// Two producers, two wire forms
//
// An agent-detected change goes to the iframe as the NimbleBrain extension
// `synapse/data-changed`, naming the tool. A change the app's own server
// announced goes as the MCP spec's `notifications/resources/list_changed`, so an
// app written against the MCP Apps spec hears it without knowing this host.
// ---------------------------------------------------------------------------

const TS = "2026-09-10T00:00:00Z";
const pastDebounce = () => new Promise((r) => setTimeout(r, 150));

describe("useDataSync — server-announced changes", () => {
  test("posts the spec notification, not the synapse extension", async () => {
    const posts = installIframeStub("notes");
    const { result } = renderHook(() => useDataSync());

    result.current({ source: "server", server: "notes", timestamp: TS });
    await pastDebounce();

    expect(posts).toHaveLength(1);
    const message = posts[0]?.data;
    expect(message).toEqual({ jsonrpc: "2.0", method: "notifications/resources/list_changed" });
    // Valid as a JSON-RPC notification AND as the spec's own notification type.
    expect(JSONRPCNotificationSchema.safeParse(message).success).toBe(true);
    expect(ResourceListChangedNotificationSchema.safeParse(message).success).toBe(true);
  });

  test("several announcements in one window collapse to one post", async () => {
    // The notification carries nothing, so N of them say what one says.
    const posts = installIframeStub("notes");
    const { result } = renderHook(() => useDataSync());

    for (let i = 0; i < 3; i++) {
      result.current({ source: "server", server: "notes", timestamp: TS });
    }
    await pastDebounce();

    expect(posts).toHaveLength(1);
  });

  test("an agent change and a server announcement in one window both arrive, each in its own form", async () => {
    const posts = installIframeStub("notes");
    const { result } = renderHook(() => useDataSync());

    result.current({ source: "agent", server: "notes", tool: "save", timestamp: TS });
    result.current({ source: "server", server: "notes", timestamp: TS });
    await pastDebounce();

    expect(posts.map((p) => p.data)).toEqual([
      {
        jsonrpc: "2.0",
        method: "synapse/data-changed",
        params: { source: "agent", server: "notes", tool: "save" },
      },
      { jsonrpc: "2.0", method: "notifications/resources/list_changed" },
    ]);
  });

  test("an announcement for another app reaches only that app", async () => {
    const notesPosts = installIframeStub("notes");
    const tasksPosts = installIframeStub("tasks");
    const { result } = renderHook(() => useDataSync());

    result.current({ source: "server", server: "tasks", timestamp: TS });
    await pastDebounce();

    expect(notesPosts).toHaveLength(0);
    expect(tasksPosts).toHaveLength(1);
  });
});
