import type { ErrorEvent } from "@sentry/bun";
import { describe, expect, it } from "bun:test";
import { resolveSentryConfig, scrubEvent } from "../../instrument/sentry-config.ts";

describe("resolveSentryConfig", () => {
  it("is a no-op (null) when SENTRY_DSN is absent — the OSS/dev/test default", () => {
    expect(resolveSentryConfig({})).toBeNull();
  });

  it("is a no-op when SENTRY_DSN is blank or whitespace", () => {
    expect(resolveSentryConfig({ SENTRY_DSN: "" })).toBeNull();
    expect(resolveSentryConfig({ SENTRY_DSN: "   " })).toBeNull();
  });

  it("resolves dsn, environment, and release when configured", () => {
    const cfg = resolveSentryConfig({
      SENTRY_DSN: "https://abc@o1.ingest.us.sentry.io/2",
      SENTRY_ENVIRONMENT: "production",
      SENTRY_RELEASE: "1.2.3",
    });
    expect(cfg).toEqual({
      dsn: "https://abc@o1.ingest.us.sentry.io/2",
      environment: "production",
      release: "1.2.3",
      tracesSampleRate: 0,
    });
  });

  it("falls back release to NB_VERSION then NB_BUILD_SHA", () => {
    expect(resolveSentryConfig({ SENTRY_DSN: "d", NB_VERSION: "v9" })?.release).toBe("v9");
    expect(resolveSentryConfig({ SENTRY_DSN: "d", NB_BUILD_SHA: "deadbee" })?.release).toBe(
      "deadbee",
    );
    // SENTRY_RELEASE wins over the build-identity fallbacks.
    expect(
      resolveSentryConfig({ SENTRY_DSN: "d", SENTRY_RELEASE: "r", NB_VERSION: "v9" })?.release,
    ).toBe("r");
  });

  it("defaults tracesSampleRate to 0 (errors only) and rejects invalid/negative input", () => {
    expect(resolveSentryConfig({ SENTRY_DSN: "d" })?.tracesSampleRate).toBe(0);
    expect(
      resolveSentryConfig({ SENTRY_DSN: "d", SENTRY_TRACES_SAMPLE_RATE: "nope" })?.tracesSampleRate,
    ).toBe(0);
    expect(
      resolveSentryConfig({ SENTRY_DSN: "d", SENTRY_TRACES_SAMPLE_RATE: "-1" })?.tracesSampleRate,
    ).toBe(0);
    expect(
      resolveSentryConfig({ SENTRY_DSN: "d", SENTRY_TRACES_SAMPLE_RATE: "0.1" })?.tracesSampleRate,
    ).toBe(0.1);
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
