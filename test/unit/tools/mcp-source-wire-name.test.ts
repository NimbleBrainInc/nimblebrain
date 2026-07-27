/**
 * `McpSource` emits its WIRE name, not its registry key.
 *
 * These are the same string for a workspace bundle and different for a personal
 * connector, whose wire form carries the reserved marker. The distinction only
 * matters on emitted events: a consumer reading `source` off a `tool.progress`
 * decides from it whether to broadcast `data.changed`, and a connector emitting
 * its bare name is indistinguishable from a workspace source installed under the
 * same name — so the broadcast lands on an unrelated app's iframe.
 *
 * Pinned at the emitter because that is where the earlier gap was: the guard in
 * `deriveDataChangedTarget` was correct, and unreachable on this path, because
 * nothing upstream ever produced a marked `source`. A test asserting the guard
 * against a hand-written marked event passed while the real path stayed broken.
 */

import { describe, expect, test } from "bun:test";
import { deriveDataChangedTarget } from "../../../src/api/events.ts";
import { personalConnectorWireName } from "../../../src/tools/identity-sources.ts";
import { McpSource } from "../../../src/tools/mcp-source.ts";

/** Reach the private accessor the emit sites use. */
const emittedName = (s: McpSource): string =>
  (s as unknown as { eventSourceName: string }).eventSourceName;

const remote = { type: "remote" as const, url: new URL("https://example.test/mcp") };
const sink = { emit: () => {} };

describe("McpSource event source name", () => {
  test("a workspace bundle emits its bare name", () => {
    const s = new McpSource("gmail", remote as never, sink as never);
    expect(emittedName(s)).toBe("gmail");
  });

  test("a personal connector emits the MARKED name", () => {
    const s = new McpSource(
      "gmail",
      remote as never,
      sink as never,
      undefined,
      personalConnectorWireName("gmail"),
    );
    expect(emittedName(s)).toBe("my_gmail");
  });

  test("its registry key stays bare — dispatch and policy lookups depend on it", () => {
    const s = new McpSource(
      "gmail",
      remote as never,
      sink as never,
      undefined,
      personalConnectorWireName("gmail"),
    );
    expect(s.name).toBe("gmail");
  });

  test("end to end: what the connector emits produces no data.changed broadcast", () => {
    // The whole point. Feed the emitter's own output to the consumer.
    const s = new McpSource(
      "gmail",
      remote as never,
      sink as never,
      undefined,
      personalConnectorWireName("gmail"),
    );
    const event = {
      type: "tool.progress",
      data: { source: emittedName(s), tool: "send" },
    };
    expect(deriveDataChangedTarget(event as never)).toBeNull();
  });

  test("and a workspace source of that name still broadcasts", () => {
    const s = new McpSource("gmail", remote as never, sink as never);
    const event = { type: "tool.progress", data: { source: emittedName(s), tool: "send" } };
    expect(deriveDataChangedTarget(event as never)).toEqual({ server: "gmail", tool: "send" });
  });
});
