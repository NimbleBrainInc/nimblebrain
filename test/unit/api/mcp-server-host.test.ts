/**
 * Unit tests for `McpServerHost.handle`'s session-miss classification path.
 *
 * Covers the two reasons the host emits in `error.data.reason`:
 *
 *   - `not_found`   — registry has no entry for this session id.
 *   - `unavailable` — registry has an entry, but the live transport isn't
 *     on this process. Could be a process restart or a sticky-routing
 *     miss; the host doesn't (and shouldn't) distinguish — the registry
 *     is deployment-vocabulary-free.
 *
 * Constructed with a hand-populated `InMemorySessionRegistry` so tests are
 * direct and don't need a real HTTP server.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { McpServerHost } from "../../../src/api/mcp-server.ts";
import {
	InMemorySessionRegistry,
	type SessionRegistry,
} from "../../../src/api/session-store/index.ts";
import type { ResolvedFeatures } from "../../../src/config/features.ts";
import { ToolRegistry } from "../../../src/tools/registry.ts";

const FAKE_FEATURES = {} as ResolvedFeatures;
const SAMPLE_SID = "11111111-2222-3333-4444-555555555555";

function postRequest(sessionId: string): Request {
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

describe("McpServerHost — session-miss classification", () => {
	let registry: SessionRegistry;
	let host: McpServerHost;
	let toolRegistry: ToolRegistry;

	beforeEach(() => {
		registry = new InMemorySessionRegistry({ ttlMs: 60_000 });
		host = new McpServerHost({ registry });
		toolRegistry = new ToolRegistry();
	});

	afterEach(async () => {
		await host.shutdown();
	});

	it("returns reason=not_found when the registry has no entry", async () => {
		const res = await host.handle(postRequest(SAMPLE_SID), toolRegistry, FAKE_FEATURES, {
			registry: toolRegistry,
			identity: null,
			workspaceId: "ws_test",
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as {
			error: { data: { reason: string } };
		};
		expect(body.error.data.reason).toBe("not_found");
	});

	// Session exists in the registry but no live transport on this process.
	// Could be a process restart (transport state lost) or a sticky-routing
	// miss (request landed on a process that didn't handle the init). Host
	// reports `unavailable` without trying to distinguish — the registry
	// has no concept of which process owns what.
	it("returns reason=unavailable when registry has the session but transport is missing", async () => {
		await registry.create({
			sessionId: SAMPLE_SID,
			identityId: "usr_x",
			workspaceId: "ws_test",
			createdAt: Date.now(),
			lastAccessedAt: Date.now(),
		});

		const res = await host.handle(postRequest(SAMPLE_SID), toolRegistry, FAKE_FEATURES, {
			registry: toolRegistry,
			identity: null,
			workspaceId: "ws_test",
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as {
			error: { data: { reason: string } };
		};
		expect(body.error.data.reason).toBe("unavailable");
	});

	// Registry outage degrades to `not_found`. We already know the local
	// transport map doesn't have it, so falling back to "treat as missing"
	// returns a useful 404 instead of a 500.
	it("returns reason=not_found when registry.get throws", async () => {
		const flakyRegistry: SessionRegistry = {
			create: async () => {},
			get: async () => {
				throw new Error("redis down");
			},
			touch: async () => {},
			delete: async () => {},
			sweepExpired: async () => {},
			shutdown: async () => {},
		};
		const flakyHost = new McpServerHost({ registry: flakyRegistry });

		const res = await flakyHost.handle(postRequest(SAMPLE_SID), toolRegistry, FAKE_FEATURES, {
			registry: toolRegistry,
			identity: null,
			workspaceId: "ws_test",
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as {
			error: { data: { reason: string } };
		};
		expect(body.error.data.reason).toBe("not_found");
		await flakyHost.shutdown();
	});
});
