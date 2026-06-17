// ---------------------------------------------------------------------------
// Sentry PII scrubbing — the trust boundary in code.
//
// Sentry's *defaults* are the leak risk, not the events we build by hand. These
// tests pin that both channels are scrubbed before anything leaves the browser:
//   - beforeSend strips the event envelope (cookies, headers, email/username).
//   - beforeBreadcrumb drops console breadcrumbs and URL query strings (which
//     can carry workspace/conversation ids).
// Mirrors the server OTel rule: stamp only tenant_id/workspace_id/opaque user id.
// ---------------------------------------------------------------------------

import type { Breadcrumb, ErrorEvent } from "@sentry/react";
import { describe, expect, test } from "bun:test";
import { beforeBreadcrumb, beforeSend } from "../src/sentry";

describe("beforeSend", () => {
  test("strips cookies and headers from the request", () => {
    const event = {
      request: {
        url: "https://app.example/x",
        cookies: { session: "secret" },
        headers: { authorization: "Bearer abc" },
      },
    } as unknown as ErrorEvent;

    const out = beforeSend(event);
    expect(out.request?.cookies).toBeUndefined();
    expect(out.request?.headers).toBeUndefined();
  });

  test("reduces user to the opaque id, dropping email/username/ip", () => {
    const event = {
      user: {
        id: "user-123",
        email: "person@example.com",
        username: "person",
        ip_address: "1.2.3.4",
      },
    } as unknown as ErrorEvent;

    const out = beforeSend(event);
    expect(out.user).toEqual({ id: "user-123" });
  });
});

describe("beforeBreadcrumb", () => {
  test("drops console breadcrumbs entirely", () => {
    const crumb: Breadcrumb = { category: "console", message: "leaked prompt text" };
    expect(beforeBreadcrumb(crumb)).toBeNull();
  });

  test("strips query strings from fetch/xhr/navigation URLs", () => {
    const crumb: Breadcrumb = {
      category: "fetch",
      data: { url: "https://app.example/w/ws_abc?conversation=conv_secret&q=hi" },
    };
    const out = beforeBreadcrumb(crumb);
    expect(out?.data?.url).toBe("https://app.example/w/ws_abc");
  });

  test("passes through a URL with no query string unchanged", () => {
    const crumb: Breadcrumb = { category: "xhr", data: { url: "https://app.example/v1/tools" } };
    const out = beforeBreadcrumb(crumb);
    expect(out?.data?.url).toBe("https://app.example/v1/tools");
  });
});
