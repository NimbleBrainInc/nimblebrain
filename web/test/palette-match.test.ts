// ---------------------------------------------------------------------------
// Command palette fuzzy matcher — ranking contract.
//
// Pins the behaviors the palette relies on for sensible ordering:
//   1. Empty query matches everything (unfiltered palette).
//   2. Non-subsequence queries don't match.
//   3. Prefix > start-of-word > scattered subsequence.
//   4. Shorter haystack wins a tie ("CRM" over "CRM Archive" for "crm").
//   5. scoreItem falls back to keywords, docked below a title hit.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { fuzzyScore, scoreItem } from "../src/components/palette/match";

describe("fuzzyScore", () => {
  test("empty query matches everything with score 0", () => {
    expect(fuzzyScore("", "anything")).toEqual({ matched: true, score: 0 });
  });

  test("non-subsequence does not match", () => {
    expect(fuzzyScore("zzz", "Pacific Clinic").matched).toBe(false);
    expect(fuzzyScore("clinicx", "Pacific Clinic").matched).toBe(false);
  });

  test("query longer than text does not match", () => {
    expect(fuzzyScore("clinical", "clinic").matched).toBe(false);
  });

  test("subsequence matches even when scattered", () => {
    // p-a-c from "Pacific" — in order, so it matches.
    expect(fuzzyScore("pac", "Pacific Clinic").matched).toBe(true);
  });

  test("prefix match outranks a mid-word match", () => {
    const prefix = fuzzyScore("pac", "Pacific Clinic");
    const mid = fuzzyScore("pac", "Topac Holdings");
    expect(prefix.score).toBeGreaterThan(mid.score);
  });

  test("start-of-word match outranks a scattered subsequence", () => {
    // "Personal Clinic": "pc" hits two word-starts.
    const boundary = fuzzyScore("pc", "Personal Clinic");
    // "Topical": "pc" is p(mid)...c(mid), scattered, no boundaries.
    const scattered = fuzzyScore("pc", "Topical");
    expect(boundary.matched).toBe(true);
    expect(scattered.matched).toBe(true);
    expect(boundary.score).toBeGreaterThan(scattered.score);
  });

  test("shorter haystack wins a tie", () => {
    const short = fuzzyScore("crm", "CRM");
    const long = fuzzyScore("crm", "CRM Archive");
    expect(short.score).toBeGreaterThan(long.score);
  });

  test("is case-insensitive", () => {
    expect(fuzzyScore("CRM", "crm").matched).toBe(true);
    expect(fuzzyScore("crm", "CRM").matched).toBe(true);
  });
});

describe("scoreItem", () => {
  test("matches on title", () => {
    const r = scoreItem("crm", { title: "CRM" });
    expect(r.matched).toBe(true);
  });

  test("falls back to keywords when title misses", () => {
    const r = scoreItem("pipeline", { title: "CRM", keywords: ["pipeline", "deals"] });
    expect(r.matched).toBe(true);
  });

  test("keyword hit is docked below an equivalent title hit", () => {
    const titleHit = scoreItem("deals", { title: "deals" });
    const keywordHit = scoreItem("deals", { title: "CRM", keywords: ["deals"] });
    expect(titleHit.score).toBeGreaterThan(keywordHit.score);
  });

  test("no match on title or keywords returns unmatched", () => {
    expect(scoreItem("zzz", { title: "CRM", keywords: ["deals"] }).matched).toBe(false);
  });
});
