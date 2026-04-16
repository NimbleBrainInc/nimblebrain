import { describe, expect, it } from "bun:test";
import {
  composeSystemPrompt,
  CORE_PRIORITY_THRESHOLD,
  DEFAULT_IDENTITY,
  type FocusedAppInfo,
  type PromptAppInfo,
  type UserPrefs,
} from "../../src/prompt/compose.ts";
import type { Skill } from "../../src/skills/types.ts";

function makeContextSkill(name: string, priority: number, body: string): Skill {
  return {
    manifest: { name, description: "", version: "1.0.0", type: "context", priority },
    body,
    sourcePath: `/test/${name}.md`,
  };
}

const testSkill: Skill = {
  manifest: {
    name: "test-skill",
    description: "Test",
    version: "1.0.0",
    type: "skill",
    priority: 50,
    metadata: { keywords: [], triggers: [] },
  },
  body: "You are a test expert.",
  sourcePath: "/test",
};

describe("composeSystemPrompt", () => {
  it("returns default identity with no context skills and no matched skill", () => {
    const result = composeSystemPrompt([]);
    expect(result).toContain(DEFAULT_IDENTITY);
    expect(result).toContain("NimbleBrain");
    expect(result).toContain("tools");
  });

  it("uses context skill body instead of default identity", () => {
    const ctx = makeContextSkill("soul", 0, "I am Nira.");
    const result = composeSystemPrompt([ctx]);
    expect(result).toContain("I am Nira.");
    expect(result).not.toContain(DEFAULT_IDENTITY);
  });

  it("joins multiple context skills with separator", () => {
    const soul = makeContextSkill("soul", 0, "I am Nira.");
    const bootstrap = makeContextSkill("bootstrap", 10, "Use meta-tools.");
    const result = composeSystemPrompt([soul, bootstrap]);
    expect(result).toContain("I am Nira.\n\n---\n\nUse meta-tools.");
  });

  it("appends matched skill after context skills", () => {
    const soul = makeContextSkill("soul", 0, "Identity.");
    const result = composeSystemPrompt([soul], testSkill);
    expect(result).toContain("Identity.");
    expect(result).toContain("You are a test expert.");
  });

  it("uses default identity when context skills are empty, with matched skill", () => {
    const result = composeSystemPrompt([], testSkill);
    expect(result).toContain("NimbleBrain");
    expect(result).toContain("You are a test expert.");
    expect(result).toContain("---");
  });

  it("skips matched skill with empty body", () => {
    const emptySkill: Skill = { ...testSkill, body: "" };
    const soul = makeContextSkill("soul", 0, "Identity.");
    const result = composeSystemPrompt([soul], emptySkill);
    expect(result).toContain("Identity.");
    expect(result).not.toContain("You are a test expert.");
  });

  it("handles only matched skill (no context)", () => {
    const result = composeSystemPrompt([], testSkill);
    expect(result).toContain(DEFAULT_IDENTITY);
    expect(result).toContain("You are a test expert.");
  });

  it("default identity warns against fabricating tool calls", () => {
    const result = composeSystemPrompt([]);
    expect(result).toContain("Never fabricate tool calls");
  });

  it("skips context skills with empty body", () => {
    const empty = makeContextSkill("empty", 0, "");
    const real = makeContextSkill("real", 10, "Real content.");
    const result = composeSystemPrompt([empty, real]);
    expect(result).toContain("Real content.");
  });

  it("preserves context skill ordering (assumes pre-sorted by caller)", () => {
    const a = makeContextSkill("a", 0, "First.");
    const b = makeContextSkill("b", 10, "Second.");
    const c = makeContextSkill("c", 20, "Third.");
    const result = composeSystemPrompt([a, b, c]);
    expect(result).toContain("First.\n\n---\n\nSecond.\n\n---\n\nThird.");
  });
});

describe("composeSystemPrompt — workspace identity", () => {
  it("workspace identity override replaces default identity", () => {
    const identitySkill = makeContextSkill("identity-override", 1, "You are LegalBot for Acme Law.");
    const result = composeSystemPrompt([identitySkill]);
    expect(result).toContain("You are LegalBot for Acme Law.");
    expect(result).not.toContain(DEFAULT_IDENTITY);
  });

  it("workspace identity coexists with soul.md core skill", () => {
    const soul = makeContextSkill("soul", 0, "Core system instructions.");
    const identitySkill = makeContextSkill("identity-override", 1, "You are LegalBot.");
    const result = composeSystemPrompt([soul, identitySkill]);
    expect(result).toContain("Core system instructions.");
    expect(result).toContain("You are LegalBot.");
  });

  it("no workspace identity falls back to DEFAULT_IDENTITY", () => {
    const result = composeSystemPrompt([]);
    expect(result).toContain(DEFAULT_IDENTITY);
  });

  it("workspace identity appears in Layer 0 (core context)", () => {
    const soul = makeContextSkill("soul", 0, "Core.");
    const identitySkill = makeContextSkill("identity-override", 1, "Workspace persona.");
    const userCtx = makeContextSkill("user-skill", 20, "User context.");
    const result = composeSystemPrompt([soul, identitySkill, userCtx]);

    // Identity should appear before user context
    const identityIdx = result.indexOf("Workspace persona.");
    const userIdx = result.indexOf("User context.");
    expect(identityIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeGreaterThan(identityIdx);
  });

  it("different workspace identities produce different prompts", () => {
    const legalIdentity = makeContextSkill("identity-override", 1, "You are LegalBot for Acme Law.");
    const marketingIdentity = makeContextSkill(
      "identity-override",
      1,
      "You are MarketBot for creative campaigns.",
    );

    const legalPrompt = composeSystemPrompt([legalIdentity]);
    const marketingPrompt = composeSystemPrompt([marketingIdentity]);

    expect(legalPrompt).toContain("LegalBot");
    expect(legalPrompt).not.toContain("MarketBot");
    expect(marketingPrompt).toContain("MarketBot");
    expect(marketingPrompt).not.toContain("LegalBot");
  });
});

const sampleApps: PromptAppInfo[] = [
  { name: "tasks", trustScore: 85, ui: { name: "Tasks", primaryView: "board" } },
];

const sampleFocusedApp: FocusedAppInfo = {
  name: "Tasks",
  tools: [
    { name: "tasks__create", description: "Create a new task" },
    { name: "tasks__list", description: "List all tasks" },
  ],
  trustScore: 85,
};

describe("composeSystemPrompt — focusedApp", () => {
  it("without focusedApp: output is identical to before", () => {
    const soul = makeContextSkill("soul", 0, "Identity.");
    const withoutFocused = composeSystemPrompt([soul], testSkill, sampleApps);
    const withUndefined = composeSystemPrompt(
      [soul],
      testSkill,
      sampleApps,
      undefined,
    );
    expect(withoutFocused).toBe(withUndefined);
    expect(withoutFocused).not.toContain("Active App");
  });

  it("with focusedApp (no skill resource): contains Active App section with guide and rules", () => {
    const soul = makeContextSkill("soul", 0, "Identity.");
    const result = composeSystemPrompt(
      [soul],
      null,
      sampleApps,
      sampleFocusedApp,
    );
    expect(result).toContain("## Active App: Tasks");
    expect(result).toContain(
      "The user is currently viewing the **Tasks** app alongside this chat.",
    );
    // Tool descriptions are NOT in the system prompt (LLM gets them via tools parameter)
    expect(result).not.toContain("### Available Tools");
    expect(result).not.toContain("- **tasks__create**");
    expect(result).toContain("### App Guide");
    expect(result).toContain(
      "No app-specific guide available. Use the available tools to help the user.",
    );
    expect(result).toContain("### Interaction Rules");
    expect(result).toContain("call `nb__search` with `scope: \"tools\"` and a keyword");
    expect(result).toContain("[App Context: ...]");
  });

  it("with focusedApp (with skill resource): contains App Guide with resource content", () => {
    const focused: FocusedAppInfo = {
      ...sampleFocusedApp,
      trustScore: 85,
      skillResource:
        "Use tasks__create to add items. Always set a due date when the user mentions a deadline.",
    };
    const result = composeSystemPrompt([], null, sampleApps, focused);
    expect(result).toContain("### App Guide");
    expect(result).toContain(
      "Use tasks__create to add items. Always set a due date when the user mentions a deadline.",
    );
    expect(result).not.toContain("No app-specific guide available.");
  });

  it("Active App section appears between Installed Apps and matched skill", () => {
    const soul = makeContextSkill("soul", 0, "Identity.");
    const result = composeSystemPrompt(
      [soul],
      testSkill,
      sampleApps,
      sampleFocusedApp,
    );

    const appsIdx = result.indexOf("## Installed Apps");
    const activeAppIdx = result.indexOf("## Active App: Tasks");
    const matchedIdx = result.indexOf("You are a test expert.");

    expect(appsIdx).toBeGreaterThan(-1);
    expect(activeAppIdx).toBeGreaterThan(-1);
    expect(matchedIdx).toBeGreaterThan(-1);
    expect(activeAppIdx).toBeGreaterThan(appsIdx);
    expect(matchedIdx).toBeGreaterThan(activeAppIdx);
  });

  it("tool descriptions are NOT rendered in system prompt (they come via tools parameter)", () => {
    const focused: FocusedAppInfo = {
      name: "Calendar",
      tools: [
        { name: "cal__add_event", description: "Add a calendar event" },
        { name: "cal__delete_event", description: "Delete a calendar event" },
      ],
      trustScore: 85,
    };
    const result = composeSystemPrompt([], null, undefined, focused);
    expect(result).not.toContain("cal__add_event");
    expect(result).not.toContain("cal__delete_event");
    expect(result).toContain("## Active App: Calendar");
  });

  it("contains all 7 interaction rules", () => {
    const result = composeSystemPrompt(
      [],
      null,
      undefined,
      sampleFocusedApp,
    );
    // Verify all 7 rules are present
    expect(result).toContain("Do not ask for confirmation unless the action is destructive or ambiguous.");
    expect(result).toContain("The app view refreshes automatically — do not describe the UI.");
    expect(result).toContain("call `nb__search` with `scope: \"tools\"` and a keyword.");
    expect(result).toContain('the user says "undo" or "go back,"');
    expect(result).toContain("ask ONE clarifying question about what specifically to change.");
    expect(result).toContain("`[App Context: ...]` header with metadata from the app.");
    expect(result).toContain("Other apps are still available via `nb__search`");
  });
});

describe("composeSystemPrompt — core vs user context layering", () => {
  it("exports CORE_PRIORITY_THRESHOLD as 10", () => {
    expect(CORE_PRIORITY_THRESHOLD).toBe(10);
  });

  it("core context (priority 0) appears before user context (priority 20)", () => {
    const core = makeContextSkill("soul", 0, "Core identity.");
    const user = makeContextSkill("custom", 20, "User instructions.");
    const result = composeSystemPrompt([core, user]);
    const coreIdx = result.indexOf("Core identity.");
    const userIdx = result.indexOf("User instructions.");
    expect(coreIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeGreaterThan(-1);
    expect(coreIdx).toBeLessThan(userIdx);
  });

  it("user context (priority 15) appears before user context (priority 50)", () => {
    const core = makeContextSkill("soul", 0, "Core.");
    const user15 = makeContextSkill("custom-a", 15, "User A.");
    const user50 = makeContextSkill("custom-b", 50, "User B.");
    const result = composeSystemPrompt([core, user15, user50]);
    const idxA = result.indexOf("User A.");
    const idxB = result.indexOf("User B.");
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);
    expect(idxA).toBeLessThan(idxB);
  });

  it("core context appears before apps section", () => {
    const core = makeContextSkill("soul", 0, "Core identity.");
    const user = makeContextSkill("custom", 20, "User instructions.");
    const result = composeSystemPrompt([core, user], null, sampleApps);
    const coreIdx = result.indexOf("Core identity.");
    const appsIdx = result.indexOf("## Installed Apps");
    expect(coreIdx).toBeGreaterThan(-1);
    expect(appsIdx).toBeGreaterThan(-1);
    expect(coreIdx).toBeLessThan(appsIdx);
  });

  it("user context appears after core, before apps", () => {
    const core = makeContextSkill("soul", 0, "Core identity.");
    const user = makeContextSkill("custom", 20, "User instructions.");
    const result = composeSystemPrompt([core, user], null, sampleApps);
    const coreIdx = result.indexOf("Core identity.");
    const userIdx = result.indexOf("User instructions.");
    const appsIdx = result.indexOf("## Installed Apps");
    expect(userIdx).toBeGreaterThan(coreIdx);
    expect(userIdx).toBeLessThan(appsIdx);
  });

  it("matched skill body still appears last", () => {
    const core = makeContextSkill("soul", 0, "Core identity.");
    const user = makeContextSkill("custom", 20, "User instructions.");
    const result = composeSystemPrompt([core, user], testSkill, sampleApps, sampleFocusedApp);
    const matchedIdx = result.indexOf("You are a test expert.");
    expect(matchedIdx).toBeGreaterThan(-1);
    // matched skill should be the last layer
    expect(result.lastIndexOf("You are a test expert.")).toBe(matchedIdx);
    // nothing after it except the closing containment tag
    const afterMatched = result.slice(matchedIdx + "You are a test expert.".length).trim();
    expect(afterMatched).toBe("</skill-instructions>");
  });

  it("empty user context: core context + apps + matched skill (no extra separator)", () => {
    const core = makeContextSkill("soul", 0, "Core identity.");
    const bootstrap = makeContextSkill("bootstrap", 10, "Use meta-tools.");
    const result = composeSystemPrompt([core, bootstrap], testSkill, sampleApps);
    // All skills are core (priority ≤ 10), so output should be identical to the old behavior
    const expected = [
      "Core identity.",
      "Use meta-tools.",
      // apps section
      expect.stringContaining("## Installed Apps"),
      "You are a test expert.",
    ];
    // Verify no double separators
    expect(result).not.toContain("---\n\n---");
  });

  it("default identity fallback when no context skills provided", () => {
    const result = composeSystemPrompt([]);
    expect(result).toContain(DEFAULT_IDENTITY);
    expect(result).toContain("- Today's date:");
  });

  it("default identity fallback when only user context skills (no core)", () => {
    const user = makeContextSkill("custom", 20, "User instructions.");
    const result = composeSystemPrompt([user]);
    const defaultIdx = result.indexOf(DEFAULT_IDENTITY);
    const userIdx = result.indexOf("User instructions.");
    expect(defaultIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeGreaterThan(-1);
    expect(defaultIdx).toBeLessThan(userIdx);
  });

  it("backwards compatible: all core context skills produce identical output", () => {
    const soul = makeContextSkill("soul", 0, "I am Nira.");
    const bootstrap = makeContextSkill("bootstrap", 10, "Use meta-tools.");
    const result = composeSystemPrompt([soul, bootstrap], testSkill, sampleApps);
    // This matches the old behavior exactly: context bodies + apps + matched skill
    expect(result).toContain("I am Nira.");
    expect(result).toContain("Use meta-tools.");
    expect(result).toContain("## Installed Apps");
    expect(result).toContain("You are a test expert.");
    // Verify order
    const idx0 = result.indexOf("I am Nira.");
    const idx1 = result.indexOf("Use meta-tools.");
    const idx2 = result.indexOf("## Installed Apps");
    const idx3 = result.indexOf("You are a test expert.");
    expect(idx0).toBeLessThan(idx1);
    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);
  });

  it("priority 10 is core, priority 11 is user", () => {
    const atThreshold = makeContextSkill("at-threshold", 10, "At threshold.");
    const aboveThreshold = makeContextSkill("above-threshold", 11, "Above threshold.");
    const result = composeSystemPrompt([atThreshold, aboveThreshold]);
    const atIdx = result.indexOf("At threshold.");
    const aboveIdx = result.indexOf("Above threshold.");
    expect(atIdx).toBeLessThan(aboveIdx);
  });

  it("user context skills passed out-of-order with core are still separated correctly", () => {
    // Even if the caller passes user context before core, core comes first in output
    const user = makeContextSkill("custom", 20, "User instructions.");
    const core = makeContextSkill("soul", 0, "Core identity.");
    const result = composeSystemPrompt([user, core]);
    const coreIdx = result.indexOf("Core identity.");
    const userIdx = result.indexOf("User instructions.");
    expect(coreIdx).toBeLessThan(userIdx);
  });
});

describe("composeSystemPrompt — reference resource", () => {
  it("with referenceResourceUri: appends hint after skill resource", () => {
    const focused: FocusedAppInfo = {
      name: "PDF Generator",
      tools: [],
      skillResource: "Use set_source to edit documents.",
      referenceResourceUri: "skill://typst-pdf/reference",
      trustScore: 85,
    };
    const result = composeSystemPrompt([], null, undefined, focused);
    expect(result).toContain("Use set_source to edit documents.");
    expect(result).toContain("read the `skill://typst-pdf/reference` resource");
  });

  it("without referenceResourceUri: no hint line", () => {
    const focused: FocusedAppInfo = {
      name: "PDF Generator",
      tools: [],
      skillResource: "Use set_source to edit documents.",
      trustScore: 85,
    };
    const result = composeSystemPrompt([], null, undefined, focused);
    expect(result).toContain("Use set_source to edit documents.");
    expect(result).not.toContain("skill://typst-pdf/reference");
  });

  it("referenceResourceUri without skillResource: no hint (no guide section)", () => {
    const focused: FocusedAppInfo = {
      name: "PDF Generator",
      tools: [],
      referenceResourceUri: "skill://typst-pdf/reference",
      trustScore: 85,
    };
    const result = composeSystemPrompt([], null, undefined, focused);
    expect(result).toContain("No app-specific guide available.");
    expect(result).not.toContain("skill://typst-pdf/reference");
  });
});

describe("composeSystemPrompt — user preferences", () => {
  it("injects user section with name and timezone", () => {
    const prefs: UserPrefs = { displayName: "Mat", timezone: "Pacific/Honolulu", locale: "en-US" };
    const result = composeSystemPrompt([], null, undefined, undefined, undefined, prefs);
    expect(result).toContain("## User");
    expect(result).toContain("- Name: Mat");
    expect(result).toContain("- Timezone: Pacific/Honolulu");
    expect(result).toContain("- Today's date:");
  });

  it("omits locale when en-US (default)", () => {
    const prefs: UserPrefs = { displayName: "Mat", timezone: "", locale: "en-US" };
    const result = composeSystemPrompt([], null, undefined, undefined, undefined, prefs);
    expect(result).not.toContain("Locale");
  });

  it("includes locale when non-default", () => {
    const prefs: UserPrefs = { displayName: "", timezone: "Europe/Berlin", locale: "de-DE" };
    const result = composeSystemPrompt([], null, undefined, undefined, undefined, prefs);
    expect(result).toContain("- Locale: de-DE");
  });

  it("user section always includes today's date even when prefs are empty", () => {
    const prefs: UserPrefs = { displayName: "", timezone: "", locale: "en-US" };
    const result = composeSystemPrompt([], null, undefined, undefined, undefined, prefs);
    expect(result).toContain("## User");
    expect(result).toContain("- Today's date:");
    expect(result).not.toContain("- Name:");
    expect(result).not.toContain("- Timezone:");
  });

  it("user section appears between context skills and apps", () => {
    const core = makeContextSkill("soul", 0, "Identity.");
    const prefs: UserPrefs = { displayName: "Mat", timezone: "Pacific/Honolulu", locale: "en-US" };
    const result = composeSystemPrompt([core], null, sampleApps, undefined, undefined, prefs);
    const identityIdx = result.indexOf("Identity.");
    const userIdx = result.indexOf("## User");
    const appsIdx = result.indexOf("## Installed Apps");
    expect(userIdx).toBeGreaterThan(identityIdx);
    expect(userIdx).toBeLessThan(appsIdx);
  });
});

describe("composeSystemPrompt — app guide trust gating", () => {
  const guideText = "Use tasks__create to add items. Always set a due date.";

  it("high trust (80): app guide is included", () => {
    const focused: FocusedAppInfo = {
      name: "Tasks",
      tools: [],
      skillResource: guideText,
      trustScore: 80,
    };
    const result = composeSystemPrompt([], null, undefined, focused);
    expect(result).toContain(guideText);
    expect(result).toContain("<app-guide>");
    expect(result).not.toContain("trust score below threshold");
  });

  it("low trust (30): app guide is NOT included, fallback shown", () => {
    const focused: FocusedAppInfo = {
      name: "Tasks",
      tools: [],
      skillResource: guideText,
      trustScore: 30,
    };
    const result = composeSystemPrompt([], null, undefined, focused);
    expect(result).not.toContain(guideText);
    expect(result).not.toContain("<app-guide>");
    expect(result).toContain("App guide available but not injected — bundle trust score below threshold.");
  });

  it("boundary: trustScore 50 includes guide", () => {
    const focused: FocusedAppInfo = {
      name: "Tasks",
      tools: [],
      skillResource: guideText,
      trustScore: 50,
    };
    const result = composeSystemPrompt([], null, undefined, focused);
    expect(result).toContain(guideText);
    expect(result).toContain("<app-guide>");
  });

  it("boundary: trustScore 49 excludes guide", () => {
    const focused: FocusedAppInfo = {
      name: "Tasks",
      tools: [],
      skillResource: guideText,
      trustScore: 49,
    };
    const result = composeSystemPrompt([], null, undefined, focused);
    expect(result).not.toContain(guideText);
    expect(result).not.toContain("<app-guide>");
    expect(result).toContain("trust score below threshold");
  });

  it("no skillResource: works regardless of trust score", () => {
    const focused: FocusedAppInfo = {
      name: "Tasks",
      tools: [],
      trustScore: 10,
    };
    const result = composeSystemPrompt([], null, undefined, focused);
    expect(result).toContain("## Active App: Tasks");
    expect(result).toContain("No app-specific guide available.");
    expect(result).not.toContain("trust score below threshold");
  });
});
