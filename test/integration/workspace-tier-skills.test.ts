/**
 * Regression test for workspace-tier skill loading from the FOCUSED workspace.
 *
 * Why this test exists: skill loading once read workspace-tier skills from
 * the caller's session workspace instead of the focused one, so a
 * workspace-tier skill in any other workspace silently disappeared from agent
 * context. Loading reads from the one workspace the turn runs in.
 *
 * The focused-workspace guarantee applies to both kinds of workspace skill,
 * which this file covers:
 *   - A bound skill (`dynamic` + tool-affinity) waits for its tool's first
 *     call (ADR-0053), surfaced via `describeRequestSkills().bound`.
 *   - A context skill (`always`) composes into the always-on context channel,
 *     surfaced via `describeRequestSkills().context`.
 * Channel ROUTING itself (role → channel) is unit-tested in
 * `partitionSkillsByRole`; here we pin the focused-workspace + end-to-end
 * behavior for each channel.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { asDevUser, devProvider, devWorkspace } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { firstStoredEvent } from "../helpers/stored-events.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const SHARED_SKILL_NAME = "shared-voice-rules";
const SHARED_SKILL_BODY =
  "Always answer in plain English. Avoid em-dashes. Match the user's voice.";

const testDir = join(tmpdir(), `nimblebrain-ws-tier-skills-${Date.now()}`);
const HOME_WORKSPACE_ID = "ws_003f694718dd468d";
let runtime: Runtime;

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });

  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir: testDir,
    telemetry: { enabled: false },
  });
  // The dev user's default workspace (provisioned first, so it is the earliest
  // membership): where a request that names no workspace runs.
  await provisionTestWorkspace(runtime, HOME_WORKSPACE_ID, "Home");
  await provisionTestWorkspace(runtime);

  // Plant a workspace-tier bound skill (dynamic + tool-affinity) in the
  // FOCUSED workspace. Loading must read from the workspace the turn runs in.
  const sharedSkillsDir = join(testDir, "workspaces", TEST_WORKSPACE_ID, "skills");
  mkdirSync(sharedSkillsDir, { recursive: true });
  writeFileSync(
    join(sharedSkillsDir, `${SHARED_SKILL_NAME}.md`),
    `---\nname: ${SHARED_SKILL_NAME}\ndescription: Team workflow rules\nmetadata:\n  nimblebrain:\n    loading-strategy: dynamic\n    tool-affinity: ["nb__*"]\n    priority: 30\n---\n\n${SHARED_SKILL_BODY}\n`,
  );
});

afterAll(async () => {
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("workspace-tier skills load from the focused workspace", () => {
  it("does not compose the focused workspace's bound skill at turn start", async () => {
    const chat = await runtime.chat({
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      message: "hello",
    });

    const store = await runtime.resolveConversationStore(chat.conversationId);
    const events = await store!.readEvents(chat.conversationId);
    const skillsLoaded = firstStoredEvent(events, "skills.loaded");
    expect(skillsLoaded).toBeDefined();
    expect(skillsLoaded.skills.some((s) => s.name === SHARED_SKILL_NAME)).toBe(false);
  });

  it("reports the focused workspace's bound skill on the status surface (describeRequestSkills)", async () => {
    // A status path that read a boot-time cache would show only platform/core
    // skills. `describeRequestSkills` reads through the SAME loaders `chat`
    // uses, so the two surfaces cannot disagree.
    const { bound } = await asDevUser(() => runtime.describeRequestSkills(TEST_WORKSPACE_ID));
    const entry = bound.find((s) => s.manifest.name === SHARED_SKILL_NAME);
    expect(entry).toBeDefined();
    expect(entry?.manifest.scope).toBe("workspace");
    expect(entry?.manifest.toolAffinity).toEqual(["nb__*"]);
  });

  it("composes a workspace-tier `always` skill into the context channel, not the bound set", async () => {
    // An always-on workspace CONTEXT skill reaches the prompt via the context
    // channel (Layer 0/1), surfaced by describeRequestSkills().context. It must
    // NOT be silently dropped, and it is never also bound.
    const ctxName = "shared-context-rule";
    const dir = join(testDir, "workspaces", TEST_WORKSPACE_ID, "skills");
    writeFileSync(
      join(dir, `${ctxName}.md`),
      `---\nname: ${ctxName}\ndescription: Team voice\nmetadata:\n  nimblebrain:\n    loading-strategy: always\n    priority: 30\n---\n\nMatch the user's voice.\n`,
    );

    const { context, bound } = await asDevUser(() =>
      runtime.describeRequestSkills(TEST_WORKSPACE_ID),
    );
    expect(context.some((s) => s.manifest.name === ctxName)).toBe(true);
    expect(context.find((s) => s.manifest.name === ctxName)?.manifest.scope).toBe("workspace");
    expect(bound.some((s) => s.manifest.name === ctxName)).toBe(false);
  });

  it("does NOT bind the focused workspace's skill in the caller's home workspace", async () => {
    // A turn in the caller's own (default) workspace takes workspace-tier
    // skills from there, NOT from another workspace the user happens to belong
    // to. This pins the one-workspace semantic so a future refactor toward
    // "load across every accessible workspace" becomes a deliberate decision,
    // not an accidental one.
    const homeWsId = await devWorkspace(runtime);
    const { bound } = await asDevUser(() => runtime.describeRequestSkills(homeWsId));
    expect(bound.some((s) => s.manifest.name === SHARED_SKILL_NAME)).toBe(false);
  });

  it("walls listActivatableSkills to the named workspace (real loader, no stubs)", async () => {
    // The activatable set backs both the rendered catalog and nb__use_skill
    // name validation, so the wall must hold on the REAL loader composition,
    // not a FakeRuntime. Plant a dynamic skill in another workspace and
    // assert each workspace's set sees only its own tier.
    const otherWsId = "ws_005adedf64e87a2c";
    const otherName = "other-only-playbook";
    const otherSkillsDir = join(testDir, "workspaces", otherWsId, "skills");
    mkdirSync(otherSkillsDir, { recursive: true });
    writeFileSync(
      join(otherSkillsDir, `${otherName}.md`),
      `---\nname: ${otherName}\ndescription: Other drafting playbook\nmetadata:\n  nimblebrain:\n    loading-strategy: dynamic\n---\n\nDraft like me.\n`,
    );

    const sharedSet = await runtime.listActivatableSkills(TEST_WORKSPACE_ID, DEV_IDENTITY.id);
    expect(sharedSet.some((s) => s.name === SHARED_SKILL_NAME)).toBe(true);
    expect(sharedSet.some((s) => s.name === otherName)).toBe(false);

    const otherSet = await runtime.listActivatableSkills(otherWsId, DEV_IDENTITY.id);
    expect(otherSet.some((s) => s.name === otherName)).toBe(true);
    expect(otherSet.some((s) => s.name === SHARED_SKILL_NAME)).toBe(false);
  });
});
