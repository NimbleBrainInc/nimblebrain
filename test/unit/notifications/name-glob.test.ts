/**
 * The event-name glob a route matches on.
 *
 * The grammar is the whole contract between an operator writing `domain.*` and
 * a connector choosing `domain.dns.ready`, and neither party can see the other,
 * so every rule it has is pinned here.
 */

import { describe, expect, test } from "bun:test";
import { matchesNameGlob } from "../../../src/notifications/name-glob.ts";
import { NOTIFICATION_NAME_MAX } from "../../../src/notifications/envelope.ts";

describe("an omitted pattern", () => {
  test("matches every name, because a filter nobody set narrows nothing", () => {
    expect(matchesNameGlob("domain.active", undefined)).toBe(true);
    expect(matchesNameGlob("anything.at.all", undefined)).toBe(true);
    expect(matchesNameGlob("domain.active", "")).toBe(true);
  });
});

describe("a literal pattern", () => {
  test("matches exactly that name", () => {
    expect(matchesNameGlob("domain.active", "domain.active")).toBe(true);
    expect(matchesNameGlob("domain.pending", "domain.active")).toBe(false);
  });

  test("does not match a name that merely contains it", () => {
    expect(matchesNameGlob("x.domain.active", "domain.active")).toBe(false);
    expect(matchesNameGlob("domain.active.now", "domain.active")).toBe(false);
  });

  test("treats the dot as a literal, not as a regex wildcard", () => {
    expect(matchesNameGlob("domainXactive", "domain.active")).toBe(false);
  });
});

describe("`*` — within one segment", () => {
  test("matches one more segment and no further", () => {
    expect(matchesNameGlob("domain.active", "domain.*")).toBe(true);
    expect(matchesNameGlob("domain.pending", "domain.*")).toBe(true);
    expect(matchesNameGlob("domain.dns.ready", "domain.*")).toBe(false);
  });

  test("does not match the bare prefix — a route under `domain` is not `domain`", () => {
    expect(matchesNameGlob("domain", "domain.*")).toBe(false);
  });

  test("works mid-name and at the start", () => {
    expect(matchesNameGlob("domain.dns.ready", "domain.*.ready")).toBe(true);
    expect(matchesNameGlob("domain.ready", "domain.*.ready")).toBe(false);
    expect(matchesNameGlob("reply.received", "*.received")).toBe(true);
    expect(matchesNameGlob("mail.reply.received", "*.received")).toBe(false);
  });

  test("alone, matches only a single-segment name", () => {
    expect(matchesNameGlob("bounced", "*")).toBe(true);
    expect(matchesNameGlob("mail.bounced", "*")).toBe(false);
  });
});

describe("`**` — across segments", () => {
  test("matches any remainder, however many segments", () => {
    expect(matchesNameGlob("domain.active", "domain.**")).toBe(true);
    expect(matchesNameGlob("domain.dns.ready", "domain.**")).toBe(true);
    expect(matchesNameGlob("domain.dns.record.added", "domain.**")).toBe(true);
  });

  test("still requires the separator before it", () => {
    expect(matchesNameGlob("domain", "domain.**")).toBe(false);
    expect(matchesNameGlob("domainlike.active", "domain.**")).toBe(false);
  });

  test("alone, matches every name", () => {
    expect(matchesNameGlob("bounced", "**")).toBe(true);
    expect(matchesNameGlob("a.b.c.d", "**")).toBe(true);
  });

  test("a longer run collapses to the same thing", () => {
    expect(matchesNameGlob("domain.dns.ready", "domain.***")).toBe(true);
  });
});

describe("matching is bounded, whatever the pattern", () => {
  /**
   * The property the module argues for in prose, asserted.
   *
   * A pattern alternating single wildcards with literals is the shape that
   * makes a compiled regex backtrack: every wildcard doubles the ways a
   * non-matching name can be split, and the earlier implementation reached
   * "does not return" at ten characters.
   *
   * Both inputs sit at the bounds already in force, so nothing outside the
   * system has to be true for this to be reachable: `ROUTE_NAME_GLOB_PATTERN`
   * in `schemas/notifications.ts` admits 200 characters of pattern, and the
   * envelope parser caps a name at {@link NOTIFICATION_NAME_MAX}.
   *
   * Alternating rather than repeating, because that is what makes each of
   * these wildcards a token of its own. A run of `*` collapses to a single
   * `**`, so a pattern of 200 bare wildcards is *one* token — it would measure
   * the cheapest thing the grammar has while reading like the dearest.
   *
   * A wall-clock assertion is a blunt instrument, and it is deliberately loose
   * enough not to flake on a loaded machine: the failure it exists to catch is
   * six orders of magnitude away, not a factor of two.
   */
  const GLOB_PATTERN_MAX = 200;
  const ADVERSARIAL = "*a".repeat(GLOB_PATTERN_MAX / 2);
  const NON_MATCHING = `${"a".repeat(NOTIFICATION_NAME_MAX - 1)}b`;

  test("the worst case the bounds admit — a name that fails against every split", () => {
    const startedAt = performance.now();
    expect(matchesNameGlob(NON_MATCHING, ADVERSARIAL)).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(100);
  });

  test("and the same pattern against a name that does match", () => {
    const startedAt = performance.now();
    expect(matchesNameGlob("a".repeat(NOTIFICATION_NAME_MAX), ADVERSARIAL)).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(100);
  });

  test("and against a dotted name, where every single wildcard dies at a dot", () => {
    const startedAt = performance.now();
    expect(matchesNameGlob("a.b".repeat(60), ADVERSARIAL)).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(100);
  });
});

describe("regex metacharacters in a pattern", () => {
  /**
   * The schema's character class already refuses most of these, but a stored
   * record is an untrusted input by the time it is read back — so a pattern
   * that reached here anyway must be matched as text, never compiled as an
   * expression an operator did not write.
   */
  test("are literal, not operators", () => {
    expect(matchesNameGlob("a+b", "a+b")).toBe(true);
    expect(matchesNameGlob("aab", "a+b")).toBe(false);
    expect(matchesNameGlob("a(b)c", "a(b)c")).toBe(true);
    expect(matchesNameGlob("abc", "a(b)c")).toBe(false);
  });

  test("cannot anchor away from a whole-name match", () => {
    expect(matchesNameGlob("domain.active", "^domain")).toBe(false);
    expect(matchesNameGlob("domain.active", "domain$")).toBe(false);
  });
});
