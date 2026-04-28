import { describe, expect, it } from "bun:test";
import { LoginRateLimiter, RequestRateLimiter } from "../../src/api/rate-limiter.ts";

describe("LoginRateLimiter", () => {
	it("allows the first 10 checks from the same IP", () => {
		const limiter = new LoginRateLimiter(10, 60_000);
		const ip = "192.0.2.1";
		for (let i = 0; i < 10; i++) {
			expect(limiter.check(ip)).toBe(true);
			limiter.record(ip);
		}
	});

	it("rejects the 11th check", () => {
		const limiter = new LoginRateLimiter(10, 60_000);
		const ip = "192.0.2.1";
		for (let i = 0; i < 10; i++) {
			limiter.record(ip);
		}
		expect(limiter.check(ip)).toBe(false);
	});

	it("resets after clear()", () => {
		const limiter = new LoginRateLimiter(10, 60_000);
		const ip = "192.0.2.1";
		for (let i = 0; i < 10; i++) {
			limiter.record(ip);
		}
		expect(limiter.check(ip)).toBe(false);
		limiter.clear(ip);
		expect(limiter.check(ip)).toBe(true);
	});

	it("tracks different IPs independently", () => {
		const limiter = new LoginRateLimiter(10, 60_000);
		for (let i = 0; i < 10; i++) {
			limiter.record("192.0.2.1");
		}
		expect(limiter.check("192.0.2.1")).toBe(false);
		expect(limiter.check("192.0.2.2")).toBe(true);
	});

	it("global limit rejects after total attempts across all keys", () => {
		const limiter = new LoginRateLimiter(10, 60_000, 5);
		for (let i = 0; i < 5; i++) {
			expect(limiter.checkGlobal()).toBe(true);
			limiter.recordGlobal();
		}
		expect(limiter.checkGlobal()).toBe(false);
	});

	it("global limit resets after window expires", () => {
		// 50ms window: long enough that the recordGlobal() loop below finishes
		// inside one window (a 1ms window was racy under load — the loop
		// itself could span >1ms and reset the counter mid-burst, dropping
		// the post-loop count below the limit), short enough that the
		// busy-wait afterwards is still cheap.
		const windowMs = 50;
		const limiter = new LoginRateLimiter(10, windowMs, 5);
		for (let i = 0; i < 5; i++) {
			limiter.recordGlobal();
		}
		expect(limiter.checkGlobal()).toBe(false);

		// Wait comfortably past the window.
		const start = Date.now();
		while (Date.now() - start < windowMs * 2) {
			// busy-wait
		}

		expect(limiter.checkGlobal()).toBe(true);
	});

	it("removes expired windows on cleanup", () => {
		// 50ms window — see above; same race applies to single-record entries
		// under load. Window must be small enough that the busy-wait stays
		// cheap, large enough that a single record() reliably lands inside
		// it.
		const windowMs = 50;
		const limiter = new LoginRateLimiter(10, windowMs);
		const ip = "192.0.2.1";
		limiter.record(ip);

		const start = Date.now();
		while (Date.now() - start < windowMs * 2) {
			// busy-wait
		}

		limiter.cleanup();
		// After cleanup, the entry is removed — check returns true (no entry = allowed)
		expect(limiter.check(ip)).toBe(true);
	});
});

describe("RequestRateLimiter", () => {
	it("allows requests up to the limit", () => {
		const limiter = new RequestRateLimiter(5, 60_000);
		for (let i = 0; i < 5; i++) {
			expect(limiter.consume("user-1")).toBe(true);
		}
	});

	it("rejects requests over the limit", () => {
		const limiter = new RequestRateLimiter(3, 60_000);
		for (let i = 0; i < 3; i++) {
			expect(limiter.consume("user-1")).toBe(true);
		}
		expect(limiter.consume("user-1")).toBe(false);
	});

	it("tracks different keys independently", () => {
		const limiter = new RequestRateLimiter(2, 60_000);
		expect(limiter.consume("user-1")).toBe(true);
		expect(limiter.consume("user-1")).toBe(true);
		expect(limiter.consume("user-1")).toBe(false);
		// Different user still has their full budget
		expect(limiter.consume("user-2")).toBe(true);
		expect(limiter.consume("user-2")).toBe(true);
		expect(limiter.consume("user-2")).toBe(false);
	});

	it("resets after window expires", () => {
		// 50ms window — the consume() pair below must land inside the same
		// window. A 1ms window was racy under load (loop spanned >1ms,
		// silently resetting the count between calls).
		const windowMs = 50;
		const limiter = new RequestRateLimiter(2, windowMs);
		expect(limiter.consume("user-1")).toBe(true);
		expect(limiter.consume("user-1")).toBe(true);
		expect(limiter.consume("user-1")).toBe(false);

		const start = Date.now();
		while (Date.now() - start < windowMs * 2) {
			// busy-wait
		}

		expect(limiter.consume("user-1")).toBe(true);
	});

	it("exposes windowSeconds", () => {
		expect(new RequestRateLimiter(10, 60_000).windowSeconds).toBe(60);
		expect(new RequestRateLimiter(10, 30_000).windowSeconds).toBe(30);
	});

	it("removes expired entries on cleanup", () => {
		const limiter = new RequestRateLimiter(2, 1);
		limiter.consume("user-1");
		limiter.consume("user-1");
		expect(limiter.consume("user-1")).toBe(false);

		const start = Date.now();
		while (Date.now() - start < 5) {
			// busy-wait
		}

		limiter.cleanup();
		// After cleanup + expired window, user gets fresh budget
		expect(limiter.consume("user-1")).toBe(true);
	});
});
