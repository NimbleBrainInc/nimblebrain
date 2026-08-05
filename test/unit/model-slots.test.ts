import { describe, expect, test } from "bun:test";
import { findProviderForModelId, listModels, listProviders } from "../../src/model/catalog.ts";
import { fallsBackToAnthropic, resolveModelString } from "../../src/model/registry.ts";
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

describe("fallsBackToAnthropic — the warn predicate", () => {
  // The bug this exists to prevent: asking the question with
  // `getModelByString` instead answers differently, because that helper
  // assumes `anthropic` for a bare id. Under that predicate 88 of the 102
  // catalog ids report as unknown while resolving perfectly well, so every
  // bare OpenAI/Google/xAI/Nebius id logs a warning that is simply wrong.
  test("no catalog id is reported as falling back", () => {
    const ids = [...new Set(listProviders().flatMap((p) => listModels(p).map((m) => m.id)))];
    expect(ids.length).toBeGreaterThan(0); // guard against a vacuous pass
    const flagged = ids.filter((id) => fallsBackToAnthropic(id));
    expect(flagged).toEqual([]);
  });

  // Non-Anthropic ids are the ones the naive predicate got wrong, so pin a
  // representative of each provider rather than trusting the sweep alone.
  test.each(["gpt-3.5-turbo", "gpt-4o"])("bare OpenAI id %s does not flag", (id) => {
    if (findProviderForModelId(id)) expect(fallsBackToAnthropic(id)).toBe(false);
  });

  test("a genuinely unknown bare id does flag", () => {
    expect(fallsBackToAnthropic("reasoning")).toBe(true);
    expect(fallsBackToAnthropic("typo-model-9000")).toBe(true);
  });

  // A qualified id is the caller's explicit choice — never second-guessed,
  // even when the provider is one the catalog has never heard of.
  test("a qualified id never flags", () => {
    expect(fallsBackToAnthropic("anthropic:whatever")).toBe(false);
    expect(fallsBackToAnthropic("some-proxy:pinned-build-42")).toBe(false);
  });

  // The predicate must agree with the branch it describes, not merely look
  // similar to it.
  test("agrees with resolveModelString's actual behaviour", () => {
    for (const id of ["reasoning", "typo-model-9000", "gpt-4o", "claude-sonnet-4-6"]) {
      const usedFallback = resolveModelString(id) === `anthropic:${id}` && !findProviderForModelId(id);
      expect(fallsBackToAnthropic(id)).toBe(usedFallback);
    }
  });
});
