import { describe, expect, it } from "bun:test";
import {
  composioMonitorEnabled,
  revalidatorIntervalMsFromEnv,
} from "../../src/composio/monitor-config.ts";

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

describe("revalidatorIntervalMsFromEnv", () => {
  it("undefined (use default) when unset", () => {
    expect(revalidatorIntervalMsFromEnv({})).toBeUndefined();
  });

  it("converts a positive seconds value to ms", () => {
    expect(revalidatorIntervalMsFromEnv({ COMPOSIO_MONITOR_INTERVAL_SECONDS: "300" })).toBe(300_000);
    expect(revalidatorIntervalMsFromEnv({ COMPOSIO_MONITOR_INTERVAL_SECONDS: "120" })).toBe(120_000);
  });

  it("falls back to default on non-positive / unparseable values", () => {
    expect(revalidatorIntervalMsFromEnv({ COMPOSIO_MONITOR_INTERVAL_SECONDS: "0" })).toBeUndefined();
    expect(revalidatorIntervalMsFromEnv({ COMPOSIO_MONITOR_INTERVAL_SECONDS: "-5" })).toBeUndefined();
    expect(revalidatorIntervalMsFromEnv({ COMPOSIO_MONITOR_INTERVAL_SECONDS: "abc" })).toBeUndefined();
    expect(revalidatorIntervalMsFromEnv({ COMPOSIO_MONITOR_INTERVAL_SECONDS: "" })).toBeUndefined();
  });
});
