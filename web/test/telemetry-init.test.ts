import { describe, expect, test } from "bun:test";
import { INIT_OPTIONS } from "../src/telemetry";

describe("PostHog init options", () => {
  test("pin every automatic capture off, so a project setting cannot turn one on", () => {
    for (const key of [
      "autocapture",
      "capture_pageview",
      "capture_pageleave",
      "capture_heatmaps",
      "capture_performance",
      "capture_dead_clicks",
      "capture_exceptions",
    ] as const) {
      expect(INIT_OPTIONS[key]).toBe(false);
    }
    for (const key of [
      "disable_session_recording",
      "disable_surveys",
      "disable_product_tours",
      "disable_conversations",
      "disable_web_experiments",
      "disable_scroll_properties",
      "advanced_disable_flags",
    ] as const) {
      expect(INIT_OPTIONS[key]).toBe(true);
    }
    expect(INIT_OPTIONS.ip).toBe(false);
    expect(INIT_OPTIONS.persistence).toBe("memory");
  });
});
