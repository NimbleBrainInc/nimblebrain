import { describe, expect, test } from "bun:test";
import { SseEventManager } from "../../../src/api/events.ts";

describe("SseEventManager local listeners", () => {
  test("onEvent() local listeners are called on broadcast", () => {
    const mgr = new SseEventManager();
    const received: Array<{ event: string; data: Record<string, unknown> }> = [];

    mgr.onEvent((event, data) => {
      received.push({ event, data });
    });

    mgr.broadcast("config.changed", { source: "test" });
    mgr.broadcast("connector.installed", { name: "bad" });

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({
      event: "config.changed",
      data: { source: "test" },
    });
    expect(received[1]).toEqual({
      event: "connector.installed",
      data: { name: "bad" },
    });
  });
});
