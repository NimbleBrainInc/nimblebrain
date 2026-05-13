/**
 * Regression coverage for the `${ENV_VAR}` substitution applied by
 * `createRemoteTransport`. The behaviour matters beyond just composio:
 * any remote-MCP catalog entry with a `${...}` placeholder in
 * `transport.auth.value` / `transport.auth.token` / `transport.headers`
 * relies on resolution happening at transport-build time so the
 * secret never lands in `workspace.json`.
 *
 * `createRemoteTransport` builds an SDK transport instance and there's
 * no clean way to inspect its outgoing headers without spinning the
 * SDK up. Instead, test the substitution helper directly — the
 * function is `export`ed so this isn't a private-API hack. The
 * transport-side wiring is integration-tested elsewhere via the
 * remote-bundle smoke flow.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveEnvTemplate } from "../../src/tools/remote-transport.ts";

describe("resolveEnvTemplate", () => {
  const SAVED = { TEST_VAR: process.env.TEST_VAR, COMPOSIO_API_KEY: process.env.COMPOSIO_API_KEY };

  beforeEach(() => {
    delete process.env.TEST_VAR;
    delete process.env.COMPOSIO_API_KEY;
  });

  afterEach(() => {
    if (SAVED.TEST_VAR === undefined) delete process.env.TEST_VAR;
    else process.env.TEST_VAR = SAVED.TEST_VAR;
    if (SAVED.COMPOSIO_API_KEY === undefined) delete process.env.COMPOSIO_API_KEY;
    else process.env.COMPOSIO_API_KEY = SAVED.COMPOSIO_API_KEY;
  });

  test("substitutes a single ${VAR} from process.env", () => {
    process.env.COMPOSIO_API_KEY = "real-key-value";
    expect(resolveEnvTemplate("${COMPOSIO_API_KEY}")).toBe("real-key-value");
  });

  test("substitutes a placeholder embedded in a larger string", () => {
    process.env.COMPOSIO_API_KEY = "key123";
    expect(resolveEnvTemplate("Bearer ${COMPOSIO_API_KEY}")).toBe("Bearer key123");
  });

  test("substitutes multiple placeholders in one string", () => {
    process.env.TEST_VAR = "alpha";
    process.env.COMPOSIO_API_KEY = "beta";
    expect(resolveEnvTemplate("${TEST_VAR}-${COMPOSIO_API_KEY}")).toBe("alpha-beta");
  });

  test("collapses unset variables to empty string (vendor surfaces the concrete error)", () => {
    // Comment in the source promises this — locking it in so a future
    // change to "throw on unset" doesn't break the
    // installed-but-unconfigured connector flow silently.
    delete process.env.COMPOSIO_API_KEY;
    expect(resolveEnvTemplate("${COMPOSIO_API_KEY}")).toBe("");
    expect(resolveEnvTemplate("prefix-${UNSET_VAR}-suffix")).toBe("prefix--suffix");
  });

  test("ignores lowercase / mixed-case placeholders (regex requires SHELL_CASE)", () => {
    process.env.test_var = "lower";
    process.env.MixedVar = "mixed";
    // These do NOT match the [A-Z_][A-Z0-9_]* shape, so they pass
    // through verbatim. Catalog authors must use UPPER_SNAKE_CASE.
    expect(resolveEnvTemplate("${test_var}")).toBe("${test_var}");
    expect(resolveEnvTemplate("${MixedVar}")).toBe("${MixedVar}");
  });

  test("leaves literal $ and {VAR} alone — only ${VAR} is the trigger", () => {
    // Don't surprise authors whose headers contain dollar signs or
    // brace expressions for legitimate reasons (cost markers, JSON
    // fragments, shell-style env interpolation in vendor docs).
    expect(resolveEnvTemplate("price: $5.00")).toBe("price: $5.00");
    expect(resolveEnvTemplate("{key}")).toBe("{key}");
    expect(resolveEnvTemplate("$NOTBRACED")).toBe("$NOTBRACED");
  });

  test("substitution applies to arbitrary header values, not just auth tokens", () => {
    // Documents the broad-scope intent. A connector that wants
    // `X-Vendor-Trace: ${NB_TENANT_ID}` resolved at transport build
    // time relies on the for-loop over `headers` doing every entry,
    // not just the `auth` branch. This locks that contract in.
    process.env.TEST_VAR = "tenant-hq";
    const header = resolveEnvTemplate("trace:${TEST_VAR}");
    expect(header).toBe("trace:tenant-hq");
  });
});
