/**
 * `skillManagement: false` is an operator kill switch, and a kill switch is only
 * as good as the door that ignores it.
 *
 * `FEATURE_TOOL_MAP` already had the seven mutation tools mapped to the flag,
 * and `test/unit/features.test.ts` already asserted `isToolEnabled` returns
 * false for each — but that pins the MAP, not the enforcement. The skills source
 * built all eleven tools regardless of the flag, so `/mcp` and REST refused them
 * on the way in while the chat door listed them to the model and executed them:
 * with skill management switched off, the agent could still write a skill to
 * disk.
 *
 * These tests exercise the enforcement rather than the predicate. Each one fails
 * if the construction-time filter in `createSkillsSource` is removed.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { IdentityToolRouter } from "../../src/runtime/identity-tool-router.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { makeTestWorkDir } from "../helpers/test-workdir.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

/** The mutation surface `skillManagement` exists to switch off. */
const GATED = [
  "skills__create",
  "skills__update",
  "skills__delete",
  "skills__activate",
  "skills__deactivate",
  "skills__history",
  "skills__restore",
];

/** Reads, which the flag deliberately leaves alone. */
const UNGATED = ["skills__list", "skills__read"];

async function startRuntime(
  workDir: string,
  skillManagement: boolean,
): Promise<Runtime> {
  const runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir,
    features: { skillManagement },
  });
  await provisionTestWorkspace(runtime);
  return runtime;
}

describe("skillManagement: false", () => {
  let runtime: Runtime;
  let dir: { workDir: string; cleanup: () => void };

  beforeAll(async () => {
    dir = makeTestWorkDir("skills-feature-gate-off");
    runtime = await startRuntime(dir.workDir, false);
  });

  afterAll(async () => {
    await runtime?.stop?.();
    dir?.cleanup();
  });

  test("the mutation surface is absent from the workspace tool list", async () => {
    const names = (await runtime.listToolsForWorkspace(TEST_WORKSPACE_ID)).map((t) => t.name);
    for (const tool of GATED) {
      expect(names).not.toContain(tool);
    }
  });

  test("the read surface survives — the flag gates writes, not the whole source", async () => {
    const names = (await runtime.listToolsForWorkspace(TEST_WORKSPACE_ID)).map((t) => t.name);
    for (const tool of UNGATED) {
      expect(names).toContain(tool);
    }
  });

  test("the chat door refuses skills__create and writes nothing", async () => {
    // The door the flag was NOT enforced on. `/mcp` and REST both gate the name
    // before dispatch; the engine's router does not, so if the tool exists it
    // runs. Asserting the refusal alone would pass against a handler that
    // errored for an unrelated reason — so the skill list is checked after.
    const router = new IdentityToolRouter({
      identityId: "dev",
      workspaceId: TEST_WORKSPACE_ID,
      runtime,
    });

    const result = await router.execute({
      id: "t1",
      name: "skills__create",
      input: {
        scope: "workspace",
        manifest: { name: "gated-skill", description: "must not be creatable" },
        body: "# gated",
      },
    });

    expect(result.isError).toBe(true);
    // The refusal comes from the SOURCE, not a door: the tool was never built,
    // so there is nothing for a gate to have missed. Pinning the text keeps this
    // from passing on an unrelated handler error.
    const raw = result.content[0]?.type === "text" ? result.content[0].text : "";
    const refusal = (JSON.parse(raw) as { error?: string }).error ?? "";
    expect(refusal).toContain('Unknown tool "create" in source "skills"');

    const listed = await router.execute({ id: "t2", name: "skills__list", input: {} });
    const text = listed.content[0]?.type === "text" ? listed.content[0].text : "";
    expect(text).not.toContain("gated-skill");
  });
});

describe("skillManagement: true (the default)", () => {
  let runtime: Runtime;
  let dir: { workDir: string; cleanup: () => void };

  beforeAll(async () => {
    dir = makeTestWorkDir("skills-feature-gate-on");
    runtime = await startRuntime(dir.workDir, true);
  });

  afterAll(async () => {
    await runtime?.stop?.();
    dir?.cleanup();
  });

  // The other half of the gate. Without this, filtering the whole source out
  // would pass every assertion above.
  test("the mutation surface is present when the flag is on", async () => {
    const names = (await runtime.listToolsForWorkspace(TEST_WORKSPACE_ID)).map((t) => t.name);
    for (const tool of [...GATED, ...UNGATED]) {
      expect(names).toContain(tool);
    }
  });

  test("the chat door creates a skill when the flag is on", async () => {
    const router = new IdentityToolRouter({
      identityId: "dev",
      workspaceId: TEST_WORKSPACE_ID,
      runtime,
    });

    const result = await router.execute({
      id: "t1",
      name: "skills__create",
      input: {
        scope: "workspace",
        manifest: { name: "allowed-skill", description: "creatable with the flag on" },
        body: "# allowed",
      },
    });

    expect(result.isError).toBe(false);
  });
});
