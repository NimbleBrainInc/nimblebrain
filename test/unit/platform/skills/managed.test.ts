/**
 * A plugin's managed skills (ADR-0077) through the skill tools: read under the
 * owner's wall, refused by every editing tool with the copy instruction, and
 * copied by `skills__copy` into an editable personal skill. Plus the owner's
 * skill pool holding the unbound ones as `plugin:<address>:<skill>`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../../../src/adapters/noop-events.ts";
import type { UserIdentity } from "../../../../src/identity/provider.ts";
import { createSkillsSource } from "../../../../src/platform/skills/source.ts";
import { Runtime } from "../../../../src/runtime/runtime.ts";
import {
  managedSkillRoots,
  materializeManagedSkill,
} from "../../../../src/skills/managed-skills.ts";
import type { McpSource } from "../../../../src/tools/mcp-source.ts";
import { WorkspaceContext } from "../../../../src/workspace/context.ts";
import type { Workspace } from "../../../../src/workspace/types.ts";
import type { WorkspaceStore } from "../../../../src/workspace/workspace-store.ts";
import { stub } from "../../../helpers/stub.ts";
import { makeWorkspace, seedWorkspaceRoot } from "../../../helpers/test-workspace.ts";

const WS = "ws_002afe1142297ff4";
const OTHER_WS = "ws_00aa11bb22cc33dd";
const ADDRESS = "notion@nimblebrain";

const USER: UserIdentity = {
  id: "usr_default",
  email: "dev@localhost",
  displayName: "Developer",
  orgRole: "admin",
  preferences: { timezone: "UTC", locale: "en-US", theme: "system" },
};

const SKILL_MD = `---
name: notion-guide
description: How to use Notion's tools.
---

Search before you write.
`;

class FakeRuntime {
  identity: UserIdentity | null = USER;
  wsId: string | null = WS;
  workspaces = new Map<string, Workspace>();

  constructor(private workDir: string) {
    this.workspaces.set(
      WS,
      makeWorkspace({ id: WS, members: [{ userId: USER.id, role: "admin" }] }),
    );
    this.workspaces.set(OTHER_WS, makeWorkspace({ id: OTHER_WS, members: [] }));
  }
  getWorkDir(): string {
    return this.workDir;
  }
  getCurrentIdentity(): UserIdentity | null {
    return this.identity;
  }
  requireWorkspaceId(): string {
    if (!this.wsId) throw new Error("no workspace");
    return this.wsId;
  }
  getWorkspaceContext(wsId: string): WorkspaceContext {
    return new WorkspaceContext({ wsId, workDir: this.workDir });
  }
  getWorkspaceStore() {
    return stub<WorkspaceStore>({ get: async (id: string) => this.workspaces.get(id) ?? null });
  }
  getContextSkills() {
    return [];
  }
  getMatchableSkills() {
    return [];
  }
  loadConversationSkills() {
    return [];
  }
  async reloadSkills(): Promise<void> {}
}

let workDir: string;
let runtime: FakeRuntime;
let source: McpSource | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "skills-managed-test-"));
  seedWorkspaceRoot(workDir, WS);
  seedWorkspaceRoot(workDir, OTHER_WS);
  runtime = new FakeRuntime(workDir);
});

afterEach(async () => {
  if (source) await source.stop();
  source = undefined;
  rmSync(workDir, { recursive: true, force: true });
});

async function client() {
  source = createSkillsSource(stub<Runtime>(runtime), new NoopEventSink());
  await source.start();
  await source.tools();
  return source.getClient()!;
}

function managed(wsId = WS, serverName?: string): string {
  const written = materializeManagedSkill({
    roots: managedSkillRoots(workDir, { kind: "workspace", wsId }),
    address: ADDRESS,
    skill: "notion-guide",
    body: SKILL_MD,
    ...(serverName ? { serverName } : {}),
    now: "2026-11-27T00:00:00.000Z",
  });
  if (!written) throw new Error("not materialized");
  return written.path;
}

function text(result: { content: unknown }): string {
  return (result.content as Array<{ text: string }>).map((c) => c.text).join("\n");
}

describe("a managed skill", () => {
  test("is read by a member of the workspace that owns it", async () => {
    const path = managed();
    const result = await (await client()).callTool({ name: "read", arguments: { id: path } });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("Search before you write.");
  });

  test("is not read across the workspace wall", async () => {
    const path = managed(OTHER_WS);
    const result = await (await client()).callTool({ name: "read", arguments: { id: path } });
    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain("Search before you write.");
  });

  for (const [tool, args] of [
    ["update", { manifest: { description: "changed" } }],
    ["delete", {}],
    ["restore", { version: "v1" }],
    ["set_status", { status: "disabled" }],
  ] as const) {
    test(`is refused by ${tool} with the copy instruction`, async () => {
      const path = managed();
      const before = readFileSync(path, "utf-8");
      const result = await (await client()).callTool({
        name: tool,
        arguments: { id: path, ...args },
      });
      expect(result.isError).toBe(true);
      expect(text(result)).toBe(
        `"notion-guide" is managed by the plugin ${ADDRESS}: it is replaced when the plugin ` +
          "updates and removed when it is uninstalled. Make your own copy with skills__copy, " +
          "then edit the copy.",
      );
      expect(readFileSync(path, "utf-8")).toBe(before);
    });
  }

  test("bound to a connection, it is refused as well", async () => {
    const path = managed(WS, "notion");
    expect(path).toContain("/connector-skills/notion/");
    const result = await (await client()).callTool({
      name: "update",
      arguments: { id: path, body: "x", body_mode: "append" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Make your own copy with skills__copy");
  });

  test("copies into an editable personal skill that update accepts", async () => {
    const path = managed();
    const c = await client();
    const copied = await c.callTool({ name: "copy", arguments: { id: path } });
    expect(copied.isError).toBeFalsy();
    const target = join(workDir, "users", USER.id, "skills", "notion-guide.md");
    expect(copied.structuredContent).toEqual({
      id: target,
      name: "notion-guide",
      scope: "user",
      copiedFrom: path,
    });
    const raw = readFileSync(target, "utf-8");
    expect(raw).toContain("Search before you write.");
    expect(raw).not.toContain(`plugin:${ADDRESS}`);

    const updated = await c.callTool({
      name: "update",
      arguments: { id: target, body: "Mine now.", body_mode: "append" },
    });
    expect(updated.isError).toBeFalsy();
    expect(readFileSync(target, "utf-8")).toContain("Mine now.");
    // The plugin's file is untouched.
    expect(readFileSync(path, "utf-8")).not.toContain("Mine now.");
  });

  test("a copy under a name the person already has is refused", async () => {
    const path = managed();
    const c = await client();
    expect((await c.callTool({ name: "copy", arguments: { id: path } })).isError).toBeFalsy();
    const again = await c.callTool({ name: "copy", arguments: { id: path } });
    expect(again.isError).toBe(true);
    const renamed = await c.callTool({ name: "copy", arguments: { id: path, name: "my-notion" } });
    expect(renamed.isError).toBeFalsy();
    expect(existsSync(join(workDir, "users", USER.id, "skills", "my-notion.md"))).toBe(true);
  });
});

describe("Runtime.loadConversationSkills", () => {
  test("holds the workspace's unbound managed skills as plugin:<address>:<skill>", () => {
    managed();
    const rt = Object.assign(Object.create(Runtime.prototype), {
      contextSkills: [],
      skillMatcher: { getSkills: () => [] },
      getWorkDir: () => workDir,
      getWorkspaceContext: (wsId: string) => new WorkspaceContext({ wsId, workDir }),
    }) as Runtime;
    const names = rt.loadConversationSkills(WS, null).map((s) => s.manifest.name);
    expect(names).toContain(`plugin:${ADDRESS}:notion-guide`);
    const skill = rt
      .loadConversationSkills(WS, null)
      .find((s) => s.manifest.name === `plugin:${ADDRESS}:notion-guide`);
    expect(skill?.manifest.scope).toBe("provided");
    expect(rt.loadConversationSkills(OTHER_WS, null).map((s) => s.manifest.name)).not.toContain(
      `plugin:${ADDRESS}:notion-guide`,
    );
  });
});
