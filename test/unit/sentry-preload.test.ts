import type { Breadcrumb, ErrorEvent } from "@sentry/bun";
import { describe, expect, it } from "bun:test";
import {
  resolveSentryConfig,
  scrubBreadcrumb,
  scrubEvent,
  sentryEnabled,
} from "../../instrument/sentry-config.ts";

describe("sentryEnabled", () => {
  it("is the explicit switch — true only when NB_SENTRY_ENABLED is 'true'", () => {
    expect(sentryEnabled({ NB_SENTRY_ENABLED: "true" })).toBe(true);
    expect(sentryEnabled({ NB_SENTRY_ENABLED: "TRUE" })).toBe(true);
    expect(sentryEnabled({ NB_SENTRY_ENABLED: "  true  " })).toBe(true);
  });

  it("is off when absent (OSS/dev/test default), false, or anything non-'true'", () => {
    expect(sentryEnabled({})).toBe(false);
    expect(sentryEnabled({ NB_SENTRY_ENABLED: "false" })).toBe(false);
    expect(sentryEnabled({ NB_SENTRY_ENABLED: "1" })).toBe(false);
    expect(sentryEnabled({ NB_SENTRY_ENABLED: "" })).toBe(false);
  });

  it("is NOT inferred from DSN presence — a DSN alone never enables", () => {
    expect(sentryEnabled({ NB_SENTRY_DSN: "https://k@o1.ingest.us.sentry.io/2" })).toBe(false);
  });
});

describe("resolveSentryConfig", () => {
  it("returns null when NB_SENTRY_DSN is absent, blank, or whitespace", () => {
    expect(resolveSentryConfig({})).toBeNull();
    expect(resolveSentryConfig({ NB_SENTRY_DSN: "" })).toBeNull();
    expect(resolveSentryConfig({ NB_SENTRY_DSN: "   " })).toBeNull();
  });

  it("resolves dsn and environment when configured", () => {
    const cfg = resolveSentryConfig({
      NB_SENTRY_DSN: "https://abc@o1.ingest.us.sentry.io/2",
      NB_SENTRY_ENV: "production",
      NB_VERSION: "1.2.3",
    });
    expect(cfg).toEqual({
      dsn: "https://abc@o1.ingest.us.sentry.io/2",
      environment: "production",
      release: "1.2.3",
      tracesSampleRate: 0,
    });
  });

  it("derives release from NB_VERSION, then NB_BUILD_SHA", () => {
    expect(resolveSentryConfig({ NB_SENTRY_DSN: "d", NB_VERSION: "v9" })?.release).toBe("v9");
    expect(resolveSentryConfig({ NB_SENTRY_DSN: "d", NB_BUILD_SHA: "deadbee" })?.release).toBe(
      "deadbee",
    );
    // NB_VERSION wins over NB_BUILD_SHA when both are present.
    expect(
      resolveSentryConfig({ NB_SENTRY_DSN: "d", NB_VERSION: "v9", NB_BUILD_SHA: "deadbee" })
        ?.release,
    ).toBe("v9");
  });

  it("defaults tracesSampleRate to 0 (errors only) and rejects invalid/negative input", () => {
    expect(resolveSentryConfig({ NB_SENTRY_DSN: "d" })?.tracesSampleRate).toBe(0);
    expect(
      resolveSentryConfig({ NB_SENTRY_DSN: "d", NB_SENTRY_TRACES_SAMPLE_RATE: "nope" })
        ?.tracesSampleRate,
    ).toBe(0);
    expect(
      resolveSentryConfig({ NB_SENTRY_DSN: "d", NB_SENTRY_TRACES_SAMPLE_RATE: "-1" })
        ?.tracesSampleRate,
    ).toBe(0);
    expect(
      resolveSentryConfig({ NB_SENTRY_DSN: "d", NB_SENTRY_TRACES_SAMPLE_RATE: "0.1" })
        ?.tracesSampleRate,
    ).toBe(0.1);
    // Above the documented 0–1 contract falls back to 0 (Sentry treats >1 as
    // always-sample; reject rather than silently enable full tracing).
    expect(
      resolveSentryConfig({ NB_SENTRY_DSN: "d", NB_SENTRY_TRACES_SAMPLE_RATE: "5" })
        ?.tracesSampleRate,
    ).toBe(0);
    expect(
      resolveSentryConfig({ NB_SENTRY_DSN: "d", NB_SENTRY_TRACES_SAMPLE_RATE: "1" })
        ?.tracesSampleRate,
    ).toBe(1);
  });
});

describe("scrubBreadcrumb", () => {
  it("drops console-category breadcrumbs (dependency logs can carry prompts/PII)", () => {
    const crumb = { category: "console", message: "prompt: secret" } as Breadcrumb;
    expect(scrubBreadcrumb(crumb)).toBeNull();
  });

  it("strips query strings from breadcrumb URLs, keeping the path", () => {
    const crumb = {
      category: "http",
      data: { url: "https://api.anthropic.com/v1/messages?token=sk-abc&id=ws_1" },
    } as unknown as Breadcrumb;
    expect(scrubBreadcrumb(crumb)?.data?.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("keeps non-console crumbs without a URL untouched", () => {
    const crumb = { category: "navigation", data: { from: "/a", to: "/b" } } as unknown as Breadcrumb;
    expect(scrubBreadcrumb(crumb)).toEqual(crumb);
  });
});

describe("scrubEvent", () => {
  it("strips request headers, cookies, body, and query string", () => {
    const event = {
      request: {
        url: "https://x/y",
        cookies: { session: "secret" },
        headers: { authorization: "Bearer t" },
        data: { prompt: "private" },
        query_string: "wsId=ws_123",
      },
    } as unknown as ErrorEvent;

    const out = scrubEvent(event);

    expect(out.request?.cookies).toBeUndefined();
    expect(out.request?.headers).toBeUndefined();
    expect(out.request?.data).toBeUndefined();
    expect(out.request?.query_string).toBeUndefined();
    // Non-sensitive fields are left intact.
    expect(out.request?.url).toBe("https://x/y");
  });

  it("strips a query string embedded in request.url (symmetric with breadcrumbs)", () => {
    const event = {
      request: { url: "https://api/v1/x?token=sk-abc&id=ws_1" },
    } as unknown as ErrorEvent;
    expect(scrubEvent(event).request?.url).toBe("https://api/v1/x");
  });

  it("reduces user to the opaque id, dropping email/username/ip", () => {
    const event = {
      user: { id: "u_1", email: "a@b.co", username: "alice", ip_address: "1.2.3.4" },
    } as unknown as ErrorEvent;

    expect(scrubEvent(event).user).toEqual({ id: "u_1" });
  });

  it("leaves an empty user object when there is no id", () => {
    const event = { user: { email: "a@b.co" } } as unknown as ErrorEvent;
    expect(scrubEvent(event).user).toEqual({});
  });
});
