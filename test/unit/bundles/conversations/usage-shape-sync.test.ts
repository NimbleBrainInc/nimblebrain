import { describe, expect, it } from "bun:test";
import type { UsageShape } from "../../../../src/bundles/conversations/src/jsonl-reader.ts";
import type { TokenUsage } from "../../../../src/usage/types.ts";

/**
 * Compile-time drift guard.
 *
 * The conversations bundle is intentionally self-contained — it does
 * not import from the runtime — so it duplicates `TokenUsage` as a
 * local `UsageShape` interface. The two definitions are textually
 * identical today; this test makes sure they STAY structurally
 * compatible.
 *
 * If a future PR adds a field to `TokenUsage` but forgets to add it to
 * the bundle's `UsageShape` (or vice versa), one of these assignments
 * fails at compile time and CI blocks the merge.
 */
describe("UsageShape ↔ TokenUsage drift guard", () => {
  it("the two definitions are structurally compatible in both directions", () => {
    // Both directions: ensures neither has an exclusive required field
    // and neither has an exclusive optional field that's required on
    // the other side. Type-only — the runtime payloads here are placeholders.
    const fromTokenUsage: UsageShape = {} as TokenUsage;
    const fromUsageShape: TokenUsage = {} as UsageShape;
    expect(fromTokenUsage).toBeDefined();
    expect(fromUsageShape).toBeDefined();
  });
});
