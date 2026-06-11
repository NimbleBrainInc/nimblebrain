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
	type ExecutorContext,
	type TaskFn,
	type TaskFnResult,
} from "../../../../src/bundles/automations/src/executor.ts";
import type { Automation, AutomationRun } from "../../../../src/bundles/automations/src/types.ts";

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

function makeDirectTaskFn(): TaskFn {
	return async (req): Promise<TaskFnResult> => ({
		output: `echo: ${req.prompt}`,
		conversationId: "conv_test",
		toolCalls: [],
		stopReason: "complete",
		usage: { inputTokens: 100, outputTokens: 50, iterations: 1 },
	});
}

describe("createDirectExecutor", () => {
	test("passes the automation object to getContext callback", async () => {
		let receivedAutomation: Automation | undefined;

		const getContext = (auto?: Automation): ExecutorContext => {
			receivedAutomation = auto;
			return { workspaceId: "ws_test", identity: { id: "usr_owner" } };
		};

		const executor = createDirectExecutor(makeDirectTaskFn(), getContext);
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

	test("forwards workspaceId and identity from context to task request", async () => {
		let capturedWsId: string | undefined;
		let capturedIdentity: { id: string } | undefined;

		const taskFn: TaskFn = async (req) => {
			capturedWsId = req.workspaceId;
			capturedIdentity = req.identity;
			return {
				output: "ok",
				conversationId: "conv_test",
				toolCalls: [],
				stopReason: "complete",
				usage: { inputTokens: 100, outputTokens: 50, iterations: 1 },
			};
		};

		const getContext = (): ExecutorContext => ({
			workspaceId: "ws_eng",
			identity: { id: "usr_alice" },
		});

		const executor = createDirectExecutor(taskFn, getContext);
		await executor(makeAutomation());

		expect(capturedWsId).toBe("ws_eng");
		expect(capturedIdentity?.id).toBe("usr_alice");
	});

	test("omits workspaceId and identity when context is empty", async () => {
		let capturedRequest: Record<string, unknown> | undefined;

		const taskFn: TaskFn = async (req) => {
			capturedRequest = req as unknown as Record<string, unknown>;
			return {
				output: "ok",
				conversationId: "conv_test",
				toolCalls: [],
				stopReason: "complete",
				usage: { inputTokens: 100, outputTokens: 50, iterations: 1 },
			};
		};

		const getContext = (): ExecutorContext => ({});

		const executor = createDirectExecutor(taskFn, getContext);
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
	function taskFnWithStop(stopReason: string): TaskFn {
		return async (): Promise<TaskFnResult> => ({
			output: "done",
			conversationId: "conv_test",
			toolCalls: [],
			stopReason,
			usage: { inputTokens: 10, outputTokens: 5, iterations: 1 },
		});
	}

	async function statusFor(stopReason: string): Promise<string> {
		const executor = createDirectExecutor(taskFnWithStop(stopReason), () => ({}));
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
// Connector-unreachable de-masking. A run can end `complete` (→ would-be
// `success`) while a tool call hit a connector that couldn't be routed — the
// agent "completes" by writing around the gap. That is the silent failure
// operators reported (a standup summary that never reached Teams, recorded as
// success). mapResultToRun downgrades such runs to `failure` and names the
// tool, keyed on the orchestrator routing reason carried per tool call
// (`errorReason`), NOT on a generic `ok: false` (which would flag healthy
// runs where the agent probed and self-corrected).
// ---------------------------------------------------------------------------

describe("createDirectExecutor — connector-unreachable de-masking", () => {
	function taskFnWithToolCalls(toolCalls: Array<Record<string, unknown>>): TaskFn {
		return async (): Promise<TaskFnResult> => ({
			output: "I documented the gap in the deliverable.",
			conversationId: "conv_test",
			toolCalls,
			stopReason: "complete",
			usage: { inputTokens: 10, outputTokens: 5, iterations: 1 },
		});
	}

	async function runWith(toolCalls: Array<Record<string, unknown>>): Promise<AutomationRun> {
		const executor = createDirectExecutor(taskFnWithToolCalls(toolCalls), () => ({}));
		return executor(makeAutomation());
	}

	test("complete + unknown_tool_source → failure naming the tool", async () => {
		const run = await runWith([
			{ id: "t1", name: "nb__search", input: {}, output: "ok", ok: true, ms: 20 },
			{
				id: "t2",
				name: "ws_x-teams__send_message",
				input: {},
				output: "[orchestrator] no source …",
				ok: false,
				ms: 15,
				errorReason: "unknown_tool_source",
			},
		]);
		expect(run.status).toBe("failure");
		expect(run.error).toMatch(/Connector unavailable/);
		expect(run.error).toMatch(/ws_x-teams__send_message/);
	});

	test("complete + reauth_required (installed but auth expired) → failure", async () => {
		const run = await runWith([
			{
				id: "t1",
				name: "ws_x-teams__send_message",
				input: {},
				output: "teams needs to be reconnected",
				ok: false,
				ms: 18,
				errorReason: "reauth_required",
			},
		]);
		expect(run.status).toBe("failure");
		expect(run.error).toMatch(/Connector unavailable/);
	});

	test("complete + workspace_access_denied → failure", async () => {
		const run = await runWith([
			{
				id: "t1",
				name: "ws_other-teams__send_message",
				input: {},
				output: "[orchestrator] not a member …",
				ok: false,
				ms: 12,
				errorReason: "workspace_access_denied",
			},
		]);
		expect(run.status).toBe("failure");
		expect(run.error).toMatch(/Connector unavailable/);
	});

	test("complete + all tool calls ok → success (no false downgrade)", async () => {
		const run = await runWith([
			{ id: "t1", name: "nb__briefing", input: {}, output: "ok", ok: true, ms: 20 },
			{ id: "t2", name: "synapse-crm__list", input: {}, output: "ok", ok: true, ms: 30 },
		]);
		expect(run.status).toBe("success");
		expect(run.error).toBeUndefined();
	});

	test("complete + a non-routing tool error (handled by agent) → stays success", async () => {
		// `invalid_tool_name` is deliberately NOT in the unreachable set: it's
		// usually the agent probing a wrong name and recovering, not a real
		// connector gap. A logical tool error with no errorReason likewise must
		// not flip the run.
		const run = await runWith([
			{
				id: "t1",
				name: "nb__search",
				input: {},
				output: "bad name",
				ok: false,
				ms: 10,
				errorReason: "invalid_tool_name",
			},
			{ id: "t2", name: "synapse-crm__create", input: {}, output: "validation error", ok: false, ms: 10 },
		]);
		expect(run.status).toBe("success");
		expect(run.error).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Aborted-run telemetry — the timeout/cancel path now RETURNS a result (not a
// throw) carrying the partial usage accumulated before the abort. Regression
// for the 0/0/0/0 "timeout" records: a run that did real work (even sent its
// email) before the wall clock killed it must report its real counters +
// conversationId, not zeros — otherwise cost monitoring and budget auto-disable
// are blind. runtime.executeTask honors its contract by returning
// `stopReason: "aborted"`; the executor classifies timeout-vs-cancel from its
// own cancellation flags.
// ---------------------------------------------------------------------------

describe("createDirectExecutor — aborted run preserves partial usage", () => {
	// Mirrors runtime.executeTask under signal-driven abort: wait for the
	// abort, then RETURN the work done so far tagged "aborted" instead of
	// throwing it away.
	function abortingTaskFn(): TaskFn {
		return async (req): Promise<TaskFnResult> => {
			await new Promise<void>((resolve) => {
				if (req.signal?.aborted) resolve();
				else req.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return {
				output: "",
				conversationId: "conv_partial",
				toolCalls: [
					{ id: "t1", name: "gmail__send_message", input: {}, output: "sent", ok: true, ms: 80 },
				],
				stopReason: "aborted",
				usage: { inputTokens: 4096, outputTokens: 512, iterations: 4 },
			};
		};
	}

	test("wall-clock timeout records status=timeout with the real counters and conversationId", async () => {
		const executor = createDirectExecutor(abortingTaskFn(), () => ({ workspaceId: "ws_test" }));
		const run = await executor(makeAutomation({ maxRunDurationMs: 30 }));

		expect(run.status).toBe("timeout");
		expect(run.inputTokens).toBe(4096);
		expect(run.outputTokens).toBe(512);
		expect(run.iterations).toBe(4);
		expect(run.toolCalls).toBe(1);
		expect(run.conversationId).toBe("conv_partial");
		expect(run.error).toMatch(/timed out after/);
		// "aborted" is not a valid persisted stopReason — normalized to "other".
		expect(run.stopReason).toBe("other");
	});

	test("external cancel records status=cancelled with the real counters", async () => {
		// Already-aborted external signal → executor sets externallyAborted and
		// aborts the run controller immediately; the timer never fires.
		const externalSignal = AbortSignal.abort();
		const executor = createDirectExecutor(abortingTaskFn(), () => ({ workspaceId: "ws_test" }));
		const run = await executor(makeAutomation({ maxRunDurationMs: 600_000 }), externalSignal);

		expect(run.status).toBe("cancelled");
		expect(run.inputTokens).toBe(4096);
		expect(run.outputTokens).toBe(512);
		expect(run.iterations).toBe(4);
		expect(run.conversationId).toBe("conv_partial");
		expect(run.error).toBe("Cancelled by user");
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
			makeDirectTaskFn(),
			() => ({ workspaceId: "ws_test", identity: { id: "u" } }),
		);
		const automation = makeAutomation({
			allowedTools: ["files__*", "automations__create"],
		});

		await expect(executor(automation)).rejects.toThrow(/allowedTools/);
	});

	test("refuses to run when allowedTools includes automations__update", async () => {
		const executor = createDirectExecutor(
			makeDirectTaskFn(),
			() => ({ workspaceId: "ws_test", identity: { id: "u" } }),
		);
		const automation = makeAutomation({
			allowedTools: ["automations__update"],
		});

		await expect(executor(automation)).rejects.toThrow(/allowedTools/);
	});

	test("permits non-recursive allowedTools", async () => {
		const executor = createDirectExecutor(
			makeDirectTaskFn(),
			() => ({ workspaceId: "ws_test", identity: { id: "u" } }),
		);
		const automation = makeAutomation({
			allowedTools: ["files__*", "skills__list", "conversations__search"],
		});

		const result = await executor(automation);
		expect(result.status).toBe("success");
	});

	test("forwards a combined signal into taskFn so timeouts cancel in-flight task work", async () => {
		// Regression: the old Promise.race pattern rejected at the timeout
		// but didn't propagate cancellation to the task fn. The task kept
		// running, finished cleanly minutes later, and the result was
		// silently discarded. Now the taskFn receives a signal that
		// aborts on the same timeout — so it can cooperatively stop.
		let receivedSignal: AbortSignal | undefined;
		let signalFiredDuringTask = false;

		const slowTaskFn: TaskFn = async (req) => {
			receivedSignal = req.signal;
			// Wait up to 500ms but bail on abort so the test runs fast.
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 500);
				req.signal?.addEventListener(
					"abort",
					() => {
						signalFiredDuringTask = true;
						clearTimeout(timer);
						resolve();
					},
					{ once: true },
				);
			});
			// On abort the task throws — matches engine.run behavior under
			// signal-driven cancellation.
			if (req.signal?.aborted) {
				throw new DOMException("The operation was aborted.", "AbortError");
			}
			return {
				output: "ok",
				conversationId: "conv_test",
				toolCalls: [],
				stopReason: "complete",
				usage: { inputTokens: 100, outputTokens: 50, iterations: 1 },
			};
		};

		const executor = createDirectExecutor(slowTaskFn, () => ({
			workspaceId: "ws_test",
		}));
		const automation = makeAutomation({ maxRunDurationMs: 50 });

		await expect(executor(automation)).rejects.toThrow(/timed out after/);
		expect(receivedSignal).toBeDefined();
		expect(signalFiredDuringTask).toBe(true);
	});

	test("external cancel propagates into taskFn signal as AbortError", async () => {
		// Symmetric to the timeout case: when the scheduler aborts the
		// run controller (manual cancel, scheduler.stop()), the taskFn's
		// signal must also fire so the in-flight engine work cancels.
		let taskSawAbort = false;
		const slowTaskFn: TaskFn = async (req) => {
			await new Promise<void>((resolve) => {
				req.signal?.addEventListener(
					"abort",
					() => {
						taskSawAbort = true;
						resolve();
					},
					{ once: true },
				);
				setTimeout(resolve, 5000);
			});
			throw new DOMException("The operation was aborted.", "AbortError");
		};

		const executor = createDirectExecutor(slowTaskFn, () => ({ workspaceId: "ws_test" }));
		const externalController = new AbortController();
		const automation = makeAutomation({ maxRunDurationMs: 10_000 });

		const runPromise = executor(automation, externalController.signal);
		// Give the task a tick to start, then cancel.
		await new Promise((r) => setTimeout(r, 10));
		externalController.abort();

		await expect(runPromise).rejects.toThrow();
		expect(taskSawAbort).toBe(true);
	});

	test("external-cancel wins the race when timeout fires concurrently — no false 'timeout' status", async () => {
		// Race regression: external abort + timeout firing in the same
		// tick. Without the `externallyAborted` flag, `timedOut` flips
		// true under both paths and the catch rewrites the error to
		// "timed out after Ns" — so the scheduler stamps `status:
		// "timeout"` on what was really a cancel. Narrow window, but
		// the whole point of the PR is honest status records.
		const taskFn: TaskFn = async (req) => {
			await new Promise<void>((resolve) => {
				req.signal?.addEventListener("abort", () => resolve(), { once: true });
				setTimeout(resolve, 5000);
			});
			throw new DOMException("The operation was aborted.", "AbortError");
		};

		const executor = createDirectExecutor(taskFn, () => ({ workspaceId: "ws_test" }));
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
