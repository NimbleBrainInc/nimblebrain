/**
 * Create-derivation + visibility, end-to-end (issue #391, Task 005).
 *
 * Complements `skills-per-request-matcher.test.ts` (the trigger path). This
 * pins the OTHER half of the fix through the full stack — the real registry,
 * the real `skills__create` handler, `loadConversationSkills` reading
 * `users/<id>/skills/`, Layer-3 `always` selection, and prompt composition:
 *
 *  1. A user-scope `type: skill` created with NO triggers, NO keywords, and
 *     NO loading strategy — the exact shape the issue reports as dead — now
 *     LOADS. `createSkill` derives `loading-strategy: always` (Task 003), and
 *     its body composes into a chat with an unrelated message. On `main` the
 *     create writes no strategy, Layer-3 skips it, and the body is absent —
 *     so this fails on `main`. It is a genuine regression guard.
 *
 *  2. The created file is self-describing: `loading-strategy: always` is
 *     persisted to the frontmatter (not just in-memory).
 *
 *  3. A hand-authored dead skill (no strategy/triggers, never written through
 *     the deriving handler) is flagged by `skills__list` as never-loading —
 *     the zero-signal failure mode is now visible.
 *
 * The capturing model records the composed system prompt; a per-skill unique
 * body phrase makes "did it load?" an unambiguous substring check.
 */

import type { LanguageModelV3 } from "@ai-sdk/provider";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractText } from "../../src/engine/content-helpers.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

const DERIVED_SKILL_NAME = "user-orbital-protocol";
const DERIVED_BODY = "Follow the orbital docking protocol precisely.";
const DEAD_SKILL_NAME = "user-stranded-note";

const testDir = join(tmpdir(), `nimblebrain-always-loading-${Date.now()}`);
let runtime: Runtime;
let getSystem: () => string;

/** Model that captures the composed system prompt (ignores auto-title calls). */
function createCapturingModel(): { model: LanguageModelV3; getSystem: () => string } {
  let captured = "";
  const model = createMockModel((options) => {
    const systemMsg = options.prompt.find((m) => m.role === "system");
    if (systemMsg && typeof systemMsg.content === "string") {
      if (!systemMsg.content.includes("Generate a 3-6 word title")) {
        captured = systemMsg.content;
      }
    }
    return { content: [{ type: "text", text: "ok" }], inputTokens: 10, outputTokens: 5 };
  });
  return { model, getSystem: () => captured };
}

/** Run a tool through the workspace registry as the dev identity. */
async function callToolAsDev(
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  const registry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
  const result = await runWithRequestContext(
    {
      identity: DEV_IDENTITY,
      scope: {
        kind: "workspace",
        workspaceId: TEST_WORKSPACE_ID,
        workspaceAgents: null,
        workspaceModelOverride: null,
      },
    },
    () => registry.execute({ id: `test-${toolName}`, name: toolName, input }),
  );
  return { content: extractText(result.content), isError: result.isError ?? false };
}

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  const cap = createCapturingModel();
  getSystem = cap.getSystem;
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: cap.model },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
    telemetry: { enabled: false },
  });
  await provisionTestWorkspace(runtime);
});

afterAll(async () => {
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("created strategy-less skill loads (auto-derived always)", () => {
  it("composes a created trigger-less user `type: skill` into an unrelated chat", async () => {
    const create = await callToolAsDev("skills__create", {
      scope: "user",
      manifest: {
        name: DERIVED_SKILL_NAME,
        description: "Orbital docking how-to",
        type: "skill",
        priority: 50,
      },
      body: DERIVED_BODY,
    });
    expect(create.isError).toBe(false);

    // A message with no relation to the skill. On `main` this body never
    // appears (no strategy ⇒ Layer-3 skips it, no triggers ⇒ matcher skips it).
    await runtime.chat({ workspaceId: TEST_WORKSPACE_ID, message: "what is 2 + 2?" });
    expect(getSystem()).toContain(DERIVED_BODY);
  });

  it("persists `loading-strategy: always` to the created file (self-describing)", () => {
    const path = join(testDir, "users", DEV_IDENTITY.id, "skills", `${DERIVED_SKILL_NAME}.md`);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toContain("loading-strategy: always");
  });
});

describe("dead-state visibility", () => {
  it("flags a hand-authored strategy-less, trigger-less skill in skills__list", async () => {
    // Written directly to disk — never through the deriving handler — so it
    // stays dead, exactly the population the visibility signal exists for.
    const dir = join(testDir, "users", DEV_IDENTITY.id, "skills");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${DEAD_SKILL_NAME}.md`),
      `---
name: ${DEAD_SKILL_NAME}
description: Stranded note
version: 1.0.0
type: skill
priority: 50
---

This skill can never load.
`,
    );

    const list = await callToolAsDev("skills__list", { scope: "user" });
    expect(list.isError).toBe(false);
    expect(list.content).toContain(DEAD_SKILL_NAME);
    expect(list.content).toContain("never loads");
  });
});
