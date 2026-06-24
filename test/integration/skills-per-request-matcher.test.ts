/**
 * Per-request trigger/keyword matcher (issue #391, Task 002).
 *
 * The boot-time `SkillMatcher` only ever scans org-tier skill dirs
 * (`{workDir}/skills/`), never `workspaces/<id>/skills/` or
 * `users/<id>/skills/`. So a user-scope `type: skill` with trigger phrases
 * could never fire on a chat message — it loaded nowhere.
 *
 * The fix builds the matcher per-request from the merged conversation pool
 * (`loadConversationSkills`, which folds org + workspace + user together).
 * This test pins the behavior end-to-end through `runtime.chat()`:
 *
 *  1. A user-tier `type: skill` with `metadata.triggers` IS matched for a
 *     message containing its trigger phrase (the bug — it never matched
 *     before, because the boot matcher doesn't read the user dir).
 *  2. An org-tier `type: skill` with triggers STILL matches (no regression:
 *     the org tier is folded into the same pool, so the pre-existing boot
 *     matchable set is a subset of the per-request pool).
 *
 * Observable signal: `ChatResult.skillName` — the runtime sets it to the
 * matched skill's manifest name (or null). A plain unique phrase per skill
 * avoids any cross-match between the two.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

const USER_SKILL_NAME = "user-deploy-widget";
const USER_TRIGGER = "deploy the orbital widget";

const ORG_SKILL_NAME = "org-rotate-credential";
const ORG_TRIGGER = "rotate the vault credential";

const testDir = join(tmpdir(), `nimblebrain-per-request-matcher-${Date.now()}`);
let runtime: Runtime;

function writeTriggerSkill(dir: string, name: string, trigger: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---
name: ${name}
description: Trigger skill for ${name}
metadata:
  nimblebrain:
    loading-strategy: dynamic
    priority: 50
    triggers:
      - "${trigger}"
---

Body for ${name}.
`,
  );
}

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });

  // Org-tier skill must exist on disk BEFORE boot so the boot matcher picks
  // it up — that's the path we're asserting still works.
  writeTriggerSkill(join(testDir, "skills"), ORG_SKILL_NAME, ORG_TRIGGER);

  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
    telemetry: { enabled: false },
  });
  await provisionTestWorkspace(runtime);

  // User-tier skill, planted post-boot under `users/<userId>/skills/`. The
  // boot matcher never reads this dir; only the per-request pool does.
  writeTriggerSkill(
    join(testDir, "users", DEV_IDENTITY.id, "skills"),
    USER_SKILL_NAME,
    USER_TRIGGER,
  );
});

afterAll(async () => {
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("per-request skill matcher", () => {
  it("matches a user-tier `type: skill` on its trigger phrase", async () => {
    const chat = await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: `Please ${USER_TRIGGER} now.`,
    });
    // Pre-fix this was null: the boot matcher never scanned the user dir.
    expect(chat.skillName).toBe(USER_SKILL_NAME);
  });

  it("still matches an org-tier `type: skill` on its trigger phrase (no regression)", async () => {
    const chat = await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: `Can you ${ORG_TRIGGER}?`,
    });
    expect(chat.skillName).toBe(ORG_SKILL_NAME);
  });

  it("matches no skill when the message contains neither trigger", async () => {
    const chat = await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: "just a plain unrelated greeting",
    });
    expect(chat.skillName).toBeNull();
  });
});
