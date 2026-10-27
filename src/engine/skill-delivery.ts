/**
 * Skills bound to tools: a run's delivery of their guidance, shared by every
 * place a model's tool call is dispatched (the engine loop, and the tool
 * projection an external agent calls through), so both deliver the same
 * guidance, hold the same calls, and leave the same record.
 *
 * Guidance is delivered ONCE into the conversation history, never into the
 * cached system prefix, before the call it governs runs. The first call to a
 * bound tool is held ({@link SkillDelivery.hold}) until the body has been read,
 * unless a promotion already delivered it; a call that runs anyway (a read its
 * server's default binding does not hold, a hook rename) gets the guidance
 * after it ({@link SkillDelivery.claimFor}). Each delivered body is recorded as
 * `connector.skill.injected`, from which replay places it after the tool
 * results of the iteration it was delivered in.
 */

import { toolMatches } from "../skills/select.ts";
import { MAX_SKILL_BODY_CHARS } from "../skills/truncate.ts";
import { textContent } from "./content-helpers.ts";
import type { ConnectorSkillInjectedPayload, SkillNotDeliveredPayload } from "./schemas/events.ts";
import {
  type ConnectorSkillCandidate,
  type EventSink,
  SKILL_GUIDANCE_PENDING,
  type ToolCall,
  type ToolResult,
} from "./types.ts";

/**
 * Most characters of skill guidance one delivery carries, whether a held call
 * or an iteration's drain: three bodies at the loader's per-skill limit. Skills
 * past it are recorded as `skill.not_delivered`. A hold names its left-out
 * skills in the held result, loadable with `nb__use_skill`; the drain makes its
 * left-out skills eligible again.
 */
export const MAX_HELD_GUIDANCE_CHARS = 3 * MAX_SKILL_BODY_CHARS;

/** A surfaced overlay whose body is still being fetched. */
interface PendingOverlayFetch {
  data: Omit<ConnectorSkillInjectedPayload, "skillBody">;
  body: Promise<string | null>;
  /** Left out by a hold's or the drain's size limit: settled without being delivered. */
  dropped?: boolean;
  /** Counted as delivered by some hold, so neither a later hold nor the drain's cap drops it. */
  kept?: boolean;
  /** The skill's priority (lower first), for ordering under the drain's cap. */
  priority: number;
}

export interface SkillDeliveryOptions {
  runId: string;
  candidates: ConnectorSkillCandidate[];
  /** Skills already delivered earlier in the conversation. */
  delivered: Iterable<string>;
  events: EventSink;
}

/**
 * The run's skill-delivery state: which bound skills have reached the model
 * (or are on their way), which are queued for this iteration's delivery, and
 * which have already held a call. One per run, shared by the promotion path,
 * the per-call hold, and the after-call delivery, so the three can never
 * disagree about what is delivered.
 */
export interface SkillDelivery {
  /**
   * Hold `call` when a skill bound to its tool has not reached the model yet:
   * the result the model sees instead of running it, or null to let it run.
   * The bound skills are claimed synchronously, before the first await, so a
   * parallel call to a tool they bind waits on the same fetches. The call is
   * held only when at least one body arrives; when none does, it runs, and
   * each missing body is recorded. Bodies past {@link MAX_HELD_GUIDANCE_CHARS}
   * are left out and named. A cancelled run throws here: the call neither
   * runs nor waits for its guidance.
   */
  hold(
    call: ToolCall,
    opts: { readOnly: boolean; signal?: AbortSignal },
  ): Promise<ToolResult | null>;
  /**
   * Claim every undelivered skill bound to `toolName` for this iteration's
   * delivery: for a promoted tool (its guidance lands ahead of any call it
   * makes), and for a call that ran without being held. Synchronous between
   * the check and the claim, so parallel calls cannot both claim one skill.
   */
  claimFor(toolName: string): void;
  /**
   * Settle this iteration's claims: record each body that arrived
   * (`connector.skill.injected`) and return it for delivery; record a body
   * that did not arrive (`skill.not_delivered`) and make its skill eligible
   * again. A claim a hold dropped for size is neither.
   *
   * One delivery carries at most {@link MAX_HELD_GUIDANCE_CHARS}, whichever
   * path claimed its skills: bodies a hold already counted first, then the
   * rest by priority. A body past the cap is recorded `capped` and made
   * eligible again, so a later hold or delivery still delivers it: the cap
   * bounds one delivery, it does not withhold guidance. The first body always
   * fits, so a delivery is never empty for size alone.
   */
  settle(): Promise<ConnectorSkillInjectedPayload[]>;
  /**
   * Record a skill an activation delivered (`nb__use_skill`), so the overlay
   * path never delivers it again this run. False when it was already
   * delivered, so the activation is not recorded twice.
   */
  activated(skillName: string): boolean;
  /**
   * A `beforeToolCall` hook renamed a call after its hold checked the name the
   * model sent: record each skill bound to the renamed tool that missed it.
   */
  renamedPastHold(toolName: string, readOnly: boolean): void;
}

export function createSkillDelivery(opts: SkillDeliveryOptions): SkillDelivery {
  const { runId, candidates, events } = opts;
  /** Delivered earlier in the conversation, or claimed in this run. */
  const injected = new Set(opts.delivered);
  /** Claimed this iteration, by name: what a same-message call waits on. Cleared at settle. */
  const queued = new Map<string, PendingOverlayFetch>();
  /** Every claim of this iteration, settled at once. */
  const fetches: PendingOverlayFetch[] = [];
  /** Skills that have held a call in this run. A skill holds at most once per run. */
  const held = new Set<string>();
  /** Left out of a hold by its size cap: not delivered, but not offered again this run. */
  const notIncluded = new Set<string>();

  const notDelivered = (
    toolName: string,
    skillName: string,
    reason: SkillNotDeliveredPayload["reason"],
  ) => {
    events.emit({ type: "skill.not_delivered", data: { runId, toolName, skillName, reason } });
  };

  /**
   * Claim one skill for this iteration's delivery: mark it delivered, start
   * fetching its body, and queue it, so a call in the same message waits on
   * the same fetch instead of running ahead of it. Synchronous.
   */
  const claim = (
    candidate: ConnectorSkillCandidate,
    toolName: string,
    heldToolCallId?: string,
  ): PendingOverlayFetch => {
    injected.add(candidate.name);
    const pending: PendingOverlayFetch = {
      data: {
        runId,
        toolName,
        skillName: candidate.name,
        scope: candidate.scope,
        ...(heldToolCallId !== undefined ? { heldToolCallId } : {}),
      },
      priority: candidate.priority ?? 50,
      body: candidate.loadBody
        ? candidate.loadBody().catch(() => null)
        : Promise.resolve(candidate.body || null),
    };
    fetches.push(pending);
    queued.set(candidate.name, pending);
    return pending;
  };

  /**
   * Skills bound to `toolName` whose guidance must reach the model before a
   * call runs, in delivery order. A skill qualifies when it is undelivered and
   * has not held a call this run, or when it is queued this iteration. A skill
   * bound only by its server's implicit whole-server default does not qualify
   * on a tool that server annotates read-only: the annotation is the server's
   * claim about itself, so it may waive only that server's own default.
   */
  const boundSkills = (toolName: string, readOnly: boolean): ConnectorSkillCandidate[] =>
    candidates
      .filter((c) => c.toolAffinity.some((p) => toolMatches(toolName, p)))
      .filter((c) => !(readOnly && c.implicitBinding))
      .filter((c) => queued.has(c.name) || (!injected.has(c.name) && !held.has(c.name)))
      .sort(
        (a, b) =>
          (a.priority ?? 50) - (b.priority ?? 50) ||
          (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      );

  return {
    async hold(call, { readOnly, signal }) {
      const bound = boundSkills(call.name, readOnly);
      if (bound.length === 0) return null;

      const claims = bound.map((c) => {
        const already = queued.get(c.name);
        if (already) return { name: c.name, claim: already };
        held.add(c.name);
        return { name: c.name, claim: claim(c, call.name, call.id) };
      });
      const bodies = await raceAbort(Promise.all(claims.map(({ claim }) => claim.body)), signal);
      throwIfAborted(signal);
      if (bodies === null) return null;

      const delivered: string[] = [];
      const left: string[] = [];
      let chars = 0;
      claims.forEach(({ name, claim }, i) => {
        const body = bodies[i];
        if (body === null || body === undefined || claim.dropped) return;
        if (!claim.kept && delivered.length > 0 && chars + body.length > MAX_HELD_GUIDANCE_CHARS) {
          claim.dropped = true;
          notIncluded.add(name);
          left.push(name);
          notDelivered(call.name, name, "capped");
          return;
        }
        claim.kept = true;
        chars += body.length;
        delivered.push(name);
      });
      if (delivered.length === 0) return null;
      return heldResult(call.name, delivered, left);
    },

    claimFor(toolName) {
      for (const candidate of candidates) {
        if (injected.has(candidate.name)) continue;
        if (!candidate.toolAffinity.some((p) => toolMatches(toolName, p))) continue;
        claim(candidate, toolName);
      }
    },

    async settle() {
      const claims = fetches
        .filter((c) => !c.dropped)
        .sort(
          (a, b) =>
            Number(Boolean(b.kept)) - Number(Boolean(a.kept)) ||
            a.priority - b.priority ||
            (a.data.skillName < b.data.skillName
              ? -1
              : a.data.skillName > b.data.skillName
                ? 1
                : 0),
        );
      fetches.length = 0;
      const deliveries: ConnectorSkillInjectedPayload[] = [];
      let chars = 0;
      for (const pending of claims) {
        const skillBody = await pending.body;
        const { toolName, skillName } = pending.data;
        if (skillBody !== null && !pending.kept && deliveries.length > 0) {
          if (chars + skillBody.length > MAX_HELD_GUIDANCE_CHARS) {
            pending.dropped = true;
            injected.delete(skillName);
            notDelivered(toolName, skillName, "capped");
            continue;
          }
        }
        if (skillBody === null) {
          injected.delete(skillName);
          notDelivered(toolName, skillName, "fetch_failed");
          continue;
        }
        const data = { ...pending.data, skillBody };
        events.emit({ type: "connector.skill.injected", data });
        deliveries.push(data);
        chars += skillBody.length;
      }
      queued.clear();
      return deliveries;
    },

    activated(skillName) {
      if (injected.has(skillName) && !notIncluded.has(skillName)) return false;
      injected.add(skillName);
      notIncluded.delete(skillName);
      return true;
    },

    renamedPastHold(toolName, readOnly) {
      for (const skill of boundSkills(toolName, readOnly)) {
        if (queued.has(skill.name)) continue;
        notDelivered(toolName, skill.name, "renamed_unheld");
      }
    },
  };
}

/**
 * The result a held call returns in place of running: an error, because
 * nothing ran, carrying {@link SKILL_GUIDANCE_PENDING} so task accounting can
 * tell it from a failure. The guidance follows it.
 */
function heldResult(toolName: string, delivered: string[], notIncluded: string[]): ToolResult {
  const left =
    notIncluded.length > 0
      ? ` Also bound to this tool but left out to keep this short: ${notIncluded.join(", ")}; load one with nb__use_skill if the job needs it.`
      : "";
  return {
    content: textContent(
      `Not run: ${toolName} is governed by guidance you have not read yet (${delivered.join(", ")}). ` +
        `It follows this result. Read it, then call ${toolName} again.${left}`,
    ),
    isError: true,
    structuredContent: {
      reason: SKILL_GUIDANCE_PENDING,
      skills: delivered,
      ...(notIncluded.length > 0 ? { notIncluded } : {}),
    },
  };
}

/** `work`'s value, or null as soon as `signal` aborts. */
async function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T | null> {
  if (!signal) return work;
  if (signal.aborted) return null;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted.", "AbortError");
  }
}
