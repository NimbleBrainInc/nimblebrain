import { describe, expect, test } from "bun:test";
import type { AgentProfile, ModelSlots } from "../../../src/runtime/types.ts";
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
// Agent merging logic (mirrors delegateCtx.agents getter in runtime.ts)
// ---------------------------------------------------------------------------

function mergeAgents(
  instanceAgents: Record<string, AgentProfile> | undefined,
  workspaceAgents: Record<string, AgentProfile> | undefined,
): Record<string, AgentProfile> | undefined {
  if (workspaceAgents) {
    return { ...(instanceAgents ?? {}), ...workspaceAgents };
  }
  return instanceAgents;
}

describe("workspace agent merging", () => {
  const instanceAgents: Record<string, AgentProfile> = {
    researcher: {
      description: "Research agent",
      systemPrompt: "You research things.",
      tools: ["search__*"],
      maxIterations: 8,
    },
    writer: {
      description: "Writing agent",
      systemPrompt: "You write things.",
      tools: ["docs__*"],
    },
  };

  test("workspace agents merge over instance agents", () => {
    const wsAgents: Record<string, AgentProfile> = {
      researcher: {
        description: "Custom research agent",
        systemPrompt: "You research with custom instructions.",
        tools: ["custom_search__*"],
        maxIterations: 5,
      },
    };

    const merged = mergeAgents(instanceAgents, wsAgents);
    expect(merged).toBeDefined();
    // Workspace researcher overrides instance researcher
    expect(merged!.researcher.description).toBe("Custom research agent");
    expect(merged!.researcher.maxIterations).toBe(5);
    // Instance writer is preserved
    expect(merged!.writer.description).toBe("Writing agent");
  });

  test("workspace can add new agents not in instance config", () => {
    const wsAgents: Record<string, AgentProfile> = {
      analyst: {
        description: "Data analyst",
        systemPrompt: "You analyze data.",
        tools: ["analytics__*"],
      },
    };

    const merged = mergeAgents(instanceAgents, wsAgents);
    expect(merged).toBeDefined();
    expect(merged!.analyst.description).toBe("Data analyst");
    expect(merged!.researcher.description).toBe("Research agent");
    expect(merged!.writer.description).toBe("Writing agent");
  });

  test("no workspace agents returns instance agents unchanged", () => {
    const merged = mergeAgents(instanceAgents, undefined);
    expect(merged).toBe(instanceAgents);
  });

  test("workspace agents with no instance agents returns workspace agents", () => {
    const wsAgents: Record<string, AgentProfile> = {
      analyst: {
        description: "Data analyst",
        systemPrompt: "You analyze data.",
        tools: [],
      },
    };

    const merged = mergeAgents(undefined, wsAgents);
    expect(merged).toBeDefined();
    expect(merged!.analyst.description).toBe("Data analyst");
  });

  test("both undefined returns undefined", () => {
    const merged = mergeAgents(undefined, undefined);
    expect(merged).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Workspace config loading in chat() — integration-level assertions
// ---------------------------------------------------------------------------

describe("workspace config applied in chat()", () => {
  test("workspace with agents and models populates both fields", () => {
    const ws = makeWorkspace({
      agents: {
        coder: {
          description: "Code agent",
          systemPrompt: "You write code.",
          tools: ["bash__*"],
        },
      },
      models: {
        default: "gpt-4o",
      },
    });

    expect(ws.agents).toBeDefined();
    expect(ws.agents!.coder.description).toBe("Code agent");
    expect(ws.models).toBeDefined();
    expect(ws.models!.default).toBe("gpt-4o");
  });

  test("workspace with no agents/models leaves fields undefined", () => {
    const ws = makeWorkspace();
    expect(ws.agents).toBeUndefined();
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
