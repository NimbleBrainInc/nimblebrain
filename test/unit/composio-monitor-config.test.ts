import { describe, expect, it } from "bun:test";
import { composioMonitorEnabled } from "../../src/connectors/providers/composio/monitor-config.ts";

describe("composioMonitorEnabled", () => {
  it("off when Composio isn't configured, regardless of the switch", () => {
    expect(composioMonitorEnabled(false, {})).toBe(false);
    expect(composioMonitorEnabled(false, { COMPOSIO_MONITOR_ENABLED: "true" })).toBe(false);
  });

  it("on by default when configured and the switch is unset", () => {
    expect(composioMonitorEnabled(true, {})).toBe(true);
  });

  it("off only on an explicit false (case/whitespace-insensitive)", () => {
    expect(composioMonitorEnabled(true, { COMPOSIO_MONITOR_ENABLED: "false" })).toBe(false);
    expect(composioMonitorEnabled(true, { COMPOSIO_MONITOR_ENABLED: "FALSE" })).toBe(false);
    expect(composioMonitorEnabled(true, { COMPOSIO_MONITOR_ENABLED: "  false " })).toBe(false);
  });

  it("a non-false value keeps it on (malformed input fails safe to enabled)", () => {
    expect(composioMonitorEnabled(true, { COMPOSIO_MONITOR_ENABLED: "true" })).toBe(true);
    expect(composioMonitorEnabled(true, { COMPOSIO_MONITOR_ENABLED: "yes" })).toBe(true);
    expect(composioMonitorEnabled(true, { COMPOSIO_MONITOR_ENABLED: "" })).toBe(true);
  });
});
