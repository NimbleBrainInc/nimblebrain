/**
 * A writer may create a file inside a workspace; it may not create the workspace.
 *
 * A purge removes a deleted workspace's directory out from under every writer
 * holding a path into it. Those writers mkdir recursively, so without the guard
 * the first one to fire afterwards would re-create the purged workspace's
 * directory and write into it — invisibly, because `list()` skips a workspace
 * directory with no parseable `workspace.json`, so the resurrected tree would
 * appear nowhere and never be removed again.
 *
 * The rule is therefore at the mkdir rather than in each writer: a workspace
 * root comes from `WorkspaceStore.create`, and everything else may only create
 * paths inside a root that is already there. This file drives each
 * workspace-scoped writer against a workspace that is gone and asserts the
 * refusal names the workspace — and then drives the same write inside a live
 * root, because "create your own subdirectory on first write" is still how
 * files and notifications are meant to behave. Conversations and tasks are
 * their plugins' storage; the kernel stamps only a live workspace on their
 * calls instead (`src/conversation/contract-store.ts`, the run worker).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import { saveComposioConnection } from "../../../src/connectors/providers/composio/connection.ts";
import { workspaceFilesDir } from "../../../src/files/paths.ts";
import { createFileStore } from "../../../src/files/store.ts";
import { parseNotificationEnvelope } from "../../../src/notifications/envelope.ts";
import { NotificationStore } from "../../../src/notifications/store.ts";
import type { NotificationEnvelope } from "../../../src/notifications/types.ts";
import { PermissionStore } from "../../../src/permissions/permission-store.ts";
import { materializeConnectorSkill } from "../../../src/skills/connector-skill-store.ts";
import { writeSkill } from "../../../src/skills/writer.ts";
import { FileCredentialStore } from "../../../src/tools/credential-store.ts";
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
 * path. Each `write` is the first touch — the call that could mkdir its way
 * back into a workspace that had just been purged.
 */
const WRITERS: Array<{ name: string; write: () => void | Promise<void> }> = [
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
  // The three below keep their own `mkdir` (mode 0o700, or the async form) and
  // call `assertWorkspaceRootExists` directly ahead of it. Two write secret
  // material.
  {
    name: "permissions — permissions.json at the workspace root",
    write: () =>
      new PermissionStore(workDir).setConnector({ scope: "workspace", wsId: WS }, "gmail", {
        send: "disallow",
      }),
  },
  {
    name: "composio — a workspace-owned connection",
    write: () =>
      saveComposioConnection(workDir, { type: "workspace", wsId: WS }, "gmail", {
        connectedAccountId: "ca_1",
        toolkit: "gmail",
        userId: "u_1",
        connectedAt: "2026-01-01T00:00:00.000Z",
        status: "ACTIVE",
      }),
  },
  {
    name: "credentials — a workspace-scoped secret",
    write: () =>
      new FileCredentialStore(workDir).put({ kind: "workspace", wsId: WS }, "api_key", "s3cret"),
  },
];

describe("a write into a workspace that is gone", () => {
  for (const { name, write } of WRITERS) {
    test(`${name} refuses, and names the workspace`, async () => {
      // No root: the shape a writer is left in the instant after a purge
      // removes the directory. The leaf path it holds is unchanged.
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
    const files = workspaceFilesDir(workDir, WS, OWNER);
    expect(existsSync(files)).toBe(false);
    ensureWorkspaceDir(files);
    expect(existsSync(files)).toBe(true);
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
    // mkdir. A record named for its user-chosen name can end in exactly that.
    const nested = join(workDir, "workspaces", WS, "records", "workspaces");
    expect(() => ensureWorkspaceDir(nested)).toThrow(WorkspaceRootMissingError);
    expect(existsSync(join(workDir, "workspaces", WS))).toBe(false);

    // And it still creates the dir inside a live root.
    seedWorkspaceRoot(workDir, WS);
    ensureWorkspaceDir(nested);
    expect(existsSync(nested)).toBe(true);
  });

  test("a `workspaces/` segment followed by a non-workspace id is not a root", () => {
    // A directory that merely happens to be called `workspaces` has no root to
    // require — reading one into it would refuse writes that were never
    // workspace-scoped.
    const notAWorkspace = join(workDir, "workspaces", "README", "x");
    ensureWorkspaceDir(notAWorkspace);
    expect(existsSync(notAWorkspace)).toBe(true);
  });
});
