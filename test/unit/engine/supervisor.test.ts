import { describe, expect, it } from "bun:test";
import { createRunSupervisor } from "../../../src/engine/supervisor.ts";
import {
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
      // Scoped to this tool, past-tense, no universal directives that would
      // rot in conversation history across future runs.
      expect(synthText).toContain("disabled for the rest of this run");
      expect(synthText).not.toContain("Do not call any tools");
      expect(synthText).not.toContain("End the run");
      expect(synthText).toContain("Other tools remain available");
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
  it("keeps emitting synth even after a successful different call", () => {
    const sup = createRunSupervisor();
    const e = textResult("err", true);
    sup.observe(call("foo"), e);
    sup.observe(call("foo"), e);
    sup.observe(call("foo"), e); // trips

    const recovery = sup.observe(call("foo"), textResult("success now", false));
    expect(recovery.type).toBe("synth");
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

  it("trips after 3 non-advancing results even when input AND output both vary", () => {
    const sup = createRunSupervisor();
    // Mirrors the nb__search discovery loop: a fresh query each call and a
    // distinct "no match" string each time. The input-aware success and
    // content fingerprints would never collapse these — the `_meta`
    // non-advancing flag is what does.
    expect(
      sup.observe(call("nb__search", { query: "preview" }), nonAdvancing('No tools matched "preview".'))
        .type,
    ).toBe("pass");
    expect(
      sup.observe(
        call("nb__search", { query: "collateral" }),
        nonAdvancing('No tools matched "collateral".'),
      ).type,
    ).toBe("pass");
    const v3 = sup.observe(
      call("nb__search", { query: "document" }),
      nonAdvancing('No tools matched "document".'),
    );
    expect(v3.type).toBe("synth");
    if (v3.type === "synth") {
      expect(v3.trippedTool).toBe("nb__search");
      expect(v3.consecutiveRepeats).toBe(3);
    }
  });

  it("an advancing result between non-advancing ones resets the counter", () => {
    const sup = createRunSupervisor();
    expect(
      sup.observe(call("nb__search", { query: "a" }), nonAdvancing('No tools matched "a".')).type,
    ).toBe("pass");
    expect(
      sup.observe(call("nb__search", { query: "b" }), nonAdvancing('No tools matched "b".')).type,
    ).toBe("pass");
    // A real match advances — different fingerprint, resets the streak.
    expect(
      sup.observe(call("nb__search", { query: "crm" }), textResult('Found 2 tool(s) for "crm"')).type,
    ).toBe("pass");
    expect(
      sup.observe(call("nb__search", { query: "c" }), nonAdvancing('No tools matched "c".')).type,
    ).toBe("pass");
    expect(
      sup.observe(call("nb__search", { query: "d" }), nonAdvancing('No tools matched "d".')).type,
    ).toBe("pass");
    // Only the 3rd CONSECUTIVE non-advancing result trips.
    expect(
      sup.observe(call("nb__search", { query: "e" }), nonAdvancing('No tools matched "e".')).type,
    ).toBe("synth");
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
