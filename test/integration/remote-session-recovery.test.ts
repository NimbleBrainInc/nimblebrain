import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	ListResourcesRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { type RemoteMcpFixture, startRemoteMcpServer } from "../helpers/remote-mcp-fixture.ts";

/**
 * End-to-end recovery half of issue #571: when a remote MCP server rolls and
 * forgets our Streamable-HTTP session, a subsequent `ui://` read must
 * re-initialize the session and retry — returning the resource — rather than
 * surfacing the "Session not found" error as a null that strands the connector's
 * sidebar UI until a manual runtime bounce.
 *
 * Unlike the unit test (which hand-builds the error shape), this drives the real
 * MCP SDK client transport against a real Streamable-HTTP server, so it proves
 * `classifyConnectionFailure` matches the actual `StreamableHTTPError` the SDK
 * throws on the canonical 404 + "-32001 Session not found" wire shape.
 */

const UI_HTML = "<html><body>main</body></html>";

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

describe("McpSource — remote session recovery (issue #571)", () => {
	let server: RemoteMcpFixture;
	let source: McpSource;

	beforeEach(() => {
		server = startRemoteMcpServer(createMcpServer);
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
