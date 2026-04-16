import { describe, expect, it, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../../src/runtime/runtime.ts";
import { deriveServerName } from "../../src/bundles/paths.ts";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { createMockModel } from "../helpers/mock-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nimblebrain-depcheck-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

/** Model adapter that captures the system prompt for inspection. Ignores auto-title calls. */
function createCapturingModel(): { model: LanguageModelV3; getSystem: () => string } {
  let capturedSystem = "";
  const model = createMockModel((options) => {
    const systemMsg = options.prompt.find((m) => m.role === "system");
    if (systemMsg && typeof systemMsg.content === "string") {
      // Skip auto-title calls (they have a short, distinctive system prompt)
      if (!systemMsg.content.includes("Generate a 3-6 word title")) {
        capturedSystem = systemMsg.content;
      }
    }
    return {
      content: [{ type: "text", text: "ok" }],
      inputTokens: 10,
      outputTokens: 5,
    };
  });
  return { model, getSystem: () => capturedSystem };
}

function writeSkill(dir: string, filename: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content);
}

describe("dependency checking", () => {
  it("no warning when skill has no requiresBundles", async () => {
    const skillDir = join(testDir, "no-deps");
    writeSkill(
      skillDir,
      "greeter.md",
      `---
name: greeter
description: Greets people
version: 1.0.0
metadata:
  keywords: [hello, greet, hi]
  triggers: ["say hello"]
---

You are a friendly greeter.
`,
    );

    const { model, getSystem } = createCapturingModel();
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: model },
      noDefaultBundles: true,
      skillDirs: [skillDir],
    });
    await provisionTestWorkspace(runtime);

    await runtime.chat({ message: "say hello", workspaceId: TEST_WORKSPACE_ID });

    expect(getSystem()).not.toContain("Missing dependencies");
    expect(getSystem()).toContain("friendly greeter");

    await runtime.shutdown();
  });

  it("no warning when all required bundles are installed", async () => {
    const skillDir = join(testDir, "installed-deps");
    writeSkill(
      skillDir,
      "helper.md",
      `---
name: helper
description: Helper skill
version: 1.0.0
requires-bundles:
  - "@acme/foo"
metadata:
  keywords: [help, assist]
  triggers: ["help me"]
---

You are a helper.
`,
    );

    const { model, getSystem } = createCapturingModel();
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: model },
      noDefaultBundles: true,
      skillDirs: [skillDir],
    });

    // Seed a lifecycle instance so @acme/foo is considered "installed"
    await provisionTestWorkspace(runtime);
    const serverName = deriveServerName("@acme/foo");
    runtime.getLifecycle().seedInstance(serverName, "@acme/foo", {
      name: "@acme/foo",
    }, undefined, TEST_WORKSPACE_ID);

    await runtime.chat({ message: "help me", workspaceId: TEST_WORKSPACE_ID });

    expect(getSystem()).not.toContain("Missing dependencies");
    expect(getSystem()).toContain("You are a helper");

    await runtime.shutdown();
  });

  it("appends warning when required bundle is NOT installed", async () => {
    const skillDir = join(testDir, "missing-dep");
    writeSkill(
      skillDir,
      "analyst.md",
      `---
name: analyst
description: Data analyst
version: 1.0.0
requires-bundles:
  - "@acme/data-tools"
metadata:
  keywords: [analyze, data, report]
  triggers: ["analyze data"]
---

You are a data analyst.
`,
    );

    const { model, getSystem } = createCapturingModel();
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: model },
      noDefaultBundles: true,
      skillDirs: [skillDir],
    });
    await provisionTestWorkspace(runtime);

    await runtime.chat({ message: "analyze data", workspaceId: TEST_WORKSPACE_ID });

    expect(getSystem()).toContain("You are a data analyst");
    expect(getSystem()).toContain("Missing dependencies");
    expect(getSystem()).toContain("@acme/data-tools");
    expect(getSystem()).toContain("nb__manage_app");

    await runtime.shutdown();
  });

  it("names only missing bundles when some are installed and some are not", async () => {
    const skillDir = join(testDir, "partial-deps");
    writeSkill(
      skillDir,
      "multi.md",
      `---
name: multi
description: Multi-dep skill
version: 1.0.0
requires-bundles:
  - "@acme/foo"
  - "@acme/bar"
  - "@acme/baz"
metadata:
  keywords: [multi, deps]
  triggers: ["multi deps"]
---

You use multiple tools.
`,
    );

    const { model, getSystem } = createCapturingModel();
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: model },
      noDefaultBundles: true,
      skillDirs: [skillDir],
    });

    // Seed @acme/foo as installed, leave @acme/bar and @acme/baz missing
    await provisionTestWorkspace(runtime);
    runtime.getLifecycle().seedInstance(deriveServerName("@acme/foo"), "@acme/foo", {
      name: "@acme/foo",
    }, undefined, TEST_WORKSPACE_ID);

    await runtime.chat({ message: "multi deps", workspaceId: TEST_WORKSPACE_ID });

    const system = getSystem();
    expect(system).toContain("Missing dependencies");
    // Only the missing ones should be named
    expect(system).not.toContain("@acme/foo");
    expect(system).toContain("@acme/bar");
    expect(system).toContain("@acme/baz");

    await runtime.shutdown();
  });

  it("does not mutate the original skill object", async () => {
    const skillDir = join(testDir, "no-mutate");
    writeSkill(
      skillDir,
      "immutable.md",
      `---
name: immutable
description: Tests immutability
version: 1.0.0
requires-bundles:
  - "@acme/missing-bundle"
metadata:
  keywords: [immutable, test]
  triggers: ["test immutability"]
---

Original body.
`,
    );

    const { model, getSystem } = createCapturingModel();
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: model },
      noDefaultBundles: true,
      skillDirs: [skillDir],
    });
    await provisionTestWorkspace(runtime);

    // First call — triggers warning
    await runtime.chat({ message: "test immutability", workspaceId: TEST_WORKSPACE_ID });
    const firstSystem = getSystem();
    expect(firstSystem).toContain("Missing dependencies");

    // Second call — should also contain the warning (original skill body not mutated)
    await runtime.chat({ message: "test immutability", workspaceId: TEST_WORKSPACE_ID });
    const secondSystem = getSystem();
    expect(secondSystem).toContain("Missing dependencies");
    expect(secondSystem).toContain("Original body.");

    await runtime.shutdown();
  });

  it("skill still matches even with missing dependencies", async () => {
    const skillDir = join(testDir, "still-matches");
    writeSkill(
      skillDir,
      "matcher.md",
      `---
name: matcher
description: Still matches
version: 1.0.0
requires-bundles:
  - "@acme/nonexistent"
metadata:
  keywords: [match, test]
  triggers: ["match test"]
---

Matching body.
`,
    );

    const { model } = createCapturingModel();
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: model },
      noDefaultBundles: true,
      skillDirs: [skillDir],
    });
    await provisionTestWorkspace(runtime);

    const result = await runtime.chat({ message: "match test", workspaceId: TEST_WORKSPACE_ID });
    expect(result.skillName).toBe("matcher");

    await runtime.shutdown();
  });
});
