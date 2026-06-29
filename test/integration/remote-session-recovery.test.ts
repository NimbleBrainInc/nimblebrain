import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
	ListResourcesRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";

/**
 * End-to-end recovery half of issue #571: when a remote MCP server rolls and
 * forgets our Streamable-HTTP session, a subsequent `ui://` read must
 * re-initialize the session and retry — returning the resource — rather than
 * surfacing the "Session not found" error as a null that strands the bundle's
 * sidebar UI until a manual runtime bounce.
 *
 * Unlike the unit test (which hand-builds the error shape), this drives the real
 * MCP SDK client transport against a real Streamable-HTTP server, so it proves
 * `classifyConnectionFailure` matches the actual `StreamableHTTPError` the SDK
 * throws on the canonical 404 + "-32001 Session not found" wire shape.
 */

const UI_HTML = "<html><body>main</body></html>";

interface MockRollingServer {
	url: string;
	/** Drop all live sessions — the next request on an old session id 404s,
	 *  exactly as a rolling deploy's fresh pod does. */
	roll: () => void;
	close: () => void;
}

function createMcpServer(): Server {
	const server = new Server(
		{ name: "rolling-remote", version: "0.1.0" },
		{ capabilities: { resources: {} } },
	);
	server.setRequestHandler(ListResourcesRequestSchema, async () => ({
		resources: [{ uri: "ui://main", name: "main", mimeType: "text/html" }],
	}));
	server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({
		contents: [{ uri: req.params.uri, mimeType: "text/html", text: UI_HTML }],
	}));
	return server;
}

function startRollingServer(): MockRollingServer {
	let counter = 0;
	const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

	const httpServer = Bun.serve({
		port: 0,
		async fetch(req: Request) {
			const url = new URL(req.url);
			if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });

			const sid = req.headers.get("mcp-session-id");

			// Known session — route to its transport.
			if (sid) {
				const existing = transports.get(sid);
				if (existing) return existing.handleRequest(req);
				// Stale session (server rolled). This is the REAL wire shape the fleet
				// servers' Python MCP SDK emits (streamable_http_manager.py): HTTP 404
				// with a `{"code":-32600,"message":"Session not found"}` body and the
				// `id:"server-error"` sentinel. The SDK client surfaces it as
				// `StreamableHTTPError(404, "...Session not found...")`.
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: "server-error",
						error: { code: -32600, message: "Session not found" },
					}),
					{ status: 404, headers: { "content-type": "application/json" } },
				);
			}

			// No session id → a fresh `initialize`. Mint a session + transport.
			const transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: () => `sess-${++counter}`,
				onsessioninitialized: (id) => transports.set(id, transport),
			});
			await createMcpServer().connect(transport);
			return transport.handleRequest(req);
		},
	});

	return {
		url: `http://localhost:${httpServer.port}/mcp`,
		roll() {
			for (const t of transports.values()) t.close().catch(() => {});
			transports.clear();
		},
		close() {
			httpServer.stop(true);
			for (const t of transports.values()) t.close().catch(() => {});
			transports.clear();
		},
	};
}

describe("McpSource — remote session recovery (issue #571)", () => {
	let server: MockRollingServer;
	let source: McpSource;

	beforeEach(() => {
		server = startRollingServer();
	});

	afterEach(async () => {
		await source?.stop();
		server?.close();
	});

	it("recovers a ui:// read after the server drops the session — no manual bounce", async () => {
		source = new McpSource(
			"rolling-remote",
			{ type: "remote", url: new URL(server.url), allowInsecure: true },
			new NoopEventSink(),
		);
		await source.start();

		// Baseline: the read works while the session is live.
		const before = await source.readResource("ui://main", { logFailures: true });
		expect(before?.text).toBe(UI_HTML);

		// The server rolls: every live session id is now stale.
		server.roll();

		// Without recovery this returns null ("Resource not found" in the UI). With
		// the fix, readResource detects the lost session, re-initializes, retries,
		// and returns the resource on the same call.
		const after = await source.readResource("ui://main", { logFailures: true });
		expect(after?.text).toBe(UI_HTML);
	}, 20_000);
});
