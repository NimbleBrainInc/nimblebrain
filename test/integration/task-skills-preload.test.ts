/**
 * A task's `skill` field puts the named skills in every run's cached system
 * prefix, so the run never spends a call loading them and runs with different
 * inputs share that prefix byte for byte. A name the workspace cannot resolve
 * refuses the run before its first model call, and `nb__use_skill` answers
 * `already_loaded` for a skill the run already carries.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { DeclaredSkillsUnavailableError } from "../../src/runtime/errors.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { type RecordingModel, recordingModel } from "../helpers/recording-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const RUNBOOK = { name: "invoice-runbook", body: "Reconcile line items before posting." };
const CHECKLIST = { name: "close-checklist", body: "Confirm every account balances to zero." };
const AFFINITY = { name: "always-near-tools", body: "Prefer the narrowest tool for the job." };

const dir = join(tmpdir(), `nimblebrain-task-skills-${Date.now()}`);
let runtime: Runtime;
let rec: RecordingModel;

function writeSkill(name: string, body: string, affinity?: string): void {
  const skillsDir = join(dir, "workspaces", TEST_WORKSPACE_ID, "skills");
  mkdirSync(skillsDir, { recursive: true });
  const affinityLine = affinity ? `\n    tool-affinity: ["${affinity}"]` : "";
  writeFileSync(
    join(skillsDir, `${name}.md`),
    `---\nname: ${name}\ndescription: How to ${name}\nmetadata:\n  nimblebrain:\n    loading-strategy: dynamic${affinityLine}\n---\n\n${body}\n`,
  );
}

/** The system text of the recorded call at `index`. */
function systemOf(index: number): string {
  const prompt: LanguageModelV4Prompt = rec.calls[index]?.prompt ?? [];
  return prompt
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

beforeAll(async () => {
  mkdirSync(dir, { recursive: true });
  // The first run's script: try to load a skill the task already carries.
  rec = recordingModel(
    createEchoModel({
      responses: [
        {
          toolCalls: [
            {
              toolCallId: "call-use",
              toolName: "nb__use_skill",
              input: JSON.stringify({ name: RUNBOOK.name }),
            },
          ],
        },
        { text: "done" },
      ],
    }),
  );
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: rec.model,
    logging: { disabled: true },
    workDir: dir,
    telemetry: { enabled: false },
  });
  await provisionTestWorkspace(runtime);
  writeSkill(RUNBOOK.name, RUNBOOK.body);
  writeSkill(CHECKLIST.name, CHECKLIST.body);
  writeSkill(AFFINITY.name, AFFINITY.body, "nb__*");
});

afterAll(async () => {
  await runtime.shutdown();
  if (existsSync(dir)) rmSync(dir, { recursive: true });
});

const run = (prompt: string, skills: string[]) =>
  runtime.executeTask({
    identity: DEV_IDENTITY,
    workspaceId: TEST_WORKSPACE_ID,
    prompt,
    trigger: "manual",
    skills,
  });

describe("a task's skills", () => {
  it("answers already_loaded when the run asks for a skill it carries", async () => {
    const result = await run("reconcile this month", [RUNBOOK.name]);
    const use = result.toolCalls.find((c) => c.name === "nb__use_skill");
    expect(use?.ok).toBe(true);
    expect(use?.output).toContain("already loaded");
    expect(use?.output).not.toContain(RUNBOOK.body);
  });

  it("composes one name or a list into the cached prefix, the same bytes across inputs", async () => {
    const before = rec.calls.length;
    await run("close March", [RUNBOOK.name, CHECKLIST.name]);
    await run("close April, and flag anything odd", [RUNBOOK.name, CHECKLIST.name]);
    const first = systemOf(before);
    const second = systemOf(before + 1);

    expect(first).toContain(RUNBOOK.body);
    expect(first).toContain(CHECKLIST.body);
    expect(first).toContain("loaded: task");
    expect(second).toBe(first);
    // Neither is offered in the catalog: the run already has both.
    expect(first).not.toContain(`- ${RUNBOOK.name}`);
    expect(first).not.toContain(`- ${CHECKLIST.name}`);
  });

  it("composes a skill tool-affinity already selected once", async () => {
    const before = rec.calls.length;
    await run("tidy up", [AFFINITY.name]);
    expect(count(systemOf(before), AFFINITY.body)).toBe(1);
    // A skill this task does not name stays in the catalog, on demand.
    expect(systemOf(before)).toContain(`- ${RUNBOOK.name}`);
  });

  it("refuses a run whose task names a skill the workspace does not have", async () => {
    const before = rec.calls.length;
    const err = await run("close May", [RUNBOOK.name, "no-such-skill"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeclaredSkillsUnavailableError);
    expect((err as DeclaredSkillsUnavailableError).code).toBe("declared_skills_unavailable");
    expect((err as DeclaredSkillsUnavailableError).skills).toEqual(["no-such-skill"]);
    expect(rec.calls.length).toBe(before);
  });
});
