import { describe, expect, test } from "bun:test";
import { userFacingStartError } from "../../src/connectors/runtime/lifecycle.ts";
import { OAuthFlowExpiredError } from "../../src/tools/oauth-flow-registry.ts";

/**
 * `lastError` is read by a person, not by an operator: `deriveConnectorStatus`
 * passes it through as `statusReason`, the connector card renders it verbatim,
 * and `manage_connectors` hands it to the agent. This pins the split — a typed
 * failure shows its sentence, everything else keeps the raw text that is still
 * the best diagnostic available for it. (#1245)
 */
describe("userFacingStartError", () => {
  test("an expired OAuth flow reads as a sentence, not as the registry's timer", () => {
    const err = new OAuthFlowExpiredError("abcd1234", 900_000);
    const shown = userFacingStartError(err, err.message);

    expect(shown).toBe(err.userMessage);
    // The exact string a user was shown in production before this fix.
    expect(shown).not.toContain("oauth-flow-registry");
    expect(shown).not.toContain("900000");
    expect(shown).not.toContain("abcd1234");
  });

  test("any other failure keeps its raw text", () => {
    const err = new Error("invalid_client");
    expect(userFacingStartError(err, "invalid_client")).toBe("invalid_client");
  });

  test("a non-Error rejection keeps the caller's stringified form", () => {
    expect(userFacingStartError("boom", "boom")).toBe("boom");
  });
});
