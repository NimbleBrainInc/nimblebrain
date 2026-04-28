import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import {
	createDirectExecutor,
	executeHttp,
	type ChatFn,
	type ChatFnResult,
	type ExecutorContext,
} from "../../../../src/bundles/automations/src/executor.ts";
import type { Automation } from "../../../../src/bundles/automations/src/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
	return {
		id: "daily-summary",
		name: "Daily Summary",
		prompt: "Summarize today's activity",
		schedule: { type: "cron", expression: "0 9 * * *" },
		enabled: true,
		source: "user",
		createdAt: "2025-06-01T00:00:00.000Z",
		updatedAt: "2025-06-01T00:00:00.000Z",
		runCount: 3,
		consecutiveErrors: 0,
		cumulativeInputTokens: 0,
		cumulativeOutputTokens: 0,
		...overrides,
	};
}

function chatResponse(overrides: Record<string, unknown> = {}) {
	return {
		response: "Here is your summary.",
		conversationId: "conv_abc123",
		skillName: null,
		toolCalls: [
			{ id: "tc1", name: "nb__briefing", input: {}, output: "ok", ok: true, ms: 100 },
			{ id: "tc2", name: "nb__list_apps", input: {}, output: "ok", ok: true, ms: 50 },
		],
		inputTokens: 1200,
		outputTokens: 350,
		stopReason: "complete",
		usage: {
			inputTokens: 1200,
			outputTokens: 350,
			cacheReadTokens: 0,
			costUsd: 0.01,
			model: "claude-sonnet-4-5-20250929",
			llmMs: 2500,
			iterations: 3,
		},
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;

beforeEach(() => {
	process.env.NB_HOST_URL = "http://test-host:3000";
	process.env.NB_INTERNAL_TOKEN = "test-token-123";
	mockFetch = mock(() =>
		Promise.resolve(
			new Response(JSON.stringify(chatResponse()), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		),
	);
	globalThis.fetch = mockFetch as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	delete process.env.NB_HOST_URL;
	delete process.env.NB_INTERNAL_TOKEN;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeHttp", () => {
	test("successful response → correct AutomationRun fields", async () => {
		const run = await executeHttp(makeAutomation());

		expect(run.id).toMatch(/^run_[a-f0-9-]{12}$/);
		expect(run.automationId).toBe("daily-summary");
		expect(run.status).toBe("success");
		expect(run.conversationId).toBe("conv_abc123");
		expect(run.inputTokens).toBe(1200);
		expect(run.outputTokens).toBe(350);
		expect(run.toolCalls).toBe(2);
		expect(run.iterations).toBe(3);
		expect(run.resultPreview).toBe("Here is your summary.");
		expect(run.stopReason).toBe("complete");
		expect(run.startedAt).toBeTruthy();
		expect(run.completedAt).toBeTruthy();
		expect(run.error).toBeUndefined();
	});

	test("request body includes correct metadata structure", async () => {
		await executeHttp(makeAutomation());

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("http://test-host:3000/v1/chat");

		const body = JSON.parse(opts.body as string);
		expect(body.message).toBe("Summarize today's activity");
		expect(body.metadata).toEqual({
			source: "automation",
			automationId: "daily-summary",
			automationName: "Daily Summary",
		});
	});

	test("Authorization header uses Bearer scheme", async () => {
		await executeHttp(makeAutomation());

		const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
		const headers = opts.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer test-token-123");
	});

	test("allowedTools passed when present", async () => {
		await executeHttp(makeAutomation({ allowedTools: ["nb__*", "granola__*"] }));

		const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(opts.body as string);
		expect(body.allowedTools).toEqual(["nb__*", "granola__*"]);
	});

	test("allowedTools omitted when undefined", async () => {
		await executeHttp(makeAutomation({ allowedTools: undefined }));

		const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(opts.body as string);
		expect(body.allowedTools).toBeUndefined();
	});

	test("model passed when set", async () => {
		await executeHttp(makeAutomation({ model: "claude-haiku-3-5-20241022" }));

		const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(opts.body as string);
		expect(body.model).toBe("claude-haiku-3-5-20241022");
	});

	test("model omitted when null", async () => {
		await executeHttp(makeAutomation({ model: null }));

		const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(opts.body as string);
		expect(body.model).toBeUndefined();
	});

	test("maxIterations and maxInputTokens passed through", async () => {
		await executeHttp(makeAutomation({ maxIterations: 8, maxInputTokens: 100_000 }));

		const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(opts.body as string);
		expect(body.maxIterations).toBe(8);
		expect(body.maxInputTokens).toBe(100_000);
	});

	// --- stopReason mapping ---

	test("stopReason max_iterations → status timeout", async () => {
		mockFetch.mockImplementation(() =>
			Promise.resolve(
				new Response(
					JSON.stringify(chatResponse({ stopReason: "max_iterations" })),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			),
		);

		const run = await executeHttp(makeAutomation());
		expect(run.status).toBe("timeout");
		expect(run.stopReason).toBe("max_iterations");
	});

	test("stopReason complete → status success", async () => {
		const run = await executeHttp(makeAutomation());
		expect(run.status).toBe("success");
		expect(run.stopReason).toBe("complete");
	});

	test("stopReason length → status failure (model truncated mid-run)", async () => {
		mockFetch.mockImplementation(() =>
			Promise.resolve(
				new Response(JSON.stringify(chatResponse({ stopReason: "length" })), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		);

		const run = await executeHttp(makeAutomation());
		expect(run.status).toBe("failure");
		expect(run.stopReason).toBe("length");
	});

	test("stopReason content_filter → status failure", async () => {
		mockFetch.mockImplementation(() =>
			Promise.resolve(
				new Response(
					JSON.stringify(chatResponse({ stopReason: "content_filter" })),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			),
		);

		const run = await executeHttp(makeAutomation());
		expect(run.status).toBe("failure");
		expect(run.stopReason).toBe("content_filter");
	});

	test("stopReason other → status failure (unrecognized values fail closed)", async () => {
		mockFetch.mockImplementation(() =>
			Promise.resolve(
				new Response(JSON.stringify(chatResponse({ stopReason: "other" })), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		);

		const run = await executeHttp(makeAutomation());
		expect(run.status).toBe("failure");
	});

	// --- resultPreview truncation ---

	test("resultPreview truncated to 500 chars", async () => {
		const longResponse = "x".repeat(1000);
		mockFetch.mockImplementation(() =>
			Promise.resolve(
				new Response(
					JSON.stringify(chatResponse({ response: longResponse })),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			),
		);

		const run = await executeHttp(makeAutomation());
		expect(run.resultPreview).toHaveLength(500);
	});

	// --- HTTP errors ---

	test("500 response → error with status code", async () => {
		mockFetch.mockImplementation(() =>
			Promise.resolve(
				new Response('{"error":"internal"}', { status: 500 }),
			),
		);

		await expect(executeHttp(makeAutomation())).rejects.toThrow("500");
	});

	test("401 response → auth failure error", async () => {
		mockFetch.mockImplementation(() =>
			Promise.resolve(
				new Response('{"error":"unauthorized"}', { status: 401 }),
			),
		);

		await expect(executeHttp(makeAutomation())).rejects.toThrow("401");
	});

	// --- Network errors ---

	test("network error → descriptive error message", async () => {
		mockFetch.mockImplementation(() =>
			Promise.reject(new TypeError("fetch failed")),
		);

		await expect(executeHttp(makeAutomation())).rejects.toThrow(
			"network error",
		);
	});

	// --- Abort signal ---

	test("abort signal → fetch receives signal", async () => {
		const controller = new AbortController();

		// Make fetch hang until aborted
		mockFetch.mockImplementation(
			(_url: string, opts: RequestInit) =>
				new Promise((_resolve, reject) => {
					opts.signal?.addEventListener("abort", () => {
						reject(new DOMException("The operation was aborted.", "AbortError"));
					});
				}),
		);

		const promise = executeHttp(makeAutomation(), controller.signal);
		controller.abort();

		await expect(promise).rejects.toThrow("aborted");
	});

	test("signal passed to fetch call (combined with timeout)", async () => {
		const controller = new AbortController();
		await executeHttp(makeAutomation(), controller.signal);

		const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
		// Signal is combined via AbortSignal.any(), so it's not the same object
		expect(opts.signal).toBeDefined();
		expect(opts.signal).not.toBe(controller.signal);
	});

	// --- Default host URL ---

	test("uses default host URL when NB_HOST_URL not set", async () => {
		delete process.env.NB_HOST_URL;

		await executeHttp(makeAutomation());

		const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("http://127.0.0.1:27247/v1/chat");
	});

	// --- No token ---

	test("omits Authorization header when NB_INTERNAL_TOKEN not set", async () => {
		delete process.env.NB_INTERNAL_TOKEN;

		await executeHttp(makeAutomation());

		const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
		const headers = opts.headers as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
	});

	// --- Timeout ---

	test("timeout fires when maxRunDurationMs is very short", async () => {
		// Use a very short timeout with a fetch that respects the abort signal
		mockFetch.mockImplementation(
			(_url: string, opts: RequestInit) =>
				new Promise((_resolve, reject) => {
					opts.signal?.addEventListener("abort", () => {
						reject(new DOMException("The operation was aborted.", "TimeoutError"));
					});
				}),
		);

		const auto = makeAutomation({ maxRunDurationMs: 100 }); // 100ms timeout
		await expect(executeHttp(auto)).rejects.toThrow(/timed out/);
	});
});

// ---------------------------------------------------------------------------
// createDirectExecutor — context resolution
// ---------------------------------------------------------------------------

function makeDirectChatFn(): ChatFn {
	return async (req): Promise<ChatFnResult> => ({
		response: `echo: ${req.message}`,
		conversationId: "conv_test",
		toolCalls: [],
		inputTokens: 100,
		outputTokens: 50,
		stopReason: "complete",
		usage: { iterations: 1 },
	});
}

describe("createDirectExecutor", () => {
	test("passes the automation object to getContext callback", async () => {
		let receivedAutomation: Automation | undefined;

		const getContext = (auto?: Automation): ExecutorContext => {
			receivedAutomation = auto;
			return { workspaceId: "ws_test", identity: { id: "usr_owner" } };
		};

		const executor = createDirectExecutor(makeDirectChatFn(), getContext);
		const automation = makeAutomation({
			ownerId: "usr_owner",
			workspaceId: "ws_test",
		});

		await executor(automation);

		expect(receivedAutomation).toBeDefined();
		expect(receivedAutomation!.id).toBe("daily-summary");
		expect(receivedAutomation!.ownerId).toBe("usr_owner");
		expect(receivedAutomation!.workspaceId).toBe("ws_test");
	});

	test("forwards workspaceId and identity from context to chat request", async () => {
		let capturedWsId: string | undefined;
		let capturedIdentity: { id: string } | undefined;

		const chatFn: ChatFn = async (req) => {
			capturedWsId = req.workspaceId;
			capturedIdentity = req.identity;
			return {
				response: "ok",
				conversationId: "conv_test",
				toolCalls: [],
				inputTokens: 100,
				outputTokens: 50,
				stopReason: "complete",
				usage: { iterations: 1 },
			};
		};

		const getContext = (): ExecutorContext => ({
			workspaceId: "ws_eng",
			identity: { id: "usr_alice" },
		});

		const executor = createDirectExecutor(chatFn, getContext);
		await executor(makeAutomation());

		expect(capturedWsId).toBe("ws_eng");
		expect(capturedIdentity?.id).toBe("usr_alice");
	});

	test("omits workspaceId and identity when context is empty", async () => {
		let capturedRequest: Record<string, unknown> | undefined;

		const chatFn: ChatFn = async (req) => {
			capturedRequest = req as unknown as Record<string, unknown>;
			return {
				response: "ok",
				conversationId: "conv_test",
				toolCalls: [],
				inputTokens: 100,
				outputTokens: 50,
				stopReason: "complete",
				usage: { iterations: 1 },
			};
		};

		const getContext = (): ExecutorContext => ({});

		const executor = createDirectExecutor(chatFn, getContext);
		await executor(makeAutomation());

		expect(capturedRequest).toBeDefined();
		expect(capturedRequest!.workspaceId).toBeUndefined();
		expect(capturedRequest!.identity).toBeUndefined();
	});
});
