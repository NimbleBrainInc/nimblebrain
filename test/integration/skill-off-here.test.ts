/**
 * A person's own skill turned off in one workspace (ADR-0072), end to end:
 * `skills__set_here` writes the person's record, and every run in that
 * workspace (a chat, a task) collects the user tier without the skill, so it
 * leaves the prompt and the catalog there and nowhere else.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { extractText } from "../../src/engine/content-helpers.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { skillsOffIn } from "../../src/identity/skills-off-store.ts";
import type { SkillsListOutput, SkillsSetHereOutput } from "../../src/platform/schemas/skills.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const WS_HERE = TEST_WORKSPACE_ID;
const WS_ELSEWHERE = "ws_1a2b3c4d5e6f7a8b";
const OTHER = { ...DEV_IDENTITY, id: "usr_other_member" };

const VOICE = "my-voice";
const VOICE_BODY = "Sign every answer VOICE-SENTINEL-91.";
const OTHER_VOICE_BODY = "Sign every answer OTHER-SENTINEL-44.";
const SHELF = "my-shelf-skill";
const SHARED = "house-style";
const USER_SHARED_BODY = "Write in USER-STYLE-SENTINEL.";
const WS_SHARED_BODY = "Write in WORKSPACE-STYLE-SENTINEL.";

const testDir = join(tmpdir(), `nimblebrain-skill-off-here-${Date.now()}`);
let runtime: Runtime;
let captured = "";

function createCapturingModel(): LanguageModelV4 {
  return createMockModel((options) => {
    const systemMsg = options.prompt.find((m) => m.role === "system");
    if (systemMsg && typeof systemMsg.content === "string") {
      if (!systemMsg.content.includes("Generate a 3-6 word title")) captured = systemMsg.content;
    }
    return { content: [{ type: "text", text: "ok" }], inputTokens: 10, outputTokens: 5 };
  });
}

function writeSkill(dir: string, name: string, strategy: "always" | "dynamic", body: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---
name: ${name}
description: ${name} guidance
metadata:
  nimblebrain:
    loading-strategy: ${strategy}
    priority: 50
---

${body}
`,
  );
}

const userDir = (userId: string) => join(testDir, "users", userId, "skills");
const devSkillPath = (name: string) => join(userDir(DEV_IDENTITY.id), `${name}.md`);

async function startRuntime(): Promise<Runtime> {
  const rt = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createCapturingModel(),
    logging: { disabled: true },
    workDir: testDir,
    telemetry: { enabled: false },
  });
  const members = [DEV_IDENTITY.id, OTHER.id];
  await provisionTestWorkspace(rt, WS_HERE, "Here", members);
  await provisionTestWorkspace(rt, WS_ELSEWHERE, "Elsewhere", members);
  return rt;
}

async function callTool(
  wsId: string,
  name: string,
  input: Record<string, unknown>,
  identity = DEV_IDENTITY,
) {
  const registry = runtime.getRegistryForWorkspace(wsId);
  const result = await runWithRequestContext({ identity, workspaceId: wsId }, () =>
    registry.execute({ id: `t-${name}`, name, input }),
  );
  return {
    text: extractText(result.content),
    isError: result.isError ?? false,
    structured: result.structuredContent,
  };
}

async function setHere(wsId: string, name: string, on: boolean) {
  const res = await callTool(wsId, "skills__set_here", { id: devSkillPath(name), on });
  expect(res.isError).toBe(false);
  const out = res.structured as SkillsSetHereOutput;
  expect(out).toEqual({ id: devSkillPath(name), name, workspaceId: wsId, onHere: on });
}

async function systemPromptOfChat(wsId: string, identity = DEV_IDENTITY): Promise<string> {
  captured = "";
  await runtime.chat({ identity, workspaceId: wsId, message: "what is 2 + 2?" });
  return captured;
}

async function userListing(wsId: string): Promise<SkillsListOutput["skills"]> {
  const res = await callTool(wsId, "skills__list", { scope: "user" });
  expect(res.isError).toBe(false);
  return (res.structured as SkillsListOutput).skills;
}

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  writeSkill(userDir(DEV_IDENTITY.id), VOICE, "always", VOICE_BODY);
  writeSkill(userDir(DEV_IDENTITY.id), SHELF, "dynamic", "Shelf body.");
  writeSkill(userDir(DEV_IDENTITY.id), SHARED, "always", USER_SHARED_BODY);
  writeSkill(userDir(OTHER.id), VOICE, "always", OTHER_VOICE_BODY);
  runtime = await startRuntime();
  writeSkill(
    runtime.getWorkspaceContext(WS_HERE).getDataPath("skills"),
    SHARED,
    "always",
    WS_SHARED_BODY,
  );
});

afterAll(async () => {
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("a person's own skill, turned off in one workspace", () => {
  it("applies everywhere before it is turned off, and yours wins a shared name", async () => {
    const here = await systemPromptOfChat(WS_HERE);
    expect(here).toContain(VOICE_BODY);
    expect(here).toContain(USER_SHARED_BODY);
    expect(here).not.toContain(WS_SHARED_BODY);
    expect((await userListing(WS_HERE)).every((s) => s.onHere === true)).toBe(true);
  });

  it("leaves that workspace's runs and catalog, and only that workspace's", async () => {
    await setHere(WS_HERE, VOICE, false);
    await setHere(WS_HERE, SHELF, false);

    expect(await systemPromptOfChat(WS_HERE)).not.toContain(VOICE_BODY);
    const catalogHere = (await runtime.listActivatableSkills(WS_HERE, DEV_IDENTITY.id)).map(
      (s) => s.name,
    );
    expect(catalogHere).not.toContain(SHELF);

    expect(await systemPromptOfChat(WS_ELSEWHERE)).toContain(VOICE_BODY);
    const catalogElsewhere = (
      await runtime.listActivatableSkills(WS_ELSEWHERE, DEV_IDENTITY.id)
    ).map((s) => s.name);
    expect(catalogElsewhere).toContain(SHELF);
  });

  it("holds for an unattended run in that workspace, which runs as the person", async () => {
    captured = "";
    await runtime.executeTask({
      identity: DEV_IDENTITY,
      workspaceId: WS_HERE,
      prompt: "say hi",
      trigger: "schedule",
    });
    expect(captured).not.toContain(VOICE_BODY);
    expect(captured).toContain(USER_SHARED_BODY);
  });

  it("does not touch another member's own skill of the same name", async () => {
    expect(await systemPromptOfChat(WS_HERE, OTHER)).toContain(OTHER_VOICE_BODY);
  });

  it("lets a same-named workspace skill win that workspace", async () => {
    await setHere(WS_HERE, SHARED, false);
    const here = await systemPromptOfChat(WS_HERE);
    expect(here).toContain(WS_SHARED_BODY);
    expect(here).not.toContain(USER_SHARED_BODY);
  });

  it("is reported by the user-scope listing for each workspace", async () => {
    const here = await userListing(WS_HERE);
    const onHere = (list: typeof here, name: string) => list.find((s) => s.name === name)?.onHere;
    expect(onHere(here, VOICE)).toBe(false);
    expect(onHere(here, SHELF)).toBe(false);
    const elsewhere = await userListing(WS_ELSEWHERE);
    expect(onHere(elsewhere, VOICE)).toBe(true);
  });

  it("survives a restart", async () => {
    await runtime.shutdown();
    runtime = await startRuntime();
    expect(await systemPromptOfChat(WS_HERE)).not.toContain(VOICE_BODY);
    expect((await userListing(WS_HERE)).find((s) => s.name === VOICE)?.onHere).toBe(false);
  });

  it("comes back when turned on", async () => {
    await setHere(WS_HERE, VOICE, true);
    expect(await systemPromptOfChat(WS_HERE)).toContain(VOICE_BODY);
    expect((await userListing(WS_HERE)).find((s) => s.name === VOICE)?.onHere).toBe(true);
  });

  it("refuses a workspace skill", async () => {
    const wsSkill = join(
      runtime.getWorkspaceContext(WS_HERE).getDataPath("skills"),
      `${SHARED}.md`,
    );
    const res = await callTool(WS_HERE, "skills__set_here", { id: wsSkill, on: false });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("user-scope");
  });

  it("refuses another person's skill", async () => {
    const theirs = join(userDir(OTHER.id), `${VOICE}.md`);
    const res = await callTool(WS_HERE, "skills__set_here", { id: theirs, on: false });
    expect(res.isError).toBe(true);
  });

  it("forgets its offs when the skill is deleted", async () => {
    expect(skillsOffIn(testDir, DEV_IDENTITY.id, WS_HERE).has(SHELF)).toBe(true);
    const del = await callTool(WS_HERE, "skills__delete", { id: devSkillPath(SHELF) });
    expect(del.isError).toBe(false);
    expect(skillsOffIn(testDir, DEV_IDENTITY.id, WS_HERE).has(SHELF)).toBe(false);
    // A new skill of the same name starts on.
    writeSkill(userDir(DEV_IDENTITY.id), SHELF, "dynamic", "Shelf body again.");
    const names = (await runtime.listActivatableSkills(WS_HERE, DEV_IDENTITY.id)).map(
      (s) => s.name,
    );
    expect(names).toContain(SHELF);
  });
});
