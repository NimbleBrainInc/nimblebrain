/**
 * Unit tests for `McpServerHost`'s reclamation policy:
 *
 *   - **Idle TTL** — periodic sweep closes transports past the idle window.
 *   - **LRU on capacity** — new initialize at cap evicts the oldest, not 429.
 *   - **Touch reorders LRU** — an active session is never the eviction target.
 *
 * Each test drives the real `initializeSession` path via `host.handle()` with
 * a JSON-RPC initialize body. That gives us real `WebStandardStreamableHTTP`
 * transports in the map, with the SDK's full onclose cascade wired up — so
 * a successful eviction is observable both via `transportCount()` and via
 * the subsequent client request returning `Session not found`.
 *
 * TTLs are short wall-clock values (25–40 ms) matching the pattern used by
 * `test/unit/api/session-store/conformance.ts` — no fake clock required.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { McpServerHost } from "../../../src/api/mcp-server.ts";
import {
	InMemorySessionRegistry,
	type SessionRegistry,
} from "../../../src/api/session-store/index.ts";
import type { ResolvedFeatures } from "../../../src/config/features.ts";

const FAKE_FEATURES = {} as ResolvedFeatures;
const SESSION_CTX = { identity: null };

function initRequest(): Request {
	return new Request("http://test/mcp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			method: "initialize",
			params: {
				protocolVersion: "2025-11-25",
				clientInfo: { name: "test", version: "0" },
				capabilities: {},
			},
			id: 1,
		}),
	});
}

function listRequest(sessionId: string): Request {
	return new Request("http://test/mcp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"mcp-session-id": sessionId,
		},
		body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
	});
}

async function initSession(host: McpServerHost): Promise<string> {
	const res = await host.handle(initRequest(), FAKE_FEATURES, SESSION_CTX);
	const sid = res.headers.get("mcp-session-id");
	if (!sid) {
		throw new Error(`expected mcp-session-id header on init response; status=${res.status}`);
	}
	return sid;
}

async function touch(host: McpServerHost, sessionId: string): Promise<void> {
	await host.handle(listRequest(sessionId), FAKE_FEATURES, SESSION_CTX);
}

describe("McpServerHost — reclamation", () => {
	let registry: SessionRegistry;
	let host: McpServerHost;

	afterEach(async () => {
		await host?.shutdown();
	});

	describe("idle TTL", () => {
		beforeEach(() => {
			registry = new InMemorySessionRegistry({ ttlMs: 25, sweepIntervalMs: 5 });
			host = new McpServerHost({
				registry,
				idleTtlMs: 25,
				sweepIntervalMs: 5,
			});
		});

		it("closes transports whose idle window has elapsed", async () => {
			const sid = await initSession(host);
			expect(host.transportCount()).toBe(1);

			// Wait past TTL + a sweep tick.
			await new Promise((r) => setTimeout(r, 50));

			expect(host.transportCount()).toBe(0);

			// Subsequent request reports `not_found` — the registry was
			// also cleaned by the onclose cascade.
			const res = await host.handle(listRequest(sid), FAKE_FEATURES, SESSION_CTX);
			expect(res.status).toBe(404);
			const body = (await res.json()) as { error: { data: { reason: string } } };
			expect(body.error.data.reason).toBe("not_found");
		});

		it("keeps an actively-touched session alive past TTL", async () => {
			const sid = await initSession(host);
			// Touch every 10ms across a window > TTL (25ms).
			for (let i = 0; i < 6; i++) {
				await new Promise((r) => setTimeout(r, 10));
				await touch(host, sid);
			}
			expect(host.transportCount()).toBe(1);
		});
	});

	describe("LRU on capacity", () => {
		beforeEach(() => {
			// Long idle TTL so only the LRU path is exercised here.
			registry = new InMemorySessionRegistry({ ttlMs: 60_000 });
			host = new McpServerHost({
				registry,
				idleTtlMs: 60_000,
				maxSessions: 3,
				sweepIntervalMs: 60_000,
			});
		});

		it("evicts the least-recently-used transport when a new init arrives at cap", async () => {
			const s1 = await initSession(host);
			await initSession(host);
			await initSession(host);
			expect(host.transportCount()).toBe(3);

			// Fourth init at cap=3 → s1 evicted (it's the oldest).
			const s4 = await initSession(host);
			expect(host.transportCount()).toBe(3);

			// s1 is gone — should now miss with not_found.
			const res = await host.handle(listRequest(s1), FAKE_FEATURES, SESSION_CTX);
			expect(res.status).toBe(404);
			const body = (await res.json()) as { error: { data: { reason: string } } };
			expect(body.error.data.reason).toBe("not_found");

			// s4 is live.
			expect(typeof s4).toBe("string");
		});

		it("touching a session moves it out of LRU eviction range", async () => {
			const s1 = await initSession(host);
			const s2 = await initSession(host);
			const s3 = await initSession(host);

			// Touch s1 — now LRU order is s2, s3, s1.
			await touch(host, s1);

			// Fourth init evicts the new oldest, which is s2.
			await initSession(host);

			// s1 still live (we touched it).
			const r1 = await host.handle(listRequest(s1), FAKE_FEATURES, SESSION_CTX);
			expect(r1.status).not.toBe(404);

			// s2 evicted.
			const r2 = await host.handle(listRequest(s2), FAKE_FEATURES, SESSION_CTX);
			expect(r2.status).toBe(404);

			// s3 still live (untouched but newer than s2).
			const r3 = await host.handle(listRequest(s3), FAKE_FEATURES, SESSION_CTX);
			expect(r3.status).not.toBe(404);
		});
	});

	describe("construction guards", () => {
		afterEach(async () => {
			// no host to shut down in these failure-mode tests
		});

		it("rejects non-positive idleTtlMs", () => {
			const reg = new InMemorySessionRegistry({ ttlMs: 60_000 });
			expect(
				() => new McpServerHost({ registry: reg, idleTtlMs: 0 }),
			).toThrow(/idleTtlMs/);
			expect(
				() => new McpServerHost({ registry: reg, idleTtlMs: Number.NaN }),
			).toThrow(/idleTtlMs/);
			reg.shutdown();
		});

		it("rejects non-positive maxSessions", () => {
			const reg = new InMemorySessionRegistry({ ttlMs: 60_000 });
			expect(
				() => new McpServerHost({ registry: reg, idleTtlMs: 60_000, maxSessions: 0 }),
			).toThrow(/maxSessions/);
			reg.shutdown();
		});
	});
});
