/**
 * `McpSource` emits its WIRE name, not its registry key.
 *
 * These are the same string for a workspace connector and different for a personal
 * connector, whose wire form carries the reserved marker. The distinction only
 * matters on emitted events: a consumer reading `source` off a `tool.progress` or
 * `run.error` cannot otherwise tell a personal connector from a workspace source
 * installed under the same name.
 */

import { describe, expect, test } from "bun:test";
import { personalConnectorWireName } from "../../../src/tools/identity-sources.ts";
import { McpSource } from "../../../src/tools/mcp-source.ts";

/** Reach the private accessor the emit sites use. */
const emittedName = (s: McpSource): string =>
  (s as unknown as { eventSourceName: string }).eventSourceName;

const remote = { type: "remote" as const, url: new URL("https://example.test/mcp") };
const sink = { emit: () => {} };

describe("McpSource event source name", () => {
  test("a workspace connector emits its bare name", () => {
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
});
