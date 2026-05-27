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

// ---------------------------------------------------------------------------
// stopReason → AutomationRun.status mapping (the LIVE scheduled path:
// createDirectExecutor → mapResultToRun → mapStopReasonToStatus). Run status
// drives backoff — if a fail-closed branch silently regressed to "success", a
// perpetually-failing automation would never back off and would hammer the LLM
// every tick. The mapping isn't exported, so exercise it via the executor.
// (Restores coverage lost when the executeHttp tests were deleted.)
// ---------------------------------------------------------------------------

describe("createDirectExecutor — stopReason → status", () => {
	function chatFnWithStop(stopReason: string): ChatFn {
		return async (): Promise<ChatFnResult> => ({
			response: "done",
			conversationId: "conv_test",
			toolCalls: [],
			inputTokens: 10,
			outputTokens: 5,
			stopReason,
			usage: { iterations: 1 },
		});
	}

	async function statusFor(stopReason: string): Promise<string> {
		const executor = createDirectExecutor(chatFnWithStop(stopReason), () => ({}));
		const run = await executor(makeAutomation());
		return run.status;
	}

	test("complete → success", async () => {
		expect(await statusFor("complete")).toBe("success");
	});

	test("max_iterations → timeout", async () => {
		expect(await statusFor("max_iterations")).toBe("timeout");
	});

	test("length → failure (fail-closed default)", async () => {
		expect(await statusFor("length")).toBe("failure");
	});

	test("content_filter → failure (fail-closed default)", async () => {
		expect(await statusFor("content_filter")).toBe("failure");
	});

	test("unrecognized stopReason → failure (fail-closed default)", async () => {
		expect(await statusFor("some_future_reason")).toBe("failure");
	});
});

// ---------------------------------------------------------------------------
// Recursive-call guard at the executor
// ---------------------------------------------------------------------------
//
// `allowedTools` is no longer in the LLM-facing schema (PR #127), but
// operator file edits and bundle-contributed schedules can still set it.
// The guard lives at the executor — closest to the actual chat() call —
// so it sees the merged Automation regardless of how the field got there.

describe("createDirectExecutor — recursive-call guard", () => {
	test("refuses to run when allowedTools includes automations__create", async () => {
		const executor = createDirectExecutor(
			makeDirectChatFn(),
			() => ({ workspaceId: "ws_test", identity: { id: "u" } }),
		);
		const automation = makeAutomation({
			allowedTools: ["files__*", "automations__create"],
		});

		await expect(executor(automation)).rejects.toThrow(/allowedTools/);
	});

	test("refuses to run when allowedTools includes automations__update", async () => {
		const executor = createDirectExecutor(
			makeDirectChatFn(),
			() => ({ workspaceId: "ws_test", identity: { id: "u" } }),
		);
		const automation = makeAutomation({
			allowedTools: ["automations__update"],
		});

		await expect(executor(automation)).rejects.toThrow(/allowedTools/);
	});

	test("permits non-recursive allowedTools", async () => {
		const executor = createDirectExecutor(
			makeDirectChatFn(),
			() => ({ workspaceId: "ws_test", identity: { id: "u" } }),
		);
		const automation = makeAutomation({
			allowedTools: ["files__*", "skills__list", "conversations__search"],
		});

		const result = await executor(automation);
		expect(result.status).toBe("success");
	});

	test("forwards a combined signal into chatFn so timeouts cancel in-flight chat work", async () => {
		// Regression: the old Promise.race pattern rejected at the timeout
		// but didn't propagate cancellation to the chatFn. The chat kept
		// running, finished cleanly minutes later, and the result was
		// silently discarded. Now the chatFn receives a signal that
		// aborts on the same timeout — so it can cooperatively stop.
		let receivedSignal: AbortSignal | undefined;
		let signalFiredDuringChat = false;

		const slowChatFn: ChatFn = async (req) => {
			receivedSignal = req.signal;
			// Wait up to 500ms but bail on abort so the test runs fast.
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 500);
				req.signal?.addEventListener(
					"abort",
					() => {
						signalFiredDuringChat = true;
						clearTimeout(timer);
						resolve();
					},
					{ once: true },
				);
			});
			// On abort the chat throws — matches engine.run behavior under
			// signal-driven cancellation.
			if (req.signal?.aborted) {
				throw new DOMException("The operation was aborted.", "AbortError");
			}
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

		const executor = createDirectExecutor(slowChatFn, () => ({
			workspaceId: "ws_test",
		}));
		const automation = makeAutomation({ maxRunDurationMs: 50 });

		await expect(executor(automation)).rejects.toThrow(/timed out after/);
		expect(receivedSignal).toBeDefined();
		expect(signalFiredDuringChat).toBe(true);
	});

	test("external cancel propagates into chatFn signal as AbortError", async () => {
		// Symmetric to the timeout case: when the scheduler aborts the
		// run controller (manual cancel, scheduler.stop()), the chatFn's
		// signal must also fire so the in-flight engine work cancels.
		let chatSawAbort = false;
		const slowChatFn: ChatFn = async (req) => {
			await new Promise<void>((resolve) => {
				req.signal?.addEventListener(
					"abort",
					() => {
						chatSawAbort = true;
						resolve();
					},
					{ once: true },
				);
				setTimeout(resolve, 5000);
			});
			throw new DOMException("The operation was aborted.", "AbortError");
		};

		const executor = createDirectExecutor(slowChatFn, () => ({ workspaceId: "ws_test" }));
		const externalController = new AbortController();
		const automation = makeAutomation({ maxRunDurationMs: 10_000 });

		const runPromise = executor(automation, externalController.signal);
		// Give the chat a tick to start, then cancel.
		await new Promise((r) => setTimeout(r, 10));
		externalController.abort();

		await expect(runPromise).rejects.toThrow();
		expect(chatSawAbort).toBe(true);
	});

	test("external-cancel wins the race when timeout fires concurrently — no false 'timeout' status", async () => {
		// Race regression: external abort + timeout firing in the same
		// tick. Without the `externallyAborted` flag, `timedOut` flips
		// true under both paths and the catch rewrites the error to
		// "timed out after Ns" — so the scheduler stamps `status:
		// "timeout"` on what was really a cancel. Narrow window, but
		// the whole point of the PR is honest status records.
		const chatFn: ChatFn = async (req) => {
			await new Promise<void>((resolve) => {
				req.signal?.addEventListener("abort", () => resolve(), { once: true });
				setTimeout(resolve, 5000);
			});
			throw new DOMException("The operation was aborted.", "AbortError");
		};

		const executor = createDirectExecutor(chatFn, () => ({ workspaceId: "ws_test" }));
		const externalController = new AbortController();
		// Make the timeout extremely tight so it fires very close to the
		// external cancel — exercises the race the flag is meant to
		// disambiguate.
		const automation = makeAutomation({ maxRunDurationMs: 5 });

		const runPromise = executor(automation, externalController.signal);
		// Cancel externally in the same tick — both abort sources fire
		// near-simultaneously.
		externalController.abort();

		// External cancel must dominate: the error must NOT be the
		// timeout-shape that `Scheduler.dispatchRun` keys off via
		// `errorMsg.includes("timed out")`.
		let caughtMessage = "";
		try {
			await runPromise;
		} catch (e) {
			caughtMessage = e instanceof Error ? e.message : String(e);
		}
		expect(caughtMessage).not.toMatch(/timed out after/);
	});
});
