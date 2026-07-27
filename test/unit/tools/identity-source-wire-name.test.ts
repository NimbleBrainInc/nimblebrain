/**
 * Every identity-owned `McpSource` emits its MARKED name.
 *
 * A personal connector's registry key is bare (dispatch, policy records and
 * placements all depend on that) while its wire name carries the marker. Only
 * events use the wire name, and `deriveDataChangedTarget` reads it to decide
 * whether a `data.changed` broadcast would land on a WORKSPACE app of the same
 * name. A connector that emits bare is indistinguishable from that workspace
 * source, so the broadcast refetches an unrelated app on a private tool call.
 *
 * This is pinned as a SOURCE-LEVEL invariant, not per call site, because the
 * per-call-site version was missed twice: `startBundleSource` was marked and
 * `startIdentityAuth` — which hand-rolls its own construction — was not. The
 * second miss was invisible in normal testing, since the lazy path that does
 * mark is what runs after a pod restart.
 *
 * A seventh construction site added later must satisfy this test, not remember
 * a convention.
 */

import { describe, expect, test } from "bun:test";
import { deriveDataChangedTarget } from "../../../src/api/events.ts";
import {
  isPersonalConnectorName,
  personalConnectorWireName,
} from "../../../src/tools/identity-sources.ts";
import { McpSource } from "../../../src/tools/mcp-source.ts";

const remote = { type: "remote" as const, url: new URL("https://example.test/mcp") };
const sink = { emit: () => {} };
const emitted = (s: McpSource): string =>
  (s as unknown as { eventSourceName: string }).eventSourceName;

/** How every identity-owned construction site must build its source. */
const identityOwned = (serverName: string) =>
  new McpSource(
    serverName,
    remote as never,
    sink as never,
    undefined,
    personalConnectorWireName(serverName),
  );

describe("identity-owned sources", () => {
  test("emit a marked name while keeping a bare registry key", () => {
    const s = identityOwned("gmail");
    expect(isPersonalConnectorName(emitted(s))).toBe(true);
    expect(s.name).toBe("gmail");
  });

  test("produce no data.changed broadcast — the invariant that matters", () => {
    // Feed the emitter's own output to the consumer. Asserting a hand-written
    // marked event instead is what let the gap survive: the guard was correct
    // and unreachable, because nothing upstream produced a marked source.
    const s = identityOwned("gmail");
    expect(
      deriveDataChangedTarget({
        type: "tool.progress",
        data: { source: emitted(s), tool: "send" },
      } as never),
    ).toBeNull();
  });

  test("a workspace source of the same name still broadcasts", () => {
    const ws = new McpSource("gmail", remote as never, sink as never);
    expect(
      deriveDataChangedTarget({
        type: "tool.progress",
        data: { source: emitted(ws), tool: "send" },
      } as never),
    ).toEqual({ server: "gmail", tool: "send" });
  });

  test("an unmarked identity source WOULD collide — why this test exists", () => {
    // The bug shape, pinned so the consequence is legible rather than asserted.
    const wrong = new McpSource("gmail", remote as never, sink as never);
    expect(
      deriveDataChangedTarget({
        type: "tool.progress",
        data: { source: emitted(wrong), tool: "send" },
      } as never),
    ).toEqual({ server: "gmail", tool: "send" });
  });
});
