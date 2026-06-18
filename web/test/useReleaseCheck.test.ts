// ---------------------------------------------------------------------------
// parseReleaseFromConfigJs — extracts `release` from the /config.js body Caddy
// serves. The hook compares this against the tab's boot release to decide
// whether a newer web build is deployed; this pins the parse contract.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { parseReleaseFromConfigJs } from "../src/hooks/useReleaseCheck";

// The exact shape Caddy emits (web/Caddyfile), with values rendered as strings.
const configJs = (release: string) =>
  `window.__NB_CONFIG__ = {"tenantId":"hq","environment":"production","release":"${release}","sentry":{"dsn":"https://x@y.ingest.us.sentry.io/1","enabled":"true","tracesSampleRate":"0"},"posthog":{"key":"","enabled":"false"}};`;

describe("parseReleaseFromConfigJs", () => {
  test("extracts the release from a real /config.js body", () => {
    expect(parseReleaseFromConfigJs(configJs("97bde4c"))).toBe("97bde4c");
  });

  test("returns the new release after a deploy (different tag)", () => {
    expect(parseReleaseFromConfigJs(configJs("abc1234"))).toBe("abc1234");
  });

  test("treats an empty release as undefined (unconfigured / dev)", () => {
    expect(parseReleaseFromConfigJs(configJs(""))).toBeUndefined();
  });

  test("returns undefined when release key is absent", () => {
    expect(parseReleaseFromConfigJs(`window.__NB_CONFIG__ = {"tenantId":"hq"};`)).toBeUndefined();
  });

  test("returns undefined on a non-JSON / error body (no braces)", () => {
    expect(parseReleaseFromConfigJs("Internal Server Error")).toBeUndefined();
  });

  test("returns undefined on a malformed object", () => {
    expect(parseReleaseFromConfigJs(`window.__NB_CONFIG__ = {release: oops};`)).toBeUndefined();
  });
});
