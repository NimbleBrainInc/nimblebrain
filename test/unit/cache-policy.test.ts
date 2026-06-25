import { describe, expect, test } from "bun:test";
import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3Message,
} from "@ai-sdk/provider";
import { applyCachePolicy } from "../../src/model/cache-policy.ts";

// --- builders mirroring the engine's per-iteration append pattern ----------

function userMsg(text: string): LanguageModelV3Message {
  return { role: "user", content: [{ type: "text", text }] };
}

/** One assistant turn with `nCalls` tool-call blocks (a "step"). */
function assistantStep(turn: number, nCalls: number): LanguageModelV3Message {
  return {
    role: "assistant",
    content: [
      { type: "text", text: `step ${turn}` },
      ...Array.from({ length: nCalls }, (_, i) => ({
        type: "tool-call" as const,
        toolCallId: `t${turn}_${i}`,
        toolName: "search",
        input: { q: `${turn}-${i}` },
      })),
    ],
  };
}

function toolResult(turn: number, i: number): LanguageModelV3Message {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: `t${turn}_${i}`,
        toolName: "search",
        output: { type: "text", value: `result ${turn}-${i}` },
      },
    ],
  };
}

/** Append one full agentic step (assistant + its tool results) in place. */
function appendStep(history: LanguageModelV3Message[], turn: number, nCalls: number): void {
  history.push(assistantStep(turn, nCalls));
  for (let i = 0; i < nCalls; i++) history.push(toolResult(turn, i));
}

const TOOLS: LanguageModelV3FunctionTool[] = ["search", "fetch", "log"].map((name) => ({
  type: "function",
  name,
  description: `${name} tool`,
  inputSchema: { type: "object", properties: {} },
}));

function hasCache(m: { providerOptions?: Record<string, unknown> } | undefined): boolean {
  const anthropic = m?.providerOptions?.anthropic as { cacheControl?: unknown } | undefined;
  return Boolean(anthropic?.cacheControl);
}

function ttlOf(m: { providerOptions?: Record<string, unknown> } | undefined): string | undefined {
  const cc = (m?.providerOptions?.anthropic as { cacheControl?: { ttl?: string } } | undefined)
    ?.cacheControl;
  return cc?.ttl;
}

/** Indices into result.prompt (incl. the system message at 0) that carry a breakpoint. */
function breakpointIdxs(prompt: LanguageModelV3Message[]): number[] {
  return prompt.map((m, i) => (hasCache(m) ? i : -1)).filter((i) => i >= 0);
}

/** Strip cache annotations so we compare underlying content, not breakpoint markers. */
function contentOnly(m: LanguageModelV3Message): string {
  const { providerOptions: _drop, ...rest } = m as LanguageModelV3Message & {
    providerOptions?: unknown;
  };
  return JSON.stringify(rest);
}

// --- tests -----------------------------------------------------------------

describe("applyCachePolicy — Anthropic breakpoint placement", () => {
  test("places at most 4 breakpoints (system + tools + anchor + tail)", () => {
    const history = [userMsg("go")];
    appendStep(history, 0, 5);
    appendStep(history, 1, 5);
    const { prompt, tools } = applyCachePolicy({
      provider: "anthropic",
      systemPrompt: "sys",
      messages: history,
      tools: TOOLS,
    });
    const total = breakpointIdxs(prompt).length + tools.filter((t) => hasCache(t)).length;
    expect(total).toBeLessThanOrEqual(4);
  });

  test("system message and last tool both carry a breakpoint", () => {
    const { prompt, tools } = applyCachePolicy({
      provider: "anthropic",
      systemPrompt: "sys",
      messages: [userMsg("go")],
      tools: TOOLS,
    });
    expect(prompt[0]!.role).toBe("system");
    expect(hasCache(prompt[0])).toBe(true);
    expect(hasCache(tools[tools.length - 1])).toBe(true);
    expect(hasCache(tools[0])).toBe(false); // only the last tool
  });

  test("TTL is tiered: 1h on the stable system+tools, 5m on the rolling history", () => {
    const history = [userMsg("go")];
    appendStep(history, 0, 4);
    appendStep(history, 1, 4); // ≥2 steps so anchor and tail are distinct
    const { prompt, tools } = applyCachePolicy({
      provider: "anthropic",
      systemPrompt: "sys",
      messages: history,
      tools: TOOLS,
    });
    // stable prefix → 1h
    expect(ttlOf(prompt[0])).toBe("1h"); // system
    expect(ttlOf(tools[tools.length - 1])).toBe("1h"); // tools block
    // rolling history breakpoints → 5m
    const cachedMsgs = prompt.slice(1).filter((m) => hasCache(m));
    expect(cachedMsgs.length).toBeGreaterThanOrEqual(2); // anchor + tail
    for (const m of cachedMsgs) expect(ttlOf(m)).toBe("5m");
  });

  test("eagerToolCount moves the tools breakpoint to the last eager tool", () => {
    // TOOLS = [search, fetch, log]; mark only the first two eager (log is a
    // deferred/volatile tool appended after the cacheable prefix).
    const { tools } = applyCachePolicy({
      provider: "anthropic",
      systemPrompt: "sys",
      messages: [userMsg("hi")],
      tools: TOOLS,
      eagerToolCount: 2,
    });
    expect(hasCache(tools[1])).toBe(true); // last eager tool carries the breakpoint
    expect(ttlOf(tools[1])).toBe("1h");
    expect(hasCache(tools[2])).toBe(false); // the deferred tool must NOT
    expect(hasCache(tools[0])).toBe(false);
  });

  test("eagerToolCount omitted ⇒ breakpoint on the last tool (unchanged)", () => {
    const { tools } = applyCachePolicy({
      provider: "anthropic",
      systemPrompt: "sys",
      messages: [userMsg("hi")],
      tools: TOOLS,
    });
    expect(hasCache(tools[tools.length - 1])).toBe(true);
    expect(hasCache(tools[0])).toBe(false);
  });

  test("eagerToolCount 0 ⇒ no tools breakpoint", () => {
    const { tools } = applyCachePolicy({
      provider: "anthropic",
      systemPrompt: "sys",
      messages: [userMsg("hi")],
      tools: TOOLS,
      eagerToolCount: 0,
    });
    expect(tools.some((t) => hasCache(t))).toBe(false);
  });

  test("eagerToolCount above tools.length clamps to the last tool (no lost 1h anchor)", () => {
    const { tools } = applyCachePolicy({
      provider: "anthropic",
      systemPrompt: "sys",
      messages: [userMsg("hi")],
      tools: TOOLS,
      eagerToolCount: 99, // > tools.length — must clamp, not drop the breakpoint
    });
    expect(hasCache(tools[tools.length - 1])).toBe(true);
    expect(tools.filter((t) => hasCache(t)).length).toBe(1);
  });

  test("tail breakpoint is on the last message", () => {
    const history = [userMsg("go")];
    appendStep(history, 0, 4);
    const { prompt } = applyCachePolicy({
      provider: "anthropic",
      systemPrompt: "sys",
      messages: history,
      tools: TOOLS,
    });
    expect(hasCache(prompt[prompt.length - 1])).toBe(true);
  });

  test("first iteration (no assistant yet) places only tail, not an anchor", () => {
    const { prompt } = applyCachePolicy({
      provider: "anthropic",
      systemPrompt: "sys",
      messages: [userMsg("go")],
      tools: TOOLS,
    });
    // prompt = [system, user]; only system + user(tail) cached, no separate anchor.
    const msgBreakpoints = breakpointIdxs(prompt).filter((i) => i > 0);
    expect(msgBreakpoints).toEqual([1]);
  });
});

describe("applyCachePolicy — the chaining invariant (cache correctness)", () => {
  // The load-bearing property: the anchor breakpoint on iteration N+1 must land
  // EXACTLY on the message that was the tail of iteration N, with identical
  // bytes. That is what gives Anthropic an exact-match cache read of the whole
  // prior prefix instead of a full re-write.
  test("anchor of each call == tail of the previous call (same index, same content)", () => {
    const history = [userMsg("go")];
    let prevTailContent: string | null = null;
    let prevTailIdx = -1;

    for (let turn = 0; turn < 6; turn++) {
      appendStep(history, turn, 7); // fat steps (7 tool calls) — exceed the ~20-block window
      const { prompt } = applyCachePolicy({
        provider: "anthropic",
        systemPrompt: "sys",
        messages: [...history],
        tools: TOOLS,
      });
      // prompt[0] is system; message indices are offset by 1.
      const msgs = prompt.slice(1);
      const cachedMsgIdxs = msgs.map((m, i) => (hasCache(m) ? i : -1)).filter((i) => i >= 0);
      const tailIdx = msgs.length - 1;
      const anchorIdx = cachedMsgIdxs.find((i) => i !== tailIdx) ?? -1;

      if (prevTailContent !== null) {
        expect(anchorIdx).toBeGreaterThanOrEqual(0);
        // same position as the previous call's tail...
        expect(anchorIdx).toBe(prevTailIdx);
        // ...and byte-identical underlying content (an exact cache match).
        expect(contentOnly(msgs[anchorIdx]!)).toBe(prevTailContent);
      }
      prevTailIdx = tailIdx;
      prevTailContent = contentOnly(msgs[tailIdx]!);
    }
  });

  test("length-continuation (lone assistant append) still anchors on the prior tail", () => {
    // The engine's length-continuation path (engine.ts) appends a SINGLE
    // assistant message — its partial text — with no tool results, then
    // re-calls. This is the one append pattern the tool-step builders above
    // don't exercise, yet the whole savings story depends on it preserving the
    // invariant: because exactly one assistant is appended, the message before
    // the new last assistant is still precisely the prior call's tail. A
    // regression here (e.g. appending two messages, or trailing non-assistant
    // content) would silently slide the anchor off and bust the cache with no
    // behavior change to notice it.
    const history = [userMsg("go")];
    appendStep(history, 0, 3); // one normal tool step to seed a real prefix

    const anchorOf = (msgs: LanguageModelV3Message[]): number => {
      const { prompt } = applyCachePolicy({
        provider: "anthropic",
        systemPrompt: "sys",
        messages: msgs,
        tools: TOOLS,
      });
      const body = prompt.slice(1); // drop system
      const tailIdx = body.length - 1;
      const cached = body.map((m, i) => (hasCache(m) ? i : -1)).filter((i) => i >= 0);
      return cached.find((i) => i !== tailIdx) ?? -1;
    };

    // Two back-to-back continuations: each appends only a partial assistant.
    for (let cont = 0; cont < 2; cont++) {
      const prevTailContent = contentOnly(history[history.length - 1]!);
      const prevTailIdx = history.length - 1;
      history.push({ role: "assistant", content: [{ type: "text", text: `partial ${cont}` }] });

      const anchorIdx = anchorOf([...history]);
      expect(anchorIdx).toBe(prevTailIdx);
      expect(contentOnly(history[anchorIdx]!)).toBe(prevTailContent);
    }
  });

  test("prefix-monotonicity: content up to the anchor is a stable prefix across turns", () => {
    const history = [userMsg("go")];
    let prevPrefix: string[] = [];
    for (let turn = 0; turn < 6; turn++) {
      appendStep(history, turn, 4);
      const msgs = [...history];
      // underlying content (ignoring rolling cache markers) must be append-only
      const prefix = msgs.map(contentOnly);
      for (let i = 0; i < prevPrefix.length; i++) {
        expect(prefix[i]).toBe(prevPrefix[i]); // earlier messages never change
      }
      prevPrefix = prefix;
    }
  });
});

describe("applyCachePolicy — multi-model passthrough", () => {
  test("non-Anthropic providers get the system message but no cache control", () => {
    const history = [userMsg("go")];
    appendStep(history, 0, 3);
    for (const provider of ["openai", "google", "unknown-provider"]) {
      const { prompt, tools } = applyCachePolicy({
        provider,
        systemPrompt: "sys",
        messages: history,
        tools: TOOLS,
      });
      expect(prompt[0]!.role).toBe("system");
      expect(breakpointIdxs(prompt)).toEqual([]); // nothing annotated
      expect(tools.some((t) => hasCache(t))).toBe(false);
    }
  });

  test("passthrough preserves message content unchanged", () => {
    const history = [userMsg("go"), ...[]];
    appendStep(history, 0, 2);
    const { prompt } = applyCachePolicy({
      provider: "openai",
      systemPrompt: "sys",
      messages: history,
      tools: TOOLS,
    });
    expect(prompt.slice(1).map(contentOnly)).toEqual(history.map(contentOnly));
  });
});

describe("applyCachePolicy — edge cases", () => {
  test("empty message history (Anthropic) annotates only system", () => {
    const { prompt } = applyCachePolicy({
      provider: "anthropic",
      systemPrompt: "sys",
      messages: [],
      tools: TOOLS,
    });
    expect(prompt).toHaveLength(1);
    expect(hasCache(prompt[0])).toBe(true);
  });

  test("no tools: no crash, system + message breakpoints still placed", () => {
    const { prompt, tools } = applyCachePolicy({
      provider: "anthropic",
      systemPrompt: "sys",
      messages: [userMsg("hi")],
      tools: [],
    });
    expect(tools).toEqual([]);
    expect(hasCache(prompt[0])).toBe(true);
  });
});
