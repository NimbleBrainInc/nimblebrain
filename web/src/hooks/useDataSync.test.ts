// ---------------------------------------------------------------------------
// useDataSync — postMessage shape (issue #99 regression pin)
//
// `data.changed` fan-out targets srcdoc iframes (null origin). `postMessage`'s
// targetOrigin must stay `"*"` — the literal "null" string is rejected by
// the browser. Pin the shape so any tightening attempt has to also solve
// the null-origin problem (sandbox-proxy work in iframe.ts).
// ---------------------------------------------------------------------------

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
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

  originalQSA = document.querySelectorAll.bind(document);
  document.querySelectorAll = ((selector: string) => {
    if (selector === "iframe[data-app]") {
      return fakeIframes as unknown as NodeListOf<Element>;
    }
    return originalQSA(selector);
  }) as typeof document.querySelectorAll;

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
