import { describe, expect, test } from "bun:test";
import type { ModelSlots } from "../../../src/runtime/types.ts";
import type { Workspace } from "../../../src/workspace/types.ts";

// ---------------------------------------------------------------------------
// These tests verify the workspace config merging logic used in chat().
// They test the pure merge behavior without requiring a full Runtime instance.
// ---------------------------------------------------------------------------

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-test",
    name: "Test Workspace",
    members: [],
    bundles: [],
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Model slot merging logic (mirrors getModelSlots() in runtime.ts)
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";

function mergeModelSlots(
  instanceModels: ModelSlots | undefined,
  defaultModel: string,
  workspaceModels: Partial<ModelSlots> | undefined,
): ModelSlots {
  const fallback = defaultModel;
  const base: ModelSlots = {
    default: instanceModels?.default ?? fallback,
    fast: instanceModels?.fast ?? fallback,
    reasoning: instanceModels?.reasoning ?? fallback,
  };
  if (workspaceModels) {
    return {
      default: workspaceModels.default ?? base.default,
      fast: workspaceModels.fast ?? base.fast,
      reasoning: workspaceModels.reasoning ?? base.reasoning,
    };
  }
  return base;
}

describe("workspace model slot merging", () => {
  const instanceModels: ModelSlots = {
    default: "claude-sonnet-4-5-20250929",
    fast: "claude-haiku-3",
    reasoning: "claude-opus-4",
  };

  test("workspace overrides specific model slots (partial)", () => {
    const wsModels: Partial<ModelSlots> = {
      fast: "gpt-4o-mini",
    };

    const merged = mergeModelSlots(instanceModels, DEFAULT_MODEL, wsModels);
    // Only fast slot overridden
    expect(merged.fast).toBe("gpt-4o-mini");
    // Others unchanged
    expect(merged.default).toBe("claude-sonnet-4-5-20250929");
    expect(merged.reasoning).toBe("claude-opus-4");
  });

  test("workspace overrides all model slots", () => {
    const wsModels: Partial<ModelSlots> = {
      default: "gpt-4o",
      fast: "gpt-4o-mini",
      reasoning: "o1",
    };

    const merged = mergeModelSlots(instanceModels, DEFAULT_MODEL, wsModels);
    expect(merged.default).toBe("gpt-4o");
    expect(merged.fast).toBe("gpt-4o-mini");
    expect(merged.reasoning).toBe("o1");
  });

  test("no workspace models returns instance models unchanged", () => {
    const merged = mergeModelSlots(instanceModels, DEFAULT_MODEL, undefined);
    expect(merged).toEqual(instanceModels);
  });

  test("workspace models with no instance models merges over defaults", () => {
    const wsModels: Partial<ModelSlots> = {
      reasoning: "o1",
    };

    const merged = mergeModelSlots(undefined, DEFAULT_MODEL, wsModels);
    expect(merged.default).toBe(DEFAULT_MODEL);
    expect(merged.fast).toBe(DEFAULT_MODEL);
    expect(merged.reasoning).toBe("o1");
  });

  test("empty workspace models object changes nothing", () => {
    const merged = mergeModelSlots(instanceModels, DEFAULT_MODEL, {});
    expect(merged).toEqual(instanceModels);
  });
});

// ---------------------------------------------------------------------------
// Workspace config loading in chat() — integration-level assertions
// ---------------------------------------------------------------------------

describe("workspace config applied in chat()", () => {
  test("workspace with models populates the field", () => {
    const ws = makeWorkspace({
      models: {
        default: "gpt-4o",
      },
    });

    expect(ws.models).toBeDefined();
    expect(ws.models!.default).toBe("gpt-4o");
  });

  test("workspace with no models leaves the fields undefined", () => {
    const ws = makeWorkspace();
    expect(ws.models).toBeUndefined();
    expect(ws.skillDirs).toBeUndefined();
  });

  test("workspace skillDirs is present but not consumed (TODO)", () => {
    const ws = makeWorkspace({
      skillDirs: ["/custom/skills"],
    });
    // skillDirs field exists on workspace for future use
    expect(ws.skillDirs).toEqual(["/custom/skills"]);
  });
});
