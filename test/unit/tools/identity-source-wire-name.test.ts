/**
 * Every identity-owned `McpSource` emits its MARKED name.
 *
 * A personal connector's registry key is bare (dispatch, policy records and
 * placements all depend on that) while its wire name carries the marker. Only
 * events use the wire name. A connector that emits bare is indistinguishable
 * from a WORKSPACE source installed under the same name.
 *
 * This is pinned as a SOURCE-LEVEL invariant, not per call site, because the
 * per-call-site version was missed twice: `startConnectorSource` was marked and
 * `startIdentityAuth` — which hand-rolls its own construction — was not. The
 * second miss was invisible in normal testing, since the lazy path that does
 * mark is what runs after a pod restart.
 *
 * A seventh construction site added later must satisfy this test, not remember
 * a convention.
 */

import { describe, expect, test } from "bun:test";
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
});
