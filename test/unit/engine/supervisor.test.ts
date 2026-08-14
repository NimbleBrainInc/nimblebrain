import { describe, expect, it } from "bun:test";
import { createRunSupervisor } from "../../../src/engine/supervisor.ts";
import {
  INFRA_ERROR_META_KEY,
  NON_ADVANCING_META_KEY,
  type ToolCall,
  type ToolResult,
} from "../../../src/engine/types.ts";

function call(name: string, input: Record<string, unknown> = {}): ToolCall {
  return { id: `call-${Math.random().toString(36).slice(2, 8)}`, name, input };
}

function textResult(text: string, isError = false): ToolResult {
  return {
    content: [{ type: "text", text }],
    isError,
  };
}

/** The model-facing text of a result — what the synth directive actually says. */
function textOf(result: ToolResult): string {
  return (result.content[0] as { text: string }).text;
}

describe("supervisor — pass-through behavior", () => {
  it("passes through 5 distinct successful results without tripping", () => {
    const sup = createRunSupervisor();
    for (let i = 0; i < 5; i++) {
      const verdict = sup.observe(call("foo"), textResult(`distinct-${i}`));
      expect(verdict.type).toBe("pass");
    }
    expect(sup.snapshot().trippedTools).toEqual([]);
  });

  it("passes through varied errors (each different fingerprint resets counter)", () => {
    const sup = createRunSupervisor();
    const v1 = sup.observe(call("foo"), textResult("error A", true));
    const v2 = sup.observe(call("foo"), textResult("error B", true));
    const v3 = sup.observe(call("foo"), textResult("error C", true));
    expect(v1.type).toBe("pass");
    expect(v2.type).toBe("pass");
    expect(v3.type).toBe("pass");
  });

  it("treats success and error with same text as different fingerprints", () => {
    const sup = createRunSupervisor();
    const v1 = sup.observe(call("foo"), textResult("x", false));
    const v2 = sup.observe(call("foo"), textResult("x", true));
    const v3 = sup.observe(call("foo"), textResult("x", false));
    expect(v1.type).toBe("pass");
    expect(v2.type).toBe("pass");
    expect(v3.type).toBe("pass");
  });
});

describe("supervisor — trips on repeated identical results", () => {
  it("trips on 3rd identical error", () => {
    const sup = createRunSupervisor();
    const sameError = "Ran into an error: AxiosError 400";
    expect(sup.observe(call("foo"), textResult(sameError, true)).type).toBe("pass");
    expect(sup.observe(call("foo"), textResult(sameError, true)).type).toBe("pass");
    const v3 = sup.observe(call("foo"), textResult(sameError, true));
    expect(v3.type).toBe("synth");
    if (v3.type === "synth") {
      expect(v3.trippedTool).toBe("foo");
      expect(v3.replacement.isError).toBe(true);
      expect(v3.consecutiveRepeats).toBe(3);
      // Synth directive should mention the underlying error text so the
      // model can surface it to the user.
      const synthText = (v3.replacement.content[0] as { text: string }).text;
      expect(synthText).toContain(sameError);
      expect(synthText).toContain("foo");
      // Scoped to this tool, no universal directives that would rot in
      // conversation history across future runs.
      expect(synthText).toContain("has been disabled");
      expect(synthText).not.toContain("Do not call any tools");
      expect(synthText).not.toContain("End the run");
      expect(synthText).toContain("Other tools remain available");
      // And it must NOT advertise recovery. A tripped tool has just been
      // withheld from the model's toolset, so inviting a retry sends the model
      // hunting for a way to call something it can no longer see — the loop
      // this guard exists to end. Recovery is a property of the mechanism, not
      // advice to the model.
      expect(synthText).not.toContain("re-enable");
      expect(synthText).not.toContain("corrected call");
    }
  });

  it("trips on 3rd identical empty-success (catches pagination dead-ends)", () => {
    const sup = createRunSupervisor();
    const emptyPayload = '{"transactions":[],"page":{"nextPage":null}}';
    sup.observe(call("foo"), textResult(emptyPayload, false));
    sup.observe(call("foo"), textResult(emptyPayload, false));
    const v3 = sup.observe(call("foo"), textResult(emptyPayload, false));
    expect(v3.type).toBe("synth");
  });

  it("reports tripped tool in snapshot after a trip", () => {
    const sup = createRunSupervisor();
    const e = textResult("err", true);
    sup.observe(call("foo"), e);
    sup.observe(call("foo"), e);
    sup.observe(call("foo"), e);
    expect(sup.snapshot().trippedTools).toEqual(["foo"]);
  });
});

describe("supervisor — stickiness once tripped", () => {
  it("keeps emitting synth while the tool keeps failing", () => {
    const sup = createRunSupervisor();
    const e = textResult("err", true);
    sup.observe(call("foo"), e);
    sup.observe(call("foo"), e);
    sup.observe(call("foo"), e); // trips

    expect(sup.observe(call("foo"), e).type).toBe("synth");
    expect(sup.observe(call("foo"), textResult("a different error", true)).type).toBe("synth");
  });

  it("keeps the tool in trippedTools across subsequent calls", () => {
    const sup = createRunSupervisor();
    const e = textResult("err", true);
    sup.observe(call("foo"), e);
    sup.observe(call("foo"), e);
    sup.observe(call("foo"), e);

    sup.observe(call("foo"), e);
    expect(sup.snapshot().trippedTools).toEqual(["foo"]);
  });
});

describe("supervisor — recovery from a trip", () => {
  /** Trip `name` on three identical errors and assert it landed. */
  function trip(sup: ReturnType<typeof createRunSupervisor>, name = "foo") {
    const e = textResult("err", true);
    sup.observe(call(name), e);
    sup.observe(call(name), e);
    expect(sup.observe(call(name), e).type).toBe("synth");
  }

  it("recovers on an advancing success and passes the real result through", () => {
    const sup = createRunSupervisor();
    trip(sup);
    expect(sup.observe(call("foo"), textResult("success now")).type).toBe("pass");
  });

  it("drops the tool from trippedTools so the engine re-offers it", () => {
    const sup = createRunSupervisor();
    trip(sup);
    sup.observe(call("foo"), textResult("success now"));
    expect(sup.snapshot().trippedTools).toEqual([]);
  });

  it("does not recover on an error", () => {
    const sup = createRunSupervisor();
    trip(sup);
    expect(sup.observe(call("foo"), textResult("still broken", true)).type).toBe("synth");
  });

  it("does not recover on an infrastructure failure", () => {
    const sup = createRunSupervisor();
    trip(sup);
    const infra: ToolResult = {
      content: [{ type: "text", text: "connection reset" }],
      isError: true,
      _meta: { [INFRA_ERROR_META_KEY]: true },
    };
    expect(sup.observe(call("foo"), infra).type).toBe("synth");
    expect(sup.snapshot().trippedTools).toEqual(["foo"]);
  });

  it("does not recover on a result the tool flagged non-advancing", () => {
    const sup = createRunSupervisor();
    trip(sup);
    const stalled: ToolResult = {
      content: [{ type: "text", text: "no matches" }],
      _meta: { [NON_ADVANCING_META_KEY]: true },
    };
    expect(sup.observe(call("foo"), stalled).type).toBe("synth");
  });

  it("does not recover on a success repeating the content it tripped on", () => {
    // The pagination dead-end: identical empty-success payloads trip, and
    // returning that same payload again is not progress however often it comes.
    const sup = createRunSupervisor();
    const empty = textResult("[]");
    sup.observe(call("page", { cursor: 1 }), empty);
    sup.observe(call("page", { cursor: 1 }), empty);
    expect(sup.observe(call("page", { cursor: 1 }), empty).type).toBe("synth");

    expect(sup.observe(call("page", { cursor: 1 }), empty).type).toBe("synth");
  });

  it("does not let a varied input walk the empty-success trip open", () => {
    // The SUCCESS fingerprint folds in the canonicalized input, so comparing
    // fingerprints instead of CONTENT would call the next cursor "progress":
    // the trip would clear on the very same empty page, and every subsequent
    // cursor would be a fresh fingerprint that never re-trips — the dead-end
    // loop resuming with the guard disarmed, which is the failure mode the
    // guard exists for.
    const sup = createRunSupervisor();
    const empty = textResult("[]");
    for (const _ of [1, 2, 3]) sup.observe(call("page", { cursor: 1 }), empty);
    expect(sup.snapshot().trippedTools).toEqual(["page"]);

    for (const cursor of [2, 3, 4, 5, 6, 7, 8]) {
      expect(sup.observe(call("page", { cursor }), empty).type).toBe("synth");
    }
    expect(sup.snapshot().trippedTools).toEqual(["page"]);

    // A page that actually has rows on it is progress, and does recover.
    expect(sup.observe(call("page", { cursor: 9 }), textResult('["a"]')).type).toBe("pass");
    expect(sup.snapshot().trippedTools).toEqual([]);
  });

  it("stays armed after recovering — a fresh streak trips again", () => {
    const sup = createRunSupervisor();
    trip(sup);
    expect(sup.observe(call("foo"), textResult("success now")).type).toBe("pass");

    const e2 = textResult("broken again", true);
    sup.observe(call("foo"), e2);
    sup.observe(call("foo"), e2);
    expect(sup.observe(call("foo"), e2).type).toBe("synth");
    expect(sup.snapshot().trippedTools).toEqual(["foo"]);
  });

  it("lets a model that corrected its arguments finish the work", () => {
    // The motivating production run. The ERROR fingerprint ignores input, so
    // three calls carrying three DIFFERENT (differently wrong) argument shapes
    // collapse to one fingerprint and trip. The model then reads the validation
    // error, sends the right shape, and the call succeeds — that result must
    // reach the model, because the write really landed.
    const sup = createRunSupervisor();
    const validationError = textResult("Missing required argument: kind, summary", true);
    sup.observe(call("log", { contact: "a", type: "meeting" }), validationError);
    sup.observe(call("log", { contact: "b", type: "meeting" }), validationError);
    expect(sup.observe(call("log", { contact: "c", type: "meeting" }), validationError).type).toBe(
      "synth",
    );

    const corrected = sup.observe(
      call("log", { contact: "a", kind: "meeting", summary: "…" }),
      textResult('{"interaction":{"id":"ix_1"}}'),
    );
    expect(corrected.type).toBe("pass");

    // …and the remaining contacts go through as ordinary calls.
    for (const contact of ["b", "c", "d"]) {
      const v = sup.observe(
        call("log", { contact, kind: "meeting", summary: "…" }),
        textResult(`{"interaction":{"id":"ix_${contact}"}}`),
      );
      expect(v.type).toBe("pass");
    }
    expect(sup.snapshot().trippedTools).toEqual([]);
  });
});

describe("supervisor — counter reset on different fingerprint", () => {
  it("counter resets to 1 when fingerprint changes mid-run", () => {
    const sup = createRunSupervisor();
    sup.observe(call("foo"), textResult("A", true));
    sup.observe(call("foo"), textResult("A", true));
    // Different error — counter resets.
    sup.observe(call("foo"), textResult("B", true));
    // Same as B once more — counter at 2, not 3, no trip.
    const v4 = sup.observe(call("foo"), textResult("B", true));
    expect(v4.type).toBe("pass");
    // Third B — now trips.
    const v5 = sup.observe(call("foo"), textResult("B", true));
    expect(v5.type).toBe("synth");
  });
});

describe("supervisor — per-tool isolation", () => {
  it("trips on tool foo but leaves tool bar untouched", () => {
    const sup = createRunSupervisor();
    const e = textResult("err", true);
    sup.observe(call("foo"), e);
    sup.observe(call("foo"), e);
    sup.observe(call("foo"), e); // trips foo

    const verdictBar = sup.observe(call("bar"), e);
    expect(verdictBar.type).toBe("pass");

    const snap = sup.snapshot();
    expect(snap.trippedTools).toEqual(["foo"]);
  });

  it("interleaved calls to two tools maintain independent counters", () => {
    const sup = createRunSupervisor();
    const eF = textResult("foo err", true);
    const eB = textResult("bar err", true);
    // foo: 2× same error
    sup.observe(call("foo"), eF);
    sup.observe(call("foo"), eF);
    // bar: 1× same error
    sup.observe(call("bar"), eB);
    // foo: 3rd same error — should trip
    const v = sup.observe(call("foo"), eF);
    expect(v.type).toBe("synth");
    // bar still hasn't tripped
    const vb = sup.observe(call("bar"), eB);
    expect(vb.type).toBe("pass");
  });
});

describe("supervisor — configuration", () => {
  it("respects maxConsecutiveRepeats override", () => {
    const sup = createRunSupervisor({ maxConsecutiveRepeats: 2 });
    const e = textResult("err", true);
    expect(sup.observe(call("foo"), e).type).toBe("pass");
    const v2 = sup.observe(call("foo"), e);
    expect(v2.type).toBe("synth");
  });

  it("fingerprintTextCap collapses long differing payloads to same fingerprint when prefixes match", () => {
    const sup = createRunSupervisor({ fingerprintTextCap: 5 });
    // First 5 chars identical, suffixes differ — should count as same fingerprint
    sup.observe(call("foo"), textResult("HELLO-aaaaa", true));
    sup.observe(call("foo"), textResult("HELLO-bbbbb", true));
    const v3 = sup.observe(call("foo"), textResult("HELLO-ccccc", true));
    expect(v3.type).toBe("synth");
  });
});

describe("supervisor — snapshot", () => {
  it("reports tripped tools and call counts", () => {
    const sup = createRunSupervisor();
    const e = textResult("err", true);
    sup.observe(call("foo"), e);
    sup.observe(call("foo"), e);
    sup.observe(call("foo"), e);
    sup.observe(call("bar"), textResult("ok", false));

    const snap = sup.snapshot();
    expect(snap.trippedTools).toEqual(["foo"]);
    expect(snap.callCounts.foo).toBe(3);
    expect(snap.callCounts.bar).toBe(1);
  });
});

describe("supervisor — input-aware success fingerprinting", () => {
  // Success and error are different shapes of "stuck":
  //  - Success: distinct inputs producing the same payload is progress.
  //    The classic motivating case is `patch_source(edits=[...])`
  //    returning a structurally-uniform `{applied:true, compiled:true}`
  //    across distinct edits — must NOT trip.
  //  - Error: deterministic-rejection loops should trip whether or not
  //    the model rotates arg values between retries (documented failure
  //    mode), so error fingerprints stay input-agnostic.

  it("3 distinct successful inputs with identical output do NOT trip", () => {
    const sup = createRunSupervisor();
    const sameOutput = textResult('{"applied":true,"compiled":true,"reason":null}', false);
    // Three distinct patch_source-style calls, each returns the same
    // structurally-uniform success payload. Progress, not a loop.
    expect(sup.observe(call("patch_source", { find: "a", replace: "b" }), sameOutput).type).toBe(
      "pass",
    );
    expect(sup.observe(call("patch_source", { find: "c", replace: "d" }), sameOutput).type).toBe(
      "pass",
    );
    expect(sup.observe(call("patch_source", { find: "e", replace: "f" }), sameOutput).type).toBe(
      "pass",
    );
    expect(sup.snapshot().trippedTools).toEqual([]);
  });

  it("3 identical successful calls with identical output still trip", () => {
    // The genuinely-stuck case: same call (name + input) → same output,
    // repeated. Still a loop; still trips.
    const sup = createRunSupervisor();
    const sameInput = { find: "a", replace: "b" };
    const sameOutput = textResult('{"applied":true,"compiled":true}', false);
    expect(sup.observe(call("patch_source", sameInput), sameOutput).type).toBe("pass");
    expect(sup.observe(call("patch_source", sameInput), sameOutput).type).toBe("pass");
    const v3 = sup.observe(call("patch_source", sameInput), sameOutput);
    expect(v3.type).toBe("synth");
  });

  it("3 distinct erroring inputs with identical output STILL trip", () => {
    // The documented "deterministic-4xx with retry-with-tweaks" loop —
    // each call has different input but the same rejection text.
    // Errors are input-agnostic; this still trips.
    const sup = createRunSupervisor();
    const sameError = textResult("AxiosError 400: bad request", true);
    expect(sup.observe(call("foo", { attempt: 1, payload: "a" }), sameError).type).toBe("pass");
    expect(sup.observe(call("foo", { attempt: 2, payload: "b" }), sameError).type).toBe("pass");
    const v3 = sup.observe(call("foo", { attempt: 3, payload: "c" }), sameError);
    expect(v3.type).toBe("synth");
  });

  it("canonical input form: reordered object keys hash to the same success fingerprint", () => {
    // Object key insertion order varies across model providers and SDK
    // serializers; the supervisor must treat semantically identical
    // inputs as the same call.
    const sup = createRunSupervisor();
    const sameOutput = textResult('{"ok":true}', false);
    expect(sup.observe(call("foo", { a: 1, b: 2 }), sameOutput).type).toBe("pass");
    // Same semantic input with different key order.
    expect(sup.observe(call("foo", { b: 2, a: 1 }), sameOutput).type).toBe("pass");
    const v3 = sup.observe(call("foo", { a: 1, b: 2 }), sameOutput);
    expect(v3.type).toBe("synth");
  });

  it("varied successful inputs and outputs do not trip (baseline)", () => {
    const sup = createRunSupervisor();
    for (let i = 0; i < 5; i++) {
      const v = sup.observe(
        call("foo", { i }),
        textResult(`{"index":${i},"applied":true}`, false),
      );
      expect(v.type).toBe("pass");
    }
  });
});

describe("supervisor — non-advancing results", () => {
  const nonAdvancing = (text: string): ToolResult => ({
    content: [{ type: "text", text }],
    isError: false,
    _meta: { [NON_ADVANCING_META_KEY]: true },
  });

  /** One fruitless discovery search for `query`. */
  const miss = (sup: ReturnType<typeof createRunSupervisor>, query: string) =>
    sup.observe(call("nb__search", { query }), nonAdvancing(`No tools matched "${query}".`));

  it("three materially different queries leave the tool armed", () => {
    // The failure this prevents: `nb__search` is the only door to every
    // proxied tool, so disabling it three questions into a session where the
    // model does not yet know what exists answers "can this platform do X"
    // with "no" for the rest of the run.
    const sup = createRunSupervisor();
    expect(miss(sup, "memory").type).toBe("pass");
    expect(miss(sup, "notes").type).toBe("pass");
    expect(miss(sup, "instructions").type).toBe("pass");
    expect(sup.snapshot().trippedTools).toEqual([]);
  });

  it("trips on the 3rd identical query", () => {
    const sup = createRunSupervisor();
    expect(miss(sup, "memory").type).toBe("pass");
    expect(miss(sup, "memory").type).toBe("pass");
    const v3 = miss(sup, "memory");
    expect(v3.type).toBe("synth");
    if (v3.type === "synth") {
      expect(v3.trippedTool).toBe("nb__search");
      expect(v3.consecutiveRepeats).toBe(3);
    }
  });

  it("re-asking one question in different clothes is still a repeat", () => {
    // Case and whitespace are not a different question, and a model that
    // retries a dead end usually retries it lightly reworded.
    const sup = createRunSupervisor();
    expect(miss(sup, "memory").type).toBe("pass");
    expect(miss(sup, "Memory").type).toBe("pass");
    expect(miss(sup, "  memory  ").type).toBe("synth");
  });

  it("trips on the non-advancing budget once every question comes back empty", () => {
    // Varied queries no longer accumulate a streak, so the budget is what
    // bounds the flail: six fruitless calls is enough evidence that the
    // surface does not hold what is being looked for.
    const sup = createRunSupervisor();
    for (const q of ["a", "b", "c", "d", "e"]) {
      expect(miss(sup, q).type).toBe("pass");
    }
    const v6 = miss(sup, "f");
    expect(v6.type).toBe("synth");
    if (v6.type === "synth") {
      expect(v6.consecutiveRepeats).toBe(6);
    }
  });

  it("an advancing result clears the non-advancing budget", () => {
    const sup = createRunSupervisor();
    for (const q of ["a", "b", "c", "d", "e"]) {
      expect(miss(sup, q).type).toBe("pass");
    }
    // A real match advances — the tool demonstrably works, so the evidence
    // against it is spent.
    expect(
      sup.observe(call("nb__search", { query: "crm" }), textResult('Found 2 tool(s) for "crm"'))
        .type,
    ).toBe("pass");
    for (const q of ["g", "h", "i", "j", "k"]) {
      expect(miss(sup, q).type).toBe("pass");
    }
    expect(miss(sup, "l").type).toBe("synth");
  });

  it("an error between misses does NOT clear the budget", () => {
    // Only an advancing success is evidence the tool found something. If an
    // error reset the count, a tool interleaving fruitless searches with
    // errors whose text keeps changing would escape both guards — the ERROR
    // fingerprint only collapses on repeated text — and spend the run's whole
    // iteration budget flailing.
    const sup = createRunSupervisor();
    for (let i = 0; i < 5; i++) {
      expect(miss(sup, `q${i}`).type).toBe("pass");
      expect(
        sup.observe(call("nb__search", { query: `e${i}` }), textResult(`upstream error ${i}`, true))
          .type,
      ).toBe("pass");
    }
    // Six misses' worth of evidence has accumulated across the errors.
    expect(miss(sup, "q5").type).toBe("synth");
  });

  it("an infrastructure failure does not clear the budget either", () => {
    const sup = createRunSupervisor();
    for (let i = 0; i < 5; i++) {
      expect(miss(sup, `q${i}`).type).toBe("pass");
      expect(
        sup.observe(call("nb__search", { query: `e${i}` }), infraError("connection reset")).type,
      ).toBe("pass");
    }
    expect(miss(sup, "q5").type).toBe("synth");
  });

  it("the budget is configurable", () => {
    const sup = createRunSupervisor({ maxNonAdvancingCalls: 2 });
    expect(miss(sup, "a").type).toBe("pass");
    expect(miss(sup, "b").type).toBe("synth");
  });

  it("a tripped tool keeps reporting the count that tripped it", () => {
    // The live counters keep moving after a trip, so reading them on a later
    // call reported "made no progress 1 times in a row" for a tool disabled
    // at 6 — a number the model's own history contradicts. The count lands in
    // the directive text and in the recorded verdict.
    const sup = createRunSupervisor();
    for (const q of ["a", "b", "c", "d", "e"]) expect(miss(sup, q).type).toBe("pass");
    expect(miss(sup, "f").type).toBe("synth");

    const after = miss(sup, "g");
    expect(after.type).toBe("synth");
    if (after.type === "synth") {
      expect(after.consecutiveRepeats).toBe(6);
      expect(textOf(after.replacement)).toContain("6 times in a row");
      expect(textOf(after.replacement)).not.toContain("1 times in a row");
    }
  });

  it("preserves the input-aware success path: varied-input real work never trips", () => {
    const sup = createRunSupervisor();
    // patch_source: structurally-uniform success output, distinct inputs each
    // call — progress, not a loop. The non-advancing flag (absent here) must
    // not perturb the input-aware success fingerprint.
    const ok = (): ToolResult => textResult('{"applied":true,"compiled":true}');
    expect(
      sup.observe(call("patch_source", { edits: [{ find: "a", replace: "b" }] }), ok()).type,
    ).toBe("pass");
    expect(
      sup.observe(call("patch_source", { edits: [{ find: "c", replace: "d" }] }), ok()).type,
    ).toBe("pass");
    expect(
      sup.observe(call("patch_source", { edits: [{ find: "e", replace: "f" }] }), ok()).type,
    ).toBe("pass");
    expect(sup.snapshot().trippedTools).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Infrastructure errors are not evidence about the tool
// ---------------------------------------------------------------------------

const infraError = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
  _meta: { [INFRA_ERROR_META_KEY]: true },
});

describe("supervisor — infrastructure errors are excluded from the strike count", () => {
  it("never trips on repeated infrastructure failures, however many", () => {
    // The production shape: a batch of writes with DISTINCT arguments, all
    // refused by a gateway throttle. The ERROR fingerprint ignores input, so
    // these collapse to one fingerprint and used to trip on the 3rd — disabling
    // the tool for the rest of the run at exactly the moment the correct
    // response was to retry more slowly.
    const sup = createRunSupervisor();
    for (let i = 0; i < 25; i++) {
      const verdict = sup.observe(
        call("people__log_interaction", { contact_id: `ct_${i}` }),
        infraError('people call failed: {"error":"rate_limited"}'),
      );
      expect(verdict.type).toBe("pass");
    }
    expect(sup.snapshot().trippedTools).toEqual([]);
  });

  it("still counts the calls it skips", () => {
    // Excluded from the STRIKE count, not from telemetry — an operator looking
    // at a run needs to see the traffic that actually happened.
    const sup = createRunSupervisor();
    for (let i = 0; i < 4; i++) {
      sup.observe(call("svc__write"), infraError("connection closed"));
    }
    expect(sup.snapshot().callCounts["svc__write"]).toBe(4);
  });

  it("does not let an infrastructure error launder a genuine loop", () => {
    // A real deterministic rejection interrupted by a transport blip is still a
    // loop. The skip must not reset `consecutiveRepeats`, or a flailing tool
    // gets a free way to never trip.
    const sup = createRunSupervisor();
    expect(sup.observe(call("svc__op"), textResult("Invalid params", true)).type).toBe("pass");
    expect(sup.observe(call("svc__op"), textResult("Invalid params", true)).type).toBe("pass");
    // A blip in the middle — skipped, and NOT progress.
    expect(sup.observe(call("svc__op"), infraError("connection closed")).type).toBe("pass");
    // The third real rejection still trips.
    expect(sup.observe(call("svc__op"), textResult("Invalid params", true)).type).toBe("synth");
  });

  it("keeps a tool disabled once tripped, even if a later call fails on the transport", () => {
    // The already-tripped branch is checked BEFORE the infrastructure skip. A
    // tool that earned its disable must not be quietly re-enabled by a
    // subsequent infrastructural failure.
    const sup = createRunSupervisor();
    for (let i = 0; i < 3; i++) sup.observe(call("svc__op"), textResult("Method not found", true));
    expect(sup.snapshot().trippedTools).toEqual(["svc__op"]);
    expect(sup.observe(call("svc__op"), infraError("connection closed")).type).toBe("synth");
  });

  it("a plain error result with no marker still trips normally", () => {
    // The guard's actual job is untouched: a deterministic rejection the server
    // answered with is exactly what it should catch.
    const sup = createRunSupervisor();
    expect(sup.observe(call("svc__op"), textResult("Invalid params", true)).type).toBe("pass");
    expect(sup.observe(call("svc__op"), textResult("Invalid params", true)).type).toBe("pass");
    expect(sup.observe(call("svc__op"), textResult("Invalid params", true)).type).toBe("synth");
  });
});
