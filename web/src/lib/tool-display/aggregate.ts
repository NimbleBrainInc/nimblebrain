/**
 * Aggregator — collapse N `ToolDescription`s into one `GroupDescription`
 * that a chip head can render directly.
 *
 * Pure function. Deterministic. Never fails — every input produces some
 * description so the UI can always render *something* sensible.
 *
 * Field rules:
 *
 *   - `verb`: majority verb across the group. If a single verb covers
 *     more than half the calls it wins; otherwise we surface a neutral
 *     fallback rather than misclaim the action.
 *   - `object`: only when every non-null value agrees AND we picked a
 *     real verb. A fallback verb pinned to a real object reads as
 *     nonsense ("Worked manage tools") — the verb already admits we
 *     don't know what happened; pairing it with an object pretends we
 *     do. When the verb is the fallback, object is null.
 *   - `subject`: only when every non-null value agrees. Always allowed,
 *     even with the fallback verb — the subject comes from the user's
 *     input and is true regardless of which tools ran.
 *   - `totalMs`: sum of known durations; `null` when none are known.
 *   - `tone`: any running → running; else the LAST call's tone. Earlier
 *     errors followed by a later success are the natural shape of agentic
 *     recovery — the model tried something, it failed, it adjusted, it
 *     succeeded. Escalating the chip head to "error" in that case trains
 *     the user to ignore the red icon when it does appear. The per-call
 *     rows in the chip body still show their own tones, so the user can
 *     still see what failed by expanding.
 *
 * Scope: this is Layer 1 of the tool-display aggregation stack. It does
 * NOT understand verb synonymy (that's Layer 2, a future taxonomy) and
 * has no plugin/registry hook (that's Layer 3, deferred until a bundle
 * actually needs it). Resist adding either here.
 */

import type { Tone, ToolDescription } from "./types.ts";
import { PRESENT_TENSE } from "./verbs.ts";

/** Verb shown when no single verb covers a majority of the group. */
const MAJORITY_FALLBACK = "Worked";

/** Summary of a group of tool calls, ready for a chip head to render. */
export interface GroupDescription {
  /** Past-tense verb — majority verb if >50%, else the neutral fallback. */
  verb: string;
  /** Present-progressive form (e.g. "Searching") for the running state. */
  verbPresent: string;
  /** Inferred object when every non-null `object` agrees; null otherwise. */
  object: string | null;
  /** Headline subject when every non-null `headSubject` agrees; null otherwise. */
  subject: string | null;
  /** Total number of calls in the group. */
  count: number;
  /** Sum of per-call durations in ms, when any are known. */
  totalMs: number | null;
  /** Aggregate tone: running > error > ok. */
  tone: Tone;
}

export function aggregateGroup(descriptions: ReadonlyArray<ToolDescription>): GroupDescription {
  const verb = majorityVerb(descriptions);
  const verbIsFallback = verb === MAJORITY_FALLBACK && descriptions.length > 1;
  return {
    verb,
    verbPresent: PRESENT_TENSE[verb] ?? verb,
    object: verbIsFallback ? null : agreedField(descriptions, (d) => d.object),
    subject: agreedField(descriptions, (d) => d.headSubject),
    count: descriptions.length,
    totalMs: sumDurations(descriptions),
    tone: aggregateTone(descriptions),
  };
}

/**
 * Pick the verb shared by more than half the calls; fall back to a
 * neutral word when no verb dominates. The strict majority threshold
 * keeps us from labeling a 3-way split with whichever verb happens to
 * sort last.
 */
function majorityVerb(descriptions: ReadonlyArray<ToolDescription>): string {
  if (descriptions.length === 0) return MAJORITY_FALLBACK;
  if (descriptions.length === 1) return descriptions[0].verb;
  const counts = new Map<string, number>();
  for (const d of descriptions) counts.set(d.verb, (counts.get(d.verb) ?? 0) + 1);
  const threshold = descriptions.length / 2;
  for (const [verb, n] of counts) {
    if (n > threshold) return verb;
  }
  return MAJORITY_FALLBACK;
}

/**
 * Return the field's value only when every non-null value across the
 * group agrees on it. Mixed values resolve to `null`. Tolerates partial
 * coverage: 2 of 3 calls with subject "news" + 1 with null still shows
 * "news"; "news" + "weather" + null shows null.
 */
function agreedField(
  descriptions: ReadonlyArray<ToolDescription>,
  pick: (d: ToolDescription) => string | null,
): string | null {
  const seen = new Set<string>();
  for (const d of descriptions) {
    const v = pick(d);
    if (v) seen.add(v);
  }
  return seen.size === 1 ? [...seen][0] : null;
}

function sumDurations(descriptions: ReadonlyArray<ToolDescription>): number | null {
  let total: number | null = null;
  for (const d of descriptions) {
    if (typeof d.durationMs === "number") total = (total ?? 0) + d.durationMs;
  }
  return total;
}

function aggregateTone(descriptions: ReadonlyArray<ToolDescription>): Tone {
  // Running takes precedence — anything in flight makes the group in flight.
  for (const d of descriptions) {
    if (d.tone === "running") return "running";
  }
  // Otherwise the group's terminal outcome is the LAST call's tone.
  // Recovery (error → … → success) reads as success; failure-without-
  // recovery (… → error) reads as error.
  if (descriptions.length === 0) return "ok";
  return descriptions[descriptions.length - 1].tone;
}
