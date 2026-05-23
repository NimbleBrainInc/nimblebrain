/**
 * Static-shape guard for the inline home-briefing script (issue #220).
 *
 * The host emits `ui/notifications/tool-result` (see
 * `web/src/bridge/bridge.ts::sendToolResult`) with the briefing payload
 * on `params.structuredContent`. The script previously listened for the
 * undefined method `synapse/tool-result` reading `params.result`, so the
 * inline path never rendered host-pushed data.
 *
 * Per the issue's preferred Option 2, the script subscribes via the
 * Synapse SDK's `app.on("tool-result", ...)` surface (typed event name
 * mapped from the JSON-RPC method by the SDK) and reads
 * `data.structuredContent`. These assertions pin the corrected wiring.
 */
import { describe, expect, it } from "bun:test";
import { HOME_BRIEFING_INLINE_SCRIPT } from "../../../src/tools/core-resources/scripts/home-briefing-inline.ts";

describe("home-briefing-inline tool-result wiring (#220)", () => {
  it("does not reference the undefined method 'synapse/tool-result'", () => {
    expect(HOME_BRIEFING_INLINE_SCRIPT).not.toContain("synapse/tool-result");
  });

  it("subscribes via the Synapse SDK's tool-result event", () => {
    // Matches `app.on("tool-result"`, with optional whitespace.
    expect(HOME_BRIEFING_INLINE_SCRIPT).toMatch(/\.on\(\s*["']tool-result["']/);
  });

  it("reads payload from structuredContent (the field the host sends)", () => {
    expect(HOME_BRIEFING_INLINE_SCRIPT).toContain("structuredContent");
    // Guard against the prior `params.result` mis-read regressing.
    expect(HOME_BRIEFING_INLINE_SCRIPT).not.toMatch(/params\.result\b/);
  });

  it("connects via Synapse.connect (not the read-only createSynapse path)", () => {
    // `Synapse.connect(...)` returns an `App` with `.on()`. `createSynapse`
    // does not expose tool-result events.
    expect(HOME_BRIEFING_INLINE_SCRIPT).toMatch(/Synapse\.connect\(/);
  });
});
