/**
 * The skill-load ledger — one read model over every way a skill reaches the
 * model.
 *
 * Three events record a skill loading, and they are not three spellings of one
 * fact. Each carries a different body-of-record and drives a different
 * reconstruction, which is why they stay three events on the write side:
 *
 *   `skills.loaded`             composed into the system prompt. Telemetry
 *                               only — reconstruction ignores it. Carries an
 *                               array of skills with its own per-entry
 *                               `loadedBy` (`always` / `tool_affinity` /
 *                               `trigger`).
 *   `connector.skill.injected`  surface-once overlay. The event CARRIES the
 *                               body, because reconstruction synthesizes a
 *                               message from it.
 *   `skill.activated`           catalog activation. The event carries NO body
 *                               — it rides `tool.done` — so reconstruction
 *                               only stamps a dedup marker on the tool message
 *                               named by `toolCallId`.
 *
 * Collapsing them into one event would not remove that three-way split; it
 * would move it behind a discriminator the reconstructor still switches on,
 * and put a body in a record that does not own one. What was actually missing
 * is a unified *read*. This module is that read: it projects all three onto
 * one row shape with one `loadedBy` vocabulary, so "how did this skill get
 * here?" is answerable in one place instead of three, and a channel that never
 * fires is a visible zero rather than silence.
 */

import type {
  ConnectorSkillInjectedEvent,
  ConversationEvent,
  SkillActivatedEvent,
  SkillsLoadedEvent,
} from "../conversation/types.ts";
import { skillDisplayName } from "./display-name.ts";
import { approxTokens } from "./tokens.ts";

/**
 * How a skill reached the model, across every channel.
 *
 * The first three come from a `skills.loaded` entry's own `loadedBy` and name
 * the *selection* that put it in the prompt. The last two are whole channels:
 * `tool_use` is the surface-once overlay firing on a matching tool call,
 * `activation` is the model asking for a catalog entry by name.
 *
 * Deliberately has no `forced` member. The design reserves a
 * catalog-activation forcing path (the harness auto-activating on a matched
 * phrase) but nothing emits it, and a vocabulary value no emitter produces
 * reads as coverage that does not exist.
 */
export type SkillLoadedBy = "always" | "tool_affinity" | "trigger" | "tool_use" | "activation";

/** One skill reaching the model once. */
export interface SkillLoadRow {
  ts: string;
  conv_id: string;
  /**
   * Absent on `tool_use`: `connector.skill.injected` records no run id (it is
   * emitted at most once per conversation, not per run).
   */
  run_id?: string;
  /**
   * The skill's display name — the thing a human filters on.
   *
   * Resolved through {@link skillDisplayName} for `skills.loaded`, which is
   * what makes one skill read as one identity across channels: entries
   * predating the `name` field carry only an id, while the overlay and
   * activation records carry a `skillName` that is already display-shaped.
   * Deriving it here instead would split a legacy `/skills/billing.md` from
   * the `billing` its overlay records, in the very comparison this ledger
   * exists to make.
   */
  skill: string;
  /** Stable id, when the record carries one (`skills.loaded` only). */
  skill_id?: string;
  loaded_by: SkillLoadedBy;
  /** Approximate tokens delivered. 0 where the record does not measure it. */
  tokens: number;
  /** `org` / `workspace` / `user` / `bundle` / `connector`. */
  scope?: string;
  /** MCP server that published the skill, when one did. */
  connector?: string;
  /** The tool call that triggered a `tool_use` load. */
  tool_name?: string;
}

/**
 * Project one conversation's raw events onto the ledger, oldest first.
 *
 * A `skills.loaded` event fans out to one row per skill it composed — the
 * event is run-shaped, the ledger is skill-shaped, because every question
 * worth asking ("was this skill ever loaded", "how often does activation beat
 * tool_use") is per-skill.
 */
export function projectSkillLoads(convId: string, events: ConversationEvent[]): SkillLoadRow[] {
  const rows: SkillLoadRow[] = [];

  for (const ev of events) {
    switch (ev.type) {
      case "skills.loaded": {
        const e = ev as SkillsLoadedEvent;
        for (const s of e.skills) {
          rows.push({
            ts: e.ts,
            conv_id: convId,
            run_id: e.runId,
            skill: skillDisplayName(s),
            skill_id: s.id,
            loaded_by: s.loadedBy,
            tokens: s.tokens,
            scope: s.scope,
            ...(s.connector ? { connector: s.connector } : {}),
          });
        }
        break;
      }
      case "connector.skill.injected": {
        const e = ev as ConnectorSkillInjectedEvent;
        rows.push({
          ts: e.ts,
          conv_id: convId,
          skill: e.skillName,
          loaded_by: "tool_use",
          // The overlay body IS the delivery, so its size is the cost. The
          // event records no token count, so measure the body it carries —
          // through the same estimator `skills.loaded` counts with, so the
          // two channels' token columns are comparable.
          tokens: approxTokens(e.skillBody),
          scope: e.scope,
          tool_name: e.toolName,
        });
        break;
      }
      case "skill.activated": {
        const e = ev as SkillActivatedEvent;
        rows.push({
          ts: e.ts,
          conv_id: convId,
          run_id: e.runId,
          skill: e.skillName,
          loaded_by: "activation",
          tokens: e.tokens,
          scope: e.scope,
        });
        break;
      }
    }
  }

  return rows;
}
