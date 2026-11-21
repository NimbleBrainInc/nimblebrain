import { beforeAll, describe, expect, mock, test } from "bun:test";

// The calls the shell makes on posthog-js, recorded in order.
const calls: Array<[string, ...unknown[]]> = [];
const record =
  (name: string) =>
  (...args: unknown[]) => {
    calls.push([name, ...args]);
  };

mock.module("posthog-js", () => ({
  default: {
    init: record("init"),
    register: record("register"),
    identify: record("identify"),
    group: record("group"),
    reset: record("reset"),
    capture: record("capture"),
  },
}));

type TelemetryModule = typeof import("../src/telemetry");
let telemetry: TelemetryModule;

beforeAll(async () => {
  // The key is read when the module loads, so set it first.
  window.__NB_CONFIG__ = { posthog: { key: "phc_test", enabled: "true" } };
  telemetry = await import("../src/telemetry");
});

describe("identified telemetry in the shell", () => {
  test("names the person, joins the tenant and the focused workspace, and forgets them at sign-out", () => {
    // The workspace is focused before workspace_info answers.
    telemetry.setTelemetryWorkspace("ws_1");
    telemetry.initTelemetry("install-1", {
      userId: "usr_1",
      email: "a@example.com",
      name: "Ada",
      tenantId: "tenant-a",
    });
    telemetry.setTelemetryWorkspace("ws_2");
    telemetry.resetTelemetry();
    // After sign-out, a workspace change names no group.
    telemetry.setTelemetryWorkspace("ws_3");

    expect(calls).toEqual([
      ["init", "phc_test", telemetry.INIT_OPTIONS],
      ["register", { installId: "install-1" }],
      ["identify", "usr_1", { email: "a@example.com", name: "Ada" }],
      ["group", "tenant", "tenant-a"],
      ["group", "workspace", "ws_1"],
      ["group", "workspace", "ws_2"],
      ["reset"],
    ]);
  });

  test("stays anonymous without a person", () => {
    calls.length = 0;
    telemetry.initTelemetry("install-1");
    telemetry.setTelemetryWorkspace("ws_4");

    expect(calls).toEqual([["register", { installId: "install-1" }]]);
  });
});
