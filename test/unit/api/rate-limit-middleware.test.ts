import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { rateLimit, requestRateLimit } from "../../../src/api/middleware/rate-limit.ts";
import { LoginRateLimiter, RequestRateLimiter } from "../../../src/api/rate-limiter.ts";
import type { AppEnv } from "../../../src/api/types.ts";

/**
 * Build a minimal Hono app with the rate-limit middleware protecting a
 * login-like endpoint that always returns 401 (to trigger recording).
 */
function buildApp(limiter: LoginRateLimiter) {
	const app = new Hono();
	app.post("/login", rateLimit(limiter), (c) => {
		return c.json({ error: "Invalid credentials" }, 401);
	});
	return app;
}

describe("rate-limit middleware", () => {
	it("ignores X-Forwarded-For header for rate limit keying", async () => {
		// maxAttempts=3 so we hit the limit quickly
		const limiter = new LoginRateLimiter(3, 60_000, 100);
		const app = buildApp(limiter);

		// Send 3 requests with different X-Forwarded-For headers.
		// If the middleware trusted the header, each would get its own bucket
		// and none would be rate-limited.
		for (let i = 0; i < 3; i++) {
			const res = await app.request("/login", {
				method: "POST",
				headers: { "X-Forwarded-For": `10.0.0.${i}` },
			});
			expect(res.status).toBe(401);
		}

		// The 4th request should be rate-limited regardless of a new IP header
		const res = await app.request("/login", {
			method: "POST",
			headers: { "X-Forwarded-For": "10.0.0.99" },
		});
		expect(res.status).toBe(429);
	});

	it("ignores X-Real-IP header for rate limit keying", async () => {
		const limiter = new LoginRateLimiter(3, 60_000, 100);
		const app = buildApp(limiter);

		for (let i = 0; i < 3; i++) {
			const res = await app.request("/login", {
				method: "POST",
				headers: { "X-Real-IP": `10.0.0.${i}` },
			});
			expect(res.status).toBe(401);
		}

		const res = await app.request("/login", {
			method: "POST",
			headers: { "X-Real-IP": "10.0.0.99" },
		});
		expect(res.status).toBe(429);
	});

	it("enforces global rate limit across all requests", async () => {
		// Per-key limit is high (100), but global limit is low (3)
		const limiter = new LoginRateLimiter(100, 60_000, 3);
		const app = buildApp(limiter);

		for (let i = 0; i < 3; i++) {
			const res = await app.request("/login", { method: "POST" });
			expect(res.status).toBe(401);
		}

		// Global limit reached — next request should get 429
		const res = await app.request("/login", { method: "POST" });
		expect(res.status).toBe(429);

		const body = await res.json();
		expect(body.error).toBe("rate_limited");
		expect(body.message).toBe("Too many login attempts");
		expect(res.headers.get("Retry-After")).toBe("60");
	});
});

/**
 * Build a Hono app that simulates authenticated routes with requestRateLimit.
 * Sets identity in middleware to simulate requireAuth having run first.
 */
function buildAuthenticatedApp(limiter: RequestRateLimiter, userId = "user-1") {
	const app = new Hono<AppEnv>();
	// Simulate requireAuth setting identity
	app.use("*", async (c, next) => {
		c.set("identity", { id: userId, name: "Test", email: "test@test.com", role: "member" } as AppEnv["Variables"]["identity"]);
		await next();
	});
	app.use("*", requestRateLimit(limiter));
	app.post("/v1/chat", (c) => c.json({ ok: true }));
	return app;
}

describe("requestRateLimit middleware", () => {
	it("allows requests under the limit", async () => {
		const limiter = new RequestRateLimiter(3, 60_000);
		const app = buildAuthenticatedApp(limiter);

		for (let i = 0; i < 3; i++) {
			const res = await app.request("/v1/chat", { method: "POST" });
			expect(res.status).toBe(200);
		}
	});

	it("returns 429 when limit is exceeded", async () => {
		const limiter = new RequestRateLimiter(2, 60_000);
		const app = buildAuthenticatedApp(limiter);

		await app.request("/v1/chat", { method: "POST" });
		await app.request("/v1/chat", { method: "POST" });

		const res = await app.request("/v1/chat", { method: "POST" });
		expect(res.status).toBe(429);

		const body = await res.json();
		expect(body.error).toBe("rate_limited");
		expect(body.message).toBe("Rate limit exceeded");
		expect(res.headers.get("Retry-After")).toBe("60");
	});

	it("tracks different users independently", async () => {
		const limiter = new RequestRateLimiter(2, 60_000);

		const app = new Hono<AppEnv>();
		// Dynamic user based on header
		app.use("*", async (c, next) => {
			const userId = c.req.header("X-Test-User") ?? "default";
			c.set("identity", { id: userId, name: "Test", email: "t@t.com", role: "member" } as AppEnv["Variables"]["identity"]);
			await next();
		});
		app.use("*", requestRateLimit(limiter));
		app.post("/v1/chat", (c) => c.json({ ok: true }));

		// User A exhausts their limit
		for (let i = 0; i < 2; i++) {
			const res = await app.request("/v1/chat", {
				method: "POST",
				headers: { "X-Test-User": "user-a" },
			});
			expect(res.status).toBe(200);
		}
		const resA = await app.request("/v1/chat", {
			method: "POST",
			headers: { "X-Test-User": "user-a" },
		});
		expect(resA.status).toBe(429);

		// User B still has their full budget
		const resB = await app.request("/v1/chat", {
			method: "POST",
			headers: { "X-Test-User": "user-b" },
		});
		expect(resB.status).toBe(200);
	});

	it("uses 'anon' key when no identity is set", async () => {
		const limiter = new RequestRateLimiter(1, 60_000);
		const app = new Hono();
		// No identity middleware — simulates unauthenticated fallback
		app.use("*", requestRateLimit(limiter));
		app.post("/v1/chat", (c) => c.json({ ok: true }));

		const res1 = await app.request("/v1/chat", { method: "POST" });
		expect(res1.status).toBe(200);

		const res2 = await app.request("/v1/chat", { method: "POST" });
		expect(res2.status).toBe(429);
	});
});
