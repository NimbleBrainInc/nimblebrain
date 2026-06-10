import type { LanguageModelV3Message } from "@ai-sdk/provider";
import type { RecordedCall } from "./recording-model.ts";

/**
 * Token-shape harness: derive a deterministic, provider-agnostic fingerprint of
 * what the engine sent to the model on each iteration, and assert the cache
 * invariants the cost story depends on.
 *
 * Why this exists: the expensive token-usage regressions (cache-write thrash,
 * a system-prompt append busting the whole cached prefix, an anchor sliding off
 * the prior tail) are all properties of the REQUEST the engine builds, which is
 * fully deterministic given a fixed conversation. So they can be caught with a
 * scripted fake model and zero API calls. Realized cost (did the provider
 * actually honor the cache) is a separate, real-API concern — not this file.
 *
 * Token counts here are a stable proxy (~4 chars/token, matching the repo's own
 * estimate in `conversation/compaction.ts`), used to compare shapes across
 * steps, NOT to predict a bill. Absolute billed tokens are a real-provider
 * concern.
 */

const CHARS_PER_TOKEN = 4;

function estTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

function shortHash(s: string): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex").slice(0, 12);
}

/** TTL of a message's / tool's Anthropic cache breakpoint, or undefined. */
function ttlOf(x: { providerOptions?: Record<string, unknown> } | undefined): string | undefined {
  const anthropic = x?.providerOptions?.["anthropic"] as
    | { cacheControl?: { ttl?: string } }
    | undefined;
  return anthropic?.cacheControl?.ttl;
}

/** Underlying message content, stripped of cache markers (so we compare bytes, not breakpoints). */
function contentOnly(m: LanguageModelV3Message): string {
  const { providerOptions: _drop, ...rest } = m as LanguageModelV3Message & {
    providerOptions?: unknown;
  };
  return JSON.stringify(rest);
}

function systemTextOf(prompt: LanguageModelV3Message[]): string {
  const head = prompt[0];
  if (head && head.role === "system") {
    return typeof head.content === "string" ? head.content : JSON.stringify(head.content);
  }
  return "";
}

/**
 * Compact, human-scannable fingerprint of one model call. The `hash` fields are
 * the point: a system-prompt edit flips `system.hash`, surfacing as a reviewable
 * golden diff instead of a silent production regression.
 */
export interface StepShape {
  /** 1-based model-call index within the run. */
  step: number;
  /** Total messages in the prompt (incl. the leading system message). */
  messages: number;
  /** Estimated tokens across the whole prompt (proxy, not a bill). */
  promptTokens: number;
  system: { tokens: number; hash: string; ttl?: string };
  tools: { count: number; hash: string; breakpointIdx: number; breakpointTtl?: string };
  /** Body index (system excluded) of the rolling step-anchor breakpoint, or -1. */
  anchorIdx: number;
  /** Body index of the tail breakpoint. */
  tailIdx: number;
  anchorTtl?: string;
  tailTtl?: string;
  /**
   * Estimated tokens of the body messages AFTER the anchor — the per-step
   * delta that gets cache-WRITTEN each turn. With the rolling anchor working,
   * this stays ~flat (one step's worth) across the run. If it grows with turn
   * count, the prefix is being re-written every turn: thrash. `null` when there
   * is no anchor yet (first call).
   */
  deltaTokensAfterAnchor: number | null;
}

/** Derive the per-step shape table from recorded calls (used for golden snapshots). */
export function deriveShape(calls: RecordedCall[]): StepShape[] {
  return calls.map((call, idx) => {
    const { prompt } = call;
    const systemText = systemTextOf(prompt);
    const body = prompt.slice(1);
    const bodyTtls = body.map((m) => ttlOf(m));
    const tailIdx = body.length - 1;

    let anchorIdx = -1;
    for (let i = 0; i < body.length; i++) {
      if (bodyTtls[i] !== undefined && i !== tailIdx) anchorIdx = i;
    }

    const toolBreakpointIdx = call.tools.findIndex((t) => ttlOf(t) !== undefined);
    const toolsSig = `${call.tools.map((t) => t.name).join(",")}|bp=${toolBreakpointIdx}`;

    const promptTokens = prompt.reduce((n, m) => n + estTokens(contentOnly(m)), 0);
    const deltaTokensAfterAnchor =
      anchorIdx >= 0
        ? body.slice(anchorIdx + 1).reduce((n, m) => n + estTokens(contentOnly(m)), 0)
        : null;

    return {
      step: idx + 1,
      messages: prompt.length,
      promptTokens,
      system: {
        tokens: estTokens(systemText),
        hash: shortHash(systemText),
        ttl: ttlOf(prompt[0]),
      },
      tools: {
        count: call.tools.length,
        hash: shortHash(toolsSig),
        breakpointIdx: toolBreakpointIdx,
        breakpointTtl: toolBreakpointIdx >= 0 ? ttlOf(call.tools[toolBreakpointIdx]) : undefined,
      },
      anchorIdx,
      tailIdx,
      anchorTtl: anchorIdx >= 0 ? bodyTtls[anchorIdx] : undefined,
      tailTtl: tailIdx >= 0 ? bodyTtls[tailIdx] : undefined,
      deltaTokensAfterAnchor,
    };
  });
}

export interface ShapeViolation {
  invariant: string;
  step?: number;
  detail: string;
}

export type CacheMode = "anthropic" | "passthrough";

/**
 * Assert the cache-shape invariants over a recorded run. Returns the list of
 * violations (empty = healthy) so callers can `expect(violations).toEqual([])`
 * and get a readable failure naming the broken invariant and step.
 *
 * The invariants, and the regression each one fences:
 *  - system-stable     — the system block is byte-identical every step. Guards
 *                        the class of bug where a per-turn hint is appended to
 *                        the system prompt, busting its 1h breakpoint and the
 *                        entire prefix after it (see engine.ts final-step hint).
 *  - tools-stable      — the tools block doesn't churn (no trips in this scenario).
 *  - prefix-monotonic  — each call's body extends the prior call's body append-
 *                        only; no pre-anchor message is ever rewritten.
 *  - anchor-chaining   — (Anthropic) the anchor breakpoint of call N+1 lands on
 *                        the exact bytes that were call N's tail → exact-match
 *                        cache read of the whole prior prefix.
 *  - ttl-*             — (Anthropic) 1h on the stable system+tools prefix, 5m on
 *                        the rolling anchor+tail.
 *  - anti-thrash-bounded — (Anthropic) the post-anchor write delta stays ~flat
 *                        across the run instead of growing with turn count.
 *  - passthrough-no-cache — (non-Anthropic) no inline cache markers are emitted.
 */
export function checkInvariants(calls: RecordedCall[], mode: CacheMode): ShapeViolation[] {
  const v: ShapeViolation[] = [];
  if (calls.length === 0) {
    v.push({ invariant: "non-empty", detail: "no model calls were recorded" });
    return v;
  }
  const shapes = deriveShape(calls);

  // system-stable
  const sys0 = shapes[0]!.system.hash;
  for (const s of shapes) {
    if (s.system.hash !== sys0) {
      v.push({
        invariant: "system-stable",
        step: s.step,
        detail: `system hash ${s.system.hash} != first-call ${sys0}`,
      });
    }
  }

  // tools-stable
  const tools0 = shapes[0]!.tools.hash;
  for (const s of shapes) {
    if (s.tools.hash !== tools0) {
      v.push({ invariant: "tools-stable", step: s.step, detail: "tools block changed mid-run" });
    }
  }

  // prefix-monotonic
  for (let i = 1; i < calls.length; i++) {
    const prev = calls[i - 1]!.prompt.slice(1).map(contentOnly);
    const cur = calls[i]!.prompt.slice(1).map(contentOnly);
    for (let j = 0; j < prev.length; j++) {
      if (cur[j] !== prev[j]) {
        v.push({
          invariant: "prefix-monotonic",
          step: i + 1,
          detail: `body[${j}] was rewritten vs the prior call (prefix must be append-only)`,
        });
        break;
      }
    }
  }

  if (mode === "anthropic") {
    // anchor-chaining
    for (let i = 1; i < calls.length; i++) {
      const prevBody = calls[i - 1]!.prompt.slice(1);
      const curBody = calls[i]!.prompt.slice(1);
      const prevTail = contentOnly(prevBody[prevBody.length - 1]!);
      const a = shapes[i]!.anchorIdx;
      if (a < 0) {
        v.push({
          invariant: "anchor-chaining",
          step: i + 1,
          detail: "no anchor breakpoint on a continued call",
        });
        continue;
      }
      if (contentOnly(curBody[a]!) !== prevTail) {
        v.push({
          invariant: "anchor-chaining",
          step: i + 1,
          detail: "anchor content != prior call's tail (cache read will miss)",
        });
      }
    }

    // ttl tiering
    for (const s of shapes) {
      if (s.system.ttl !== "1h") {
        v.push({ invariant: "ttl-system-1h", step: s.step, detail: `system ttl=${s.system.ttl}` });
      }
      if (s.tools.breakpointIdx >= 0 && s.tools.breakpointTtl !== "1h") {
        v.push({
          invariant: "ttl-tools-1h",
          step: s.step,
          detail: `tools ttl=${s.tools.breakpointTtl}`,
        });
      }
      if (s.tailTtl !== "5m") {
        v.push({ invariant: "ttl-tail-5m", step: s.step, detail: `tail ttl=${s.tailTtl}` });
      }
      if (s.anchorIdx >= 0 && s.anchorTtl !== "5m") {
        v.push({ invariant: "ttl-anchor-5m", step: s.step, detail: `anchor ttl=${s.anchorTtl}` });
      }
    }

    // anti-thrash: post-anchor write delta must not grow with turn count
    const deltas = shapes
      .map((s) => s.deltaTokensAfterAnchor)
      .filter((d): d is number => d !== null);
    if (deltas.length >= 2) {
      const min = Math.min(...deltas);
      const max = Math.max(...deltas);
      // A uniform scenario yields exact equality; allow a small tolerance for
      // step-to-step byte jitter (e.g. tool-call id width).
      const tolerance = Math.max(2, Math.ceil(min * 0.1));
      if (max - min > tolerance) {
        v.push({
          invariant: "anti-thrash-bounded",
          detail: `post-anchor write delta grows across the run (min=${min}, max=${max} tokens): the prefix is being re-written each turn, not appended`,
        });
      }
    }
  } else {
    for (const s of shapes) {
      if (
        s.system.ttl !== undefined ||
        s.tailTtl !== undefined ||
        s.anchorTtl !== undefined ||
        s.tools.breakpointIdx >= 0
      ) {
        v.push({
          invariant: "passthrough-no-cache",
          step: s.step,
          detail: "inline cache markers were emitted for a non-Anthropic provider",
        });
      }
    }
  }

  return v;
}
