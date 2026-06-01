/**
 * Regression test for Layer 3 workspace-tier skill loading.
 *
 * A skill at `{workDir}/workspaces/<focusedWsId>/skills/` with
 * `loading_strategy: always` must reach the `skills.loaded` event when a
 * chat is focused on that workspace, regardless of which workspace is the
 * session (personal) workspace.
 *
 * Why this test exists: Stage 2 (#272) wired Layer 3 selection to read
 * workspace-tier skills from the session (personal) workspace instead of
 * the focused workspace. The result was that any workspace-tier skill in
 * a non-personal workspace — the typical place for team-wide voice rules,
 * org schema notes, etc. — silently disappeared from agent context. The
 * fix passes `focusedWsId ?? sessionWsId` into `loadConversationSkills`.
 *
 * Failure mode the test pins: load the focused-workspace skill and assert
 * it lands in the recorded `skills.loaded` skills array.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { personalWorkspaceIdFor } from "../../src/workspace/workspace-store.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

const SHARED_SKILL_NAME = "shared-voice-rules";
const SHARED_SKILL_BODY =
  "Always answer in plain English. Avoid em-dashes. Match the user's voice.";

const testDir = join(tmpdir(), `nimblebrain-ws-tier-skills-${Date.now()}`);
let runtime: Runtime;

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });

  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
    telemetry: { enabled: false },
  });
  await provisionTestWorkspace(runtime);

  // Plant a workspace-tier `loading_strategy: always` skill in the FOCUSED
  // (shared) workspace — not the personal workspace. The session workspace
  // (personalWorkspaceIdFor(DEV_IDENTITY.id)) is a different dir on disk;
  // before the fix, Layer 3 read from there and never saw this file.
  const sharedSkillsDir = join(testDir, "workspaces", TEST_WORKSPACE_ID, "skills");
  mkdirSync(sharedSkillsDir, { recursive: true });
  writeFileSync(
    join(sharedSkillsDir, `${SHARED_SKILL_NAME}.md`),
    `---\nname: ${SHARED_SKILL_NAME}\ndescription: Team voice rules\nversion: 1.0.0\ntype: context\npriority: 30\nloading_strategy: always\n---\n\n${SHARED_SKILL_BODY}\n`,
  );
});

afterAll(async () => {
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("Layer 3 — workspace-tier `loading_strategy: always` skills", () => {
  it("loads the focused workspace's `always` skill into `skills.loaded`", async () => {
    // Sanity check the precondition: the focused workspace MUST be a
    // different dir than the session (personal) workspace, otherwise the
    // test can't distinguish "loaded from focused" from "loaded from
    // session" — the regression we're guarding against.
    const personalWsId = personalWorkspaceIdFor(DEV_IDENTITY.id);
    expect(personalWsId).not.toBe(TEST_WORKSPACE_ID);

    const chat = await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: "hello",
    });

    const store = runtime.findConversationStore();
    const events = await store.readEvents(chat.conversationId);
    const skillsLoaded = events.find((e) => e.type === "skills.loaded");
    expect(skillsLoaded).toBeDefined();

    const payload = skillsLoaded as unknown as {
      skills: Array<{
        id: string;
        scope: string;
        loadedBy: string;
        reason: string;
      }>;
    };

    // Match by the file path the loader records as id — workspace-tier
    // skills carry their on-disk path, NOT a `skill://` URI (that's the
    // bundle-tier shape).
    const expectedPath = join(
      testDir,
      "workspaces",
      TEST_WORKSPACE_ID,
      "skills",
      `${SHARED_SKILL_NAME}.md`,
    );
    const entry = payload.skills.find((s) => s.id === expectedPath);
    expect(entry).toBeDefined();
    expect(entry?.scope).toBe("workspace");
    expect(entry?.loadedBy).toBe("always");
  });

  it("reports the focused workspace's `always` skill on the status surface (describeRequestSkills)", async () => {
    // Regression for the second half of the shared-workspace report: a
    // workspace-tier `always` skill composed into the prompt (asserted above)
    // but `nb__status scope:skills` showed only platform/core skills, because
    // the status path read a boot-time cache instead of the per-request Layer-3
    // set. `describeRequestSkills` now reports through the SAME path `chat`
    // composes with, so the two surfaces can no longer disagree.
    const { layer3 } = await runtime.describeRequestSkills(TEST_WORKSPACE_ID);
    const entry = layer3.find((s) => s.skill.manifest.name === SHARED_SKILL_NAME);
    expect(entry).toBeDefined();
    expect(entry?.skill.manifest.scope).toBe("workspace");
    expect(entry?.loadedBy).toBe("always");
  });

  it("does NOT load the focused workspace's skill when chatting from home (no focus)", async () => {
    // Home control panel = no `workspaceId` on the request. Layer 3
    // workspace-tier skills should fall back to the session (personal)
    // workspace, NOT bleed in from a workspace the user happens to
    // belong to. This pins the `focusedWsId ?? sessionWsId` semantic so a
    // future refactor toward "load across every accessible workspace"
    // becomes a deliberate decision, not an accidental one.
    const chat = await runtime.chat({
      // No workspaceId — home mode.
      message: "hello from home",
    });

    const store = runtime.findConversationStore();
    const events = await store.readEvents(chat.conversationId);
    const skillsLoaded = events.find((e) => e.type === "skills.loaded");
    expect(skillsLoaded).toBeDefined();

    const payload = skillsLoaded as unknown as {
      skills: Array<{ id: string }>;
    };
    const expectedPath = join(
      testDir,
      "workspaces",
      TEST_WORKSPACE_ID,
      "skills",
      `${SHARED_SKILL_NAME}.md`,
    );
    const entry = payload.skills.find((s) => s.id === expectedPath);
    expect(entry).toBeUndefined();
  });
});
