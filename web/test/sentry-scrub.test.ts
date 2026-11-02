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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Breadcrumb, ErrorEvent } from "@sentry/react";
import * as Sentry from "@sentry/react";
import {
  beforeBreadcrumb,
  beforeSend,
  consumeLogoutOnce,
  consumeMcpTimeoutEvent,
  initSentry,
  isReportableLogout,
  MCP_TIMEOUT_EVENT_INTERVAL_MS,
  resetLogoutGuard,
  resetMcpTimeoutEventWindow,
} from "../src/sentry";

describe("beforeSend", () => {
  test("drops the query and fragment from the page URL and the transaction", () => {
    const event: ErrorEvent = {
      type: undefined,
      transaction: "/w/abc/app/crm?target=crm://contacts/c1",
      request: { url: "https://app.example/w/abc/app/crm?target=crm://contacts/c1&chat=conv_1#x" },
    };

    const out = beforeSend(event);
    expect(out.request?.url).toBe("https://app.example/w/abc/app/crm");
    expect(out.transaction).toBe("/w/abc/app/crm");
  });

  test("strips cookies and headers from the request", () => {
    const event: ErrorEvent = {
      type: undefined,
      request: {
        url: "https://app.example/x",
        cookies: { session: "secret" },
        headers: { authorization: "Bearer abc" },
      },
    };

    const out = beforeSend(event);
    expect(out.request?.cookies).toBeUndefined();
    expect(out.request?.headers).toBeUndefined();
  });

  test("reduces user to the opaque id, dropping email/username/ip", () => {
    const event: ErrorEvent = {
      type: undefined,
      user: {
        id: "user-123",
        email: "person@example.com",
        username: "person",
        ip_address: "1.2.3.4",
      },
    };

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
      data: { url: "https://app.example/w/ws_000c657279042abe?conversation=conv_secret&q=hi" },
    };
    const out = beforeBreadcrumb(crumb);
    expect(out?.data?.url).toBe("https://app.example/w/ws_000c657279042abe");
  });

  test("passes through a URL with no query string unchanged", () => {
    const crumb: Breadcrumb = { category: "xhr", data: { url: "https://app.example/v1/tools" } };
    const out = beforeBreadcrumb(crumb);
    expect(out?.data?.url).toBe("https://app.example/v1/tools");
  });
});

describe("logout guard (one event per incident)", () => {
  beforeEach(() => resetLogoutGuard());

  test("emits once across the concurrent 401s of a single logout", () => {
    // N concurrent 401s resolve one rejected refresh; captureLogout runs per
    // caller but must collapse to a single emit.
    expect(consumeLogoutOnce()).toBe(true);
    expect(consumeLogoutOnce()).toBe(false);
    expect(consumeLogoutOnce()).toBe(false);
  });

  test("re-auth re-arms the guard for a later logout", () => {
    expect(consumeLogoutOnce()).toBe(true);
    resetLogoutGuard(); // setSentryUser does this on a fresh session
    expect(consumeLogoutOnce()).toBe(true);
  });
});

describe("isReportableLogout (event vs. expected-end-of-session)", () => {
  test("suppresses refresh_rejected — the expected session-expiry signal", () => {
    // Fires on every returning user whose refresh token lapsed and on every
    // routine deploy of an env left open; breadcrumb-only, never an event.
    expect(isReportableLogout("refresh_rejected")).toBe(false);
  });

  test("reports retry_401 — a freshly minted token rejected on the very next call", () => {
    expect(isReportableLogout("retry_401")).toBe(true);
  });
});

describe("MCP timeout events (one per window, not one per request)", () => {
  beforeEach(() => resetMcpTimeoutEventWindow());

  test("the first -32001 gets an event, the rest of its window do not, the next window does", () => {
    expect(consumeMcpTimeoutEvent(1_000)).toBe(true);
    expect(consumeMcpTimeoutEvent(1_001)).toBe(false);
    expect(consumeMcpTimeoutEvent(1_000 + MCP_TIMEOUT_EVENT_INTERVAL_MS - 1)).toBe(false);
    expect(consumeMcpTimeoutEvent(1_000 + MCP_TIMEOUT_EVENT_INTERVAL_MS)).toBe(true);
  });
});

describe("beforeBreadcrumb: navigation", () => {
  test("drops the query and fragment from a navigation's from and to", () => {
    const crumb: Breadcrumb = {
      category: "navigation",
      data: { from: "/w/abc/app/crm?target=crm://contacts/c1", to: "/w/abc/?chat=conv_1#top" },
    };

    const out = beforeBreadcrumb(crumb);
    expect(out?.data?.from).toBe("/w/abc/app/crm");
    expect(out?.data?.to).toBe("/w/abc/");
  });
});

type InitOptions = NonNullable<Parameters<typeof Sentry.init>[0]>;
type TransactionEvent = Parameters<NonNullable<InitOptions["beforeSendTransaction"]>>[0];

describe("beforeSendTransaction", () => {
  afterEach(() => {
    window.__NB_CONFIG__ = undefined;
  });

  test("drops the query and a standalone fragment from the transaction and request URL", () => {
    // initSentry keeps the SDK it is given; the rest of this one is the real,
    // uninitialized SDK, so helpers called by later suites stay no-ops.
    let options: InitOptions | undefined;
    window.__NB_CONFIG__ = { sentry: { dsn: "https://key@sentry.example/1" } };
    initSentry({
      ...Sentry,
      init: (o) => {
        options = o;
        return undefined;
      },
    });

    const event: TransactionEvent = {
      type: "transaction",
      transaction: "/w/abc/?chat=conv_1",
      request: { url: "https://app.example/w/abc/#conv_1" },
    };
    const out = options?.beforeSendTransaction?.(event, {});
    expect(out).toEqual({
      type: "transaction",
      transaction: "/w/abc/",
      request: { url: "https://app.example/w/abc/" },
    });
  });
});
