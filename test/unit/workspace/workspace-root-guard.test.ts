/**
 * A writer may create a file inside a workspace; it may not create the workspace.
 *
 * `WorkspaceStore.delete` renames a workspace's subtree out from under every
 * writer holding a path into it. Those writers mkdir recursively, so the first
 * one to fire after the rename used to re-create the deleted workspace's
 * directory and write into it — invisibly, because `list()` skips a workspace
 * directory with no parseable `workspace.json`, so the resurrected tree
 * appeared nowhere and was never deleted again.
 *
 * The rule is therefore at the mkdir rather than in each writer: a workspace
 * root comes from `WorkspaceStore.create`, and everything else may only create
 * paths inside a root that is already there. This file drives each
 * workspace-scoped writer against a workspace that is gone and asserts the
 * refusal names the workspace — and then drives the same write inside a live
 * root, because "create your own subdirectory on first write" is still how
 * conversations, files, notifications and automations are meant to behave.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import { EventSourcedConversationStore } from "../../../src/conversation/event-sourced-store.ts";
import { workspaceConversationsDir } from "../../../src/conversation/paths.ts";
import { workspaceFilesDir } from "../../../src/files/paths.ts";
import { createFileStore } from "../../../src/files/store.ts";
import { parseNotificationEnvelope } from "../../../src/notifications/envelope.ts";
import { NotificationStore } from "../../../src/notifications/store.ts";
import type { NotificationEnvelope } from "../../../src/notifications/types.ts";
import {
  automationRunsDir,
  workspaceAutomationsDir,
} from "../../../src/platform/automations/paths.ts";
import { appendRun, saveAutomation } from "../../../src/platform/automations/store.ts";
import type { Automation, AutomationRun } from "../../../src/platform/automations/types.ts";
import { materializeConnectorSkill } from "../../../src/skills/connector-skill-store.ts";
import { writeSkill } from "../../../src/skills/writer.ts";
import {
  ensureWorkspaceDir,
  WorkspaceContext,
  WorkspaceRootMissingError,
} from "../../../src/workspace/context.ts";
import { seedWorkspaceRoot } from "../../helpers/test-workspace.ts";

const WS = "ws_0123456789abcdef";
const OWNER = "usr_writer";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-ws-root-guard-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function ctx(): WorkspaceContext {
  return new WorkspaceContext({ wsId: WS, workDir });
}

function automation(): Automation {
  return {
    id: "daily-digest",
    name: "Daily digest",
    prompt: "summarize",
    schedule: { type: "interval", intervalMs: 60_000 },
    enabled: true,
    workspaceId: WS,
    ownerId: OWNER,
    source: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function run(): AutomationRun {
  return {
    id: "run_1",
    automationId: "daily-digest",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    status: "success",
    inputTokens: 1,
    outputTokens: 1,
    toolCalls: 0,
    iterations: 1,
  };
}

function envelope(): NotificationEnvelope {
  const parsed = parseNotificationEnvelope({
    eventId: "evt_01",
    name: "domain.active",
    timestamp: "2026-09-01T18:42:10Z",
    data: {},
  });
  if (!parsed) throw new Error("fixture did not parse");
  return parsed;
}

const OVERLAY = `---
name: gmail-usage
description: How to use the Gmail connector
---

Confirm the recipient before calling gmail__send.
`;

/**
 * One entry per workspace-scoped writer the delete path leaves holding a stale
 * path. Each `write` is the first touch — the call that used to mkdir its way
 * back into a workspace that had just been archived.
 */
const WRITERS: Array<{ name: string; write: () => void | Promise<void> }> = [
  {
    name: "automations — a definition",
    write: () => saveAutomation(workDir, WS, OWNER, automation()),
  },
  {
    name: "automations — a run summary",
    write: () => appendRun(workDir, WS, OWNER, "daily-digest", run()),
  },
  {
    name: "conversations — the owner partition",
    write: () => {
      new EventSourcedConversationStore({ dir: workspaceConversationsDir(workDir, WS, OWNER) });
    },
  },
  {
    name: "files — the owner partition",
    write: () => createFileStore(workspaceFilesDir(workDir, WS, OWNER)).ensureFilesDir(),
  },
  {
    name: "notifications — the inbox",
    write: () => {
      new NotificationStore(ctx(), { eventSink: new NoopEventSink() }).append("gmail", envelope());
    },
  },
  {
    name: "skills — an authored workspace skill",
    write: () => {
      writeSkill(
        ctx().getDataPath("skills"),
        "ws-only",
        {
          name: "ws-only",
          description: "A workspace-authored skill",
          loadingStrategy: "always",
          priority: 50,
          status: "active",
        },
        "body",
      );
    },
  },
  {
    name: "connector-skills — a materialized overlay",
    write: () => {
      materializeConnectorSkill({
        connectorSkillsDir: ctx().getDataPath("connector-skills"),
        serverName: "gmail",
        overlayBody: OVERLAY,
        source: "connector:gmail@v0.2.0",
        now: "2026-01-01T00:00:00.000Z",
      });
    },
  },
];

describe("a write into a workspace that is gone", () => {
  for (const { name, write } of WRITERS) {
    test(`${name} refuses, and names the workspace`, async () => {
      // No root: the shape a writer is left in the instant after the
      // archive-rename. The leaf path it holds is unchanged.
      let thrown: unknown;
      try {
        await write();
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(WorkspaceRootMissingError);
      // The workspace, not a bare ENOENT on a leaf the caller cannot act on.
      expect((thrown as WorkspaceRootMissingError).workspaceId).toBe(WS);
      expect((thrown as Error).message).toContain(WS);

      // And nothing was created — the whole point.
      expect(existsSync(join(workDir, "workspaces", WS))).toBe(false);
    });
  }
});

describe("the same write inside a live workspace", () => {
  for (const { name, write } of WRITERS) {
    test(`${name} creates its own directory`, async () => {
      seedWorkspaceRoot(workDir, WS);
      await write();
      expect(existsSync(join(workDir, "workspaces", WS))).toBe(true);
    });
  }

  test("each store's subtree is created on first touch, not by the scaffold", () => {
    seedWorkspaceRoot(workDir, WS);
    // `scaffoldWorkspace` deliberately does not pre-create these: an empty dir
    // in every workspace that never uses the feature is worse than one made on
    // demand. That stays true — the guard is about the ROOT, not the subtree.
    expect(existsSync(workspaceConversationsDir(workDir, WS, OWNER))).toBe(false);
    new EventSourcedConversationStore({ dir: workspaceConversationsDir(workDir, WS, OWNER) });
    expect(existsSync(workspaceConversationsDir(workDir, WS, OWNER))).toBe(true);

    expect(existsSync(workspaceAutomationsDir(workDir, WS, OWNER))).toBe(false);
    saveAutomation(workDir, WS, OWNER, automation());
    expect(existsSync(automationRunsDir(workDir, WS, OWNER, "daily-digest"))).toBe(false);
    appendRun(workDir, WS, OWNER, "daily-digest", run());
    expect(existsSync(automationRunsDir(workDir, WS, OWNER, "daily-digest"))).toBe(true);
  });
});

describe("outside any workspace tree", () => {
  test("a path with no workspace root to require is simply created", () => {
    // Org skills, a user's own skills, a test's temp dir. `writeSkill` is
    // shared by all three and the workspace trees; the guard has to be silent
    // for the ones that have no workspace.
    const orgSkills = join(workDir, "skills", "nested");
    expect(ensureWorkspaceDir(orgSkills)).toBe(orgSkills);
    expect(existsSync(orgSkills)).toBe(true);

    const userSkills = join(workDir, "users", "usr_writer", "skills");
    ensureWorkspaceDir(userSkills);
    expect(existsSync(userSkills)).toBe(true);
  });

  test("a trailing `workspaces` segment does not turn the guard off", () => {
    // The leak this guard shipped with: the scan tested the segment after the
    // LAST `workspaces`, so a path ENDING in `workspaces` had no successor to
    // test, read as "not a workspace tree", and fell through to the unguarded
    // mkdir. `automationRunsDir` ends in `runs/<automationId>` and an
    // automation named "Workspaces" slugs to exactly that, so this was
    // reachable by naming one.
    expect(() => appendRun(workDir, WS, OWNER, "workspaces", run())).toThrow(
      WorkspaceRootMissingError,
    );
    expect(existsSync(join(workDir, "workspaces", WS))).toBe(false);

    // And it still creates the dir inside a live root.
    seedWorkspaceRoot(workDir, WS);
    appendRun(workDir, WS, OWNER, "workspaces", run());
    expect(existsSync(automationRunsDir(workDir, WS, OWNER, "workspaces"))).toBe(true);
  });

  test("a `workspaces/` segment followed by a non-workspace id is not a root", () => {
    // A directory that merely happens to be called `workspaces` has no root to
    // require — reading one into it would refuse writes that were never
    // workspace-scoped.
    const notAWorkspace = join(workDir, "workspaces", "README", "x");
    ensureWorkspaceDir(notAWorkspace);
    expect(existsSync(notAWorkspace)).toBe(true);
  });

  test("the archived copy of a workspace is writable — the rename is not a wall", () => {
    // `archived/<wsId>/` holds the tombstoned subtree. It is outside
    // `workspaces/`, so an operator export path is untouched by the guard.
    const archived = join(workDir, "archived", WS, "conversations", OWNER);
    ensureWorkspaceDir(archived);
    expect(existsSync(archived)).toBe(true);
  });
});
