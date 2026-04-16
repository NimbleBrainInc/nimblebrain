import { describe, test, expect } from "bun:test";
import { SseEventManager } from "../../../src/api/events.ts";

describe("SseEventManager event buffer", () => {
	test("broadcasting an event adds it to the buffer", () => {
		const mgr = new SseEventManager();
		mgr.broadcast("bundle.installed", { name: "test-bundle" });

		const events = mgr.getEventsSince("1970-01-01T00:00:00.000Z");
		expect(events).toHaveLength(1);
		expect(events[0].event).toBe("bundle.installed");
		expect(events[0].data).toEqual({ name: "test-bundle" });
		expect(events[0].timestamp).toBeTruthy();
	});

	test("buffer respects the 500-entry cap (oldest dropped first)", () => {
		const mgr = new SseEventManager();

		for (let i = 0; i < 510; i++) {
			mgr.broadcast("tick", { i });
		}

		const all = mgr.getEventsSince("1970-01-01T00:00:00.000Z");
		expect(all).toHaveLength(500);
		// Oldest retained should be i=10 (0-9 were shifted out)
		expect(all[0].data).toEqual({ i: 10 });
		expect(all[499].data).toEqual({ i: 509 });
	});

	test("getEventsSince() filters correctly", () => {
		const mgr = new SseEventManager();

		// Broadcast two events with a gap
		mgr.broadcast("first", { n: 1 });
		const midpoint = new Date().toISOString();
		// Ensure the second event has a later timestamp
		mgr.broadcast("second", { n: 2 });

		const since = mgr.getEventsSince(midpoint);
		// At minimum the second event should be included; the first may or
		// may not depending on clock resolution, so just check the last one.
		const lastEvent = since[since.length - 1];
		expect(lastEvent.event).toBe("second");
	});

	test("getEventsSince() with a future timestamp returns empty", () => {
		const mgr = new SseEventManager();
		mgr.broadcast("past", { x: 1 });

		const future = "2099-12-31T23:59:59.999Z";
		expect(mgr.getEventsSince(future)).toEqual([]);
	});

	test("getEventsSince() with epoch timestamp returns all", () => {
		const mgr = new SseEventManager();
		mgr.broadcast("a", { v: 1 });
		mgr.broadcast("b", { v: 2 });
		mgr.broadcast("c", { v: 3 });

		const all = mgr.getEventsSince("1970-01-01T00:00:00.000Z");
		expect(all).toHaveLength(3);
		expect(all.map((e) => e.event)).toEqual(["a", "b", "c"]);
	});

	test("onEvent() local listeners are called on broadcast", () => {
		const mgr = new SseEventManager();
		const received: Array<{ event: string; data: Record<string, unknown> }> =
			[];

		mgr.onEvent((event, data) => {
			received.push({ event, data });
		});

		mgr.broadcast("data.changed", { source: "test" });
		mgr.broadcast("bundle.crashed", { name: "bad" });

		expect(received).toHaveLength(2);
		expect(received[0]).toEqual({
			event: "data.changed",
			data: { source: "test" },
		});
		expect(received[1]).toEqual({
			event: "bundle.crashed",
			data: { name: "bad" },
		});
	});

	test("heartbeat events are also buffered", () => {
		// Use a very short heartbeat interval so it fires quickly
		const mgr = new SseEventManager(50);
		mgr.start();

		return new Promise<void>((resolve) => {
			setTimeout(() => {
				mgr.stop();
				const events = mgr.getEventsSince("1970-01-01T00:00:00.000Z");
				const heartbeats = events.filter((e) => e.event === "heartbeat");
				expect(heartbeats.length).toBeGreaterThanOrEqual(1);
				expect(heartbeats[0].data).toHaveProperty("timestamp");
				resolve();
			}, 150);
		});
	});
});
