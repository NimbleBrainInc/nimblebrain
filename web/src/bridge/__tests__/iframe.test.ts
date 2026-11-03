import { describe, expect, test } from "bun:test";
import { loadAppFrame } from "../../../test/app-frame";
import { APP_FRAME_PATH, appWindowOf, buildCSP, createAppIframe, onAppMessage } from "../iframe.ts";

describe("createAppIframe sandbox", () => {
  function sandboxTokens(): string[] {
    const { app } = loadAppFrame(createAppIframe("<p>hi</p>", "test-app"), { postMessage() {} });
    return (app.getAttribute("sandbox") ?? "").split(/\s+/).filter(Boolean);
  }

  // Security regression pin: with `srcdoc`, `allow-same-origin` would make the
  // third-party app frame same-origin with the host — a full sandbox escape
  // (read window.parent, ride the session cookie, remove its own sandbox).
  test("does NOT grant allow-same-origin (app runs in an opaque origin)", () => {
    expect(sandboxTokens()).not.toContain("allow-same-origin");
  });

  test("still grants allow-scripts (the app is an interactive UI)", () => {
    expect(sandboxTokens()).toContain("allow-scripts");
  });
});

describe("createAppIframe nests the app in the frame page", () => {
  test("the frame loads the fixed frame page, never the app's markup", () => {
    const frame = createAppIframe("<p>hi</p>", "test-app");
    expect(frame.getAttribute("src")).toBe(APP_FRAME_PATH);
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    expect(APP_FRAME_PATH).not.toContain("?");
  });

  test("the app renders inside the frame page, and its window is the one the host talks to", () => {
    const frame = createAppIframe("<p>hi</p>", "test-app");
    const appWindow = { postMessage() {} };
    const { app } = loadAppFrame(frame, appWindow);
    expect(frame.contentDocument).toBe(app.ownerDocument);
    expect(app.getAttribute("srcdoc")).toContain("<p>hi</p>");
    expect<unknown>(appWindowOf(frame)).toBe(appWindow);
  });

  test("what the app posts to the frame page reaches the host, until it stops listening", () => {
    const frame = createAppIframe("<p>hi</p>", "test-app");
    const loaded = loadAppFrame(frame, { postMessage() {} });
    const heard: unknown[] = [];
    const stop = onAppMessage(frame, (event) => heard.push(event.data));
    loaded.post({ n: 1 });
    stop();
    loaded.post({ n: 2 });
    expect(heard).toEqual([{ n: 1 }]);
  });

  test("a page that is not the frame page hosts no app", () => {
    const frame = createAppIframe("<p>hi</p>", "test-app");
    const page = document.implementation.createHTMLDocument("not found");
    Object.defineProperty(frame, "contentDocument", { configurable: true, get: () => page });
    Object.defineProperty(frame, "contentWindow", {
      configurable: true,
      get: () => new window.EventTarget(),
    });
    frame.dispatchEvent(new window.Event("load"));
    expect(page.querySelector("iframe")).toBeNull();
    expect(appWindowOf(frame)).toBeNull();
  });
});

describe("buildCSP", () => {
  test("does not contain unsafe-eval", () => {
    const csp = buildCSP();
    expect(csp).not.toContain("unsafe-eval");
  });

  test("contains unsafe-inline for bridge communication", () => {
    const csp = buildCSP();
    expect(csp).toContain("'unsafe-inline'");
  });

  test("includes connect domains when provided", () => {
    const csp = buildCSP({
      connectDomains: ["https://api.example.com", "https://cdn.example.com"],
    });
    expect(csp).toContain("connect-src https://api.example.com https://cdn.example.com");
  });

  test("returns connect-src 'none' when no domains provided", () => {
    const csp = buildCSP();
    expect(csp).toContain("connect-src 'none'");
  });

  test("returns connect-src 'none' for empty domains array", () => {
    const csp = buildCSP({ connectDomains: [] });
    expect(csp).toContain("connect-src 'none'");
  });
});
