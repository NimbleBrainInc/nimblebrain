// ---------------------------------------------------------------------------
// getConfig — the runtime config seam every client feature reads through.
//
// Caddy injects window.__NB_CONFIG__ with all values as JSON strings; getConfig
// coerces booleans/numbers so a malformed operator value degrades that one
// feature to "off" instead of breaking the whole config. These tests pin the
// coercion and precedence so the seam can't silently regress.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getConfig } from "../src/config";

// Mutate only window.__NB_CONFIG__ — never the shared (happy-dom) window object,
// or we'd tear down the DOM for every test that runs after this file.
type Win = { __NB_CONFIG__?: unknown } | undefined;
const getWin = (): Win => (globalThis as unknown as { window?: Win }).window as Win;
const ensureWin = (): { __NB_CONFIG__?: unknown } => {
  const g = globalThis as unknown as { window?: { __NB_CONFIG__?: unknown } };
  g.window ??= {};
  return g.window;
};

function setConfig(c: unknown): void {
  ensureWin().__NB_CONFIG__ = c;
}

beforeEach(() => {
  const w = getWin();
  if (w) w.__NB_CONFIG__ = undefined;
});

afterEach(() => {
  const w = getWin();
  if (w) w.__NB_CONFIG__ = undefined;
});

describe("getConfig", () => {
  test("uses injected values and coerces string flags/numbers", () => {
    setConfig({
      tenantId: "tenant-a",
      sentry: { dsn: "https://k@o1.ingest.sentry.io/1", enabled: "true", tracesSampleRate: "0.25" },
      posthog: { key: "phc_x", enabled: "true" },
    });
    const c = getConfig();
    expect(c.tenantId).toBe("tenant-a");
    expect(c.sentry?.dsn).toBe("https://k@o1.ingest.sentry.io/1");
    expect(c.sentry?.enabled).toBe(true);
    expect(c.sentry?.tracesSampleRate).toBe(0.25);
    expect(c.posthog?.enabled).toBe(true);
  });

  test("a malformed flag/number degrades to off/0, not a crash", () => {
    setConfig({ sentry: { dsn: "d", enabled: "yes", tracesSampleRate: "" } });
    const c = getConfig();
    expect(c.sentry?.enabled).toBe(false); // anything but "true" => off
    expect(c.sentry?.tracesSampleRate).toBe(0); // empty/garbage => 0
  });

  test("absent enable flag stays undefined (dev: on iff key present)", () => {
    setConfig({ sentry: { dsn: "d" } });
    expect(getConfig().sentry?.enabled).toBeUndefined();
  });

  test("empty config leaves every feature unconfigured", () => {
    setConfig({});
    const c = getConfig();
    expect(c.sentry?.dsn).toBeUndefined();
    expect(c.sentry?.enabled).toBeUndefined();
    expect(c.posthog?.key).toBeUndefined();
    expect(c.sentry?.tracesSampleRate).toBe(0);
  });
});
