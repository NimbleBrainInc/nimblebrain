// ---------------------------------------------------------------------------
// ledgerChanges — which turns announce their equipment.
//
// The sequences exercised here are the ones that actually occur: a survey of 95
// conversations found 108 rendered ledger lines, 60 of them byte-identical to
// the line directly above, exactly one mid-conversation change, and zero
// transitions from some skills back to none.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import type { LedgerSkill, SkillsLoadedContext } from "../hooks/chat-store";
import type { ChatMessage } from "../hooks/useChat";
import { ledgerChanges } from "../lib/ledger-changes";

function skill(name: string, loadedBy: LedgerSkill["loadedBy"]): LedgerSkill {
  return {
    id: `skills/${name}.md`,
    name,
    scope: "workspace" as const,
    tokens: 100,
    loadedBy,
    reason: loadedBy === "always" ? "always-on" : `trigger matched "${name}"`,
  };
}

/** A turn's equipment: skills that loaded for a reason this turn. */
function ctx(...names: string[]): SkillsLoadedContext {
  return {
    skills: names.map((name) => skill(name, "trigger")),
    totalTokens: names.length * 100,
  };
}

/** The same, with a standing always-on skill riding along in the payload. */
function withAlwaysOn(base: SkillsLoadedContext, name: string): SkillsLoadedContext {
  return {
    skills: [...base.skills, skill(name, "always")],
    totalTokens: base.totalTokens + 100,
  };
}

function turns(...loads: (SkillsLoadedContext | undefined)[]): ChatMessage[] {
  return loads.flatMap((skills) => [
    { role: "user", content: "q" } as ChatMessage,
    { role: "assistant", content: "a", ...(skills ? { skillsLoaded: skills } : {}) } as ChatMessage,
  ]);
}

/** The payloads actually handed to LedgerLine, assistant turns only. */
function announced(messages: ChatMessage[]): (string[] | undefined)[] {
  return ledgerChanges(messages)
    .filter((_, i) => messages[i]!.role === "assistant")
    .map((c) => c?.skills.map((s) => s.name));
}

describe("ledgerChanges", () => {
  test("an unchanged set is announced once, on the turn it arrives", () => {
    const A = ctx("house-style", "review-discipline");
    expect(announced(turns(A, A, A, A))).toEqual([
      ["house-style", "review-discipline"],
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("a set that changes mid-conversation is announced again", () => {
    // The one real transition in the survey: a connector installed mid-thread.
    const one = ctx("test");
    const seven = ctx("test", "orientation", "writing");
    expect(announced(turns(one, seven, seven))).toEqual([
      ["test"],
      ["test", "orientation", "writing"],
      undefined,
    ]);
  });

  test("skills arriving after empty turns are announced", () => {
    const A = ctx("house-style");
    expect(announced(turns(undefined, undefined, A, A))).toEqual([
      undefined,
      undefined,
      ["house-style"],
      undefined,
    ]);
  });

  test("equipment that goes away and returns is announced again", () => {
    // Not observed in the survey, but the rule must not swallow it: silence has
    // to mean "nothing new", and a set returning after a gap IS new.
    const A = ctx("house-style");
    expect(announced(turns(A, undefined, A))).toEqual([
      ["house-style"],
      undefined,
      ["house-style"],
    ]);
  });

  test("reordering the same skills is not a change", () => {
    // Composition order is an implementation detail of pool assembly; the reader
    // sees a count and a drawer, neither of which reordering alters.
    const forward = ctx("a", "b", "c");
    const shuffled: SkillsLoadedContext = {
      skills: [forward.skills[2]!, forward.skills[0]!, forward.skills[1]!],
      totalTokens: forward.totalTokens,
    };
    expect(announced(turns(forward, shuffled))).toEqual([["a", "b", "c"], undefined]);
  });

  test("a turn equipped only by always-on skills is silent", () => {
    // An always-on skill is standing workspace configuration: equipped before
    // the turn had a subject, so it reports nothing about this one.
    const standing = withAlwaysOn({ skills: [], totalTokens: 0 }, "operating-model");
    expect(announced(turns(standing, standing))).toEqual([undefined, undefined]);
  });

  test("an always-on skill riding along is not the change", () => {
    // The shape that made the line repeat: a triggered skill comes and goes
    // while the always-on one stays. Only the arrival and the next real change
    // speak; the turn carrying the standing skill alone stays quiet.
    const standing = withAlwaysOn({ skills: [], totalTokens: 0 }, "operating-model");
    const researching = withAlwaysOn(ctx("signal-research"), "operating-model");
    expect(announced(turns(standing, researching, researching, standing))).toEqual([
      undefined,
      ["signal-research", "operating-model"],
      undefined,
      undefined,
    ]);
  });

  test("same skills with a different reason is a change", () => {
    // The drawer prints `reason` verbatim, so a skill that loaded for a new
    // reason renders differently and has something to say.
    const affinity = ctx("docs-guide");
    const triggered: SkillsLoadedContext = {
      skills: [{ ...affinity.skills[0]!, loadedBy: "tool_affinity", reason: "tool docs__search" }],
      totalTokens: affinity.totalTokens,
    };
    expect(announced(turns(affinity, triggered))).toEqual([["docs-guide"], ["docs-guide"]]);
  });

  test("user turns never carry a line, and never break the comparison", () => {
    const A = ctx("house-style");
    const messages = turns(A, A);
    const rows = ledgerChanges(messages);
    expect(rows.filter((_, i) => messages[i]!.role === "user")).toEqual([undefined, undefined]);
    expect(rows.filter(Boolean)).toHaveLength(1);
  });
});
