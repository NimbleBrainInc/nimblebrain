import { describe, expect, test } from "vitest";
import { installCompletesWithoutSignIn } from "./connector-auth-flow.ts";

describe("installCompletesWithoutSignIn", () => {
  test("brokered and platform-minted kinds skip the sign-in flow", () => {
    // Their credential is held by the broker/platform and the install
    // eager-starts the source `running`. Launching initiateMcpOAuth for one
    // throws "already connected" → 500 → a red error on a SUCCESSFUL install.
    expect(installCompletesWithoutSignIn("smithery")).toBe(true);
    expect(installCompletesWithoutSignIn("provider")).toBe(true);
  });

  test("user-authenticated kinds still run their flow", () => {
    expect(installCompletesWithoutSignIn("dcr")).toBe(false);
    expect(installCompletesWithoutSignIn("static")).toBe(false);
    // Composio routes through its OWN initiate endpoint, not this predicate.
    expect(installCompletesWithoutSignIn("composio")).toBe(false);
  });
});
