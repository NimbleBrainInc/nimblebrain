import { describe, expect, test } from "bun:test";
import { listModels, listProviders } from "../../src/model/catalog.ts";
import { resolveModelString } from "../../src/model/registry.ts";
import { MODEL_SLOTS, isModelSlot, parseModelSlotRef } from "../../src/model/slots.ts";

describe("parseModelSlotRef", () => {
  // The bug: workspace.json agent profiles document a BARE slot name
  // (`"model": "reasoning"`), and only the `alias:` form used to resolve.
  test.each([...MODEL_SLOTS])("resolves the bare slot name %s", (slot) => {
    expect(parseModelSlotRef(slot)).toBe(slot);
  });

  test.each([...MODEL_SLOTS])("resolves the alias: form of %s", (slot) => {
    expect(parseModelSlotRef(`alias:${slot}`)).toBe(slot);
  });

  test("returns null for a concrete model id, bare or qualified", () => {
    expect(parseModelSlotRef("claude-sonnet-4-6")).toBeNull();
    expect(parseModelSlotRef("anthropic:claude-sonnet-4-6")).toBeNull();
    expect(parseModelSlotRef("nebius:openai/gpt-oss-120b")).toBeNull();
  });

  test("returns null for a non-slot alias rather than inventing a slot", () => {
    expect(parseModelSlotRef("alias:nonsense")).toBeNull();
    expect(parseModelSlotRef("alias:")).toBeNull();
  });

  // `alias:` is a prefix, not a substring — a provider-qualified id that
  // merely contains the word must not be mistaken for a slot reference.
  test("does not treat a qualified id containing 'alias:' as a slot", () => {
    expect(parseModelSlotRef("vendor:alias:fast")).toBeNull();
  });

  test("is case-sensitive — slot names are exact", () => {
    expect(parseModelSlotRef("Fast")).toBeNull();
    expect(parseModelSlotRef("REASONING")).toBeNull();
  });

  test("isModelSlot agrees with the slot list", () => {
    for (const slot of MODEL_SLOTS) expect(isModelSlot(slot)).toBe(true);
    expect(isModelSlot("nonsense")).toBe(false);
  });
});

describe("slot names vs the model catalog", () => {
  // The invariant that makes a bare slot name safe to accept. Slots are roles
  // ("fast"); catalog ids are vendor ids ("claude-haiku-4-5-20251001"). If a
  // provider ever ships a model whose id IS a slot name, the bare form becomes
  // ambiguous and that model is unreachable by id — fail here rather than
  // misroute silently.
  test("no catalog model id collides with a slot name", () => {
    const ids = new Set(listProviders().flatMap((p) => listModels(p).map((m) => m.id)));
    expect(ids.size).toBeGreaterThan(0); // guard against a vacuous pass
    for (const slot of MODEL_SLOTS) {
      expect(ids.has(slot)).toBe(false);
    }
  });

  // The mechanism behind the bug: a bare string with no catalog entry is NOT
  // rejected, it is stamped with `anthropic:`. That fallback is deliberate
  // (pinned/bespoke ids served under their own name), which is why slot
  // resolution must happen BEFORE it rather than inside it.
  test.each([...MODEL_SLOTS])(
    "resolveModelString would stamp anthropic: on bare %s — the failure slot parsing prevents",
    (slot) => {
      expect(resolveModelString(slot)).toBe(`anthropic:${slot}`);
    },
  );

  test("resolveModelString leaves a qualified id alone", () => {
    expect(resolveModelString("nebius:openai/gpt-oss-120b")).toBe("nebius:openai/gpt-oss-120b");
  });
});

describe("the reasoning slot is gone", () => {
  // It never had a runtime consumer — `default` serves every chat turn, `fast`
  // serves titles, the briefing and both folds — so it was a configurable field
  // implying routing the engine never did.
  test("is not a slot name", () => {
    expect(isModelSlot("reasoning")).toBe(false);
    expect(MODEL_SLOTS).toEqual(["default", "fast"]);
  });

  // The documented break: an agent profile naming it stops resolving and falls
  // through to the bare-id fallback, which fails at the provider rather than
  // silently running on some other model.
  test.each([["reasoning"], ["alias:reasoning"]])("%s no longer parses as a slot", (s) => {
    expect(parseModelSlotRef(s)).toBeNull();
  });
});
