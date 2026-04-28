/**
 * Phase 4 — mutation-tool behavior tests for `nb__skills`.
 *
 * Per-tool: happy path + at least one error/permission edge. Versioning
 * (`_versions/{name}.{iso}.md` snapshots) is verified as a side-effect of
 * update / delete / move_scope. The fake runtime is intentionally close to
 * the read-tool tests' fixture so behavioral parity stays obvious.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NoopEventSink } from "../../../../src/adapters/noop-events.ts";
import { EventSourcedConversationStore } from "../../../../src/conversation/event-sourced-store.ts";
import type { EngineEvent, EventSink } from "../../../../src/engine/types.ts";
import { McpSource } from "../../../../src/tools/mcp-source.ts";
import { createSkillsSource } from "../../../../src/tools/platform/skills.ts";

interface FakeIdentity {
  id: string;
  email: string;
  displayName: string;
  orgRole: "owner" | "admin" | "member";
  preferences: { timezone: string; locale: string; theme: string };
}

class FakeRuntime {
  identity: FakeIdentity | null = null;
  hasIdentityProvider = false;
  wsId: string | null = null;
  workspaces = new Map<
    string,
    { id: string; name: string; members: Array<{ userId: string; role: "admin" | "member" }> }
  >();

  private readonly _store: EventSourcedConversationStore;

  constructor(private workDir: string) {
    const convDir = join(workDir, "conversations");
    mkdirSync(convDir, { recursive: true });
    this._store = new EventSourcedConversationStore({ dir: convDir });
  }

  getWorkDir(): string {
    return this.workDir;
  }
  getCurrentIdentity(): FakeIdentity | null {
    return this.identity;
  }
  getIdentityProvider(): object | null {
    return this.hasIdentityProvider ? ({} as object) : null;
  }
  requireWorkspaceId(): string {
    if (!this.wsId) throw new Error("no workspace");
    return this.wsId;
  }
  getConversationStore(): EventSourcedConversationStore {
    return this._store;
  }
  getWorkspaceStore() {
    return {
      get: async (id: string) => this.workspaces.get(id) ?? null,
    };
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

  setMember(wsId: string, userId: string, role: "admin" | "member"): void {
    const ws = this.workspaces.get(wsId);
    if (!ws) {
      this.workspaces.set(wsId, { id: wsId, name: wsId, members: [{ userId, role }] });
    } else {
      ws.members = [{ userId, role }];
    }
  }
}

class CollectingSink implements EventSink {
  events: EngineEvent[] = [];
  emit(e: EngineEvent): void {
    this.events.push(e);
  }
}

let workDir: string;
let runtime: FakeRuntime;
let source: McpSource | undefined;
let sink: CollectingSink;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "skills-mut-test-"));
  runtime = new FakeRuntime(workDir);
  sink = new CollectingSink();
});

afterEach(async () => {
  if (source) await source.stop();
  source = undefined;
  rmSync(workDir, { recursive: true, force: true });
});

async function buildSource(): Promise<McpSource> {
  source = createSkillsSource(runtime as unknown as never, sink ?? new NoopEventSink());
  await source.start();
  return source;
}

function readManifestField(path: string, key: string): string | undefined {
  const raw = readFileSync(path, "utf-8");
  const match = raw.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim().replace(/^"(.*)"$/, "$1");
}

// ── create ───────────────────────────────────────────────────────────────

describe("skills__create", () => {
  test("writes a platform-scope skill in dev mode and emits skill.created", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({
      name: "create",
      arguments: {
        scope: "platform",
        name: "voice-rules",
        manifest: {
          description: "speak plainly",
          type: "context",
          priority: 25,
          "loading-strategy": "always",
        },
        body: "Be concise.",
      },
    });
    expect(result.isError).toBeFalsy();
    const path = join(workDir, "skills", "voice-rules.md");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toContain("Be concise.");
    expect(sink.events.some((e) => e.type === "skill.created")).toBe(true);
  });

  test("rejects duplicate name within scope", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const make = () =>
      client.callTool({
        name: "create",
        arguments: { scope: "platform", name: "voice", body: "v1" },
      });
    expect((await make()).isError).toBeFalsy();
    const second = await make();
    expect(second.isError).toBe(true);
    expect((second.content as Array<{ text: string }>)[0]?.text).toMatch(/already exists/i);
  });

  test("rejects invalid skill name (slashes)", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({
      name: "create",
      arguments: { scope: "platform", name: "../etc/passwd", body: "" },
    });
    expect(result.isError).toBe(true);
  });

  test("non-admin denied for platform scope when identity provider is configured", async () => {
    runtime.hasIdentityProvider = true;
    runtime.identity = {
      id: "u1",
      email: "u@ex.com",
      displayName: "U",
      orgRole: "member",
      preferences: { timezone: "UTC", locale: "en-US", theme: "system" },
    };
    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({
      name: "create",
      arguments: { scope: "platform", name: "no-perm", body: "x" },
    });
    expect(result.isError).toBe(true);
    expect((result as { structuredContent?: { code?: string } }).structuredContent?.code).toBe(
      "permission_denied",
    );
  });

  test("workspace scope writes under {workDir}/workspaces/{wsId}/skills/", async () => {
    runtime.wsId = "ws_demo";
    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({
      name: "create",
      arguments: { scope: "workspace", name: "ws-only", body: "ws body" },
    });
    expect(result.isError).toBeFalsy();
    expect(existsSync(join(workDir, "workspaces", "ws_demo", "skills", "ws-only.md"))).toBe(true);
  });
});

// ── update ───────────────────────────────────────────────────────────────

describe("skills__update", () => {
  async function seed(): Promise<{ id: string }> {
    const src = await buildSource();
    const client = src.getClient()!;
    await client.callTool({
      name: "create",
      arguments: {
        scope: "platform",
        name: "voice",
        manifest: { description: "v1", type: "context", priority: 25 },
        body: "Body v1",
      },
    });
    return { id: join(workDir, "skills", "voice.md") };
  }

  test("merges manifest patch and replaces body; snapshots prior version", async () => {
    const { id } = await seed();
    const client = source!.getClient()!;
    const result = await client.callTool({
      name: "update",
      arguments: {
        id,
        manifest: { description: "v2", priority: 30 },
        body: "Body v2",
      },
    });
    expect(result.isError).toBeFalsy();
    expect(readFileSync(id, "utf-8")).toContain("Body v2");
    expect(readManifestField(id, "description")).toBe("v2");
    expect(readManifestField(id, "priority")).toBe("30");

    const versions = readdirSync(join(workDir, "skills", "_versions"));
    expect(versions.length).toBe(1);
    expect(versions[0]).toMatch(/^voice\..*\.md$/);
    expect(readFileSync(join(workDir, "skills", "_versions", versions[0]!), "utf-8")).toContain(
      "Body v1",
    );
  });

  test("rejects update of bundle-scope skill (Layer 1 vendored)", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({
      name: "update",
      arguments: { id: "skill://skills/authoring-guide", body: "x" },
    });
    expect(result.isError).toBe(true);
    expect((result as { structuredContent?: { error?: string } }).structuredContent?.error).toBe(
      "skill_not_mutable_via_platform",
    );
  });

  test("returns isError when target file does not exist", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({
      name: "update",
      arguments: { id: join(workDir, "skills", "nope.md"), body: "x" },
    });
    expect(result.isError).toBe(true);
  });
});

// ── delete ───────────────────────────────────────────────────────────────

describe("skills__delete", () => {
  test("removes the live file and snapshots to _versions/", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    await client.callTool({
      name: "create",
      arguments: { scope: "platform", name: "doomed", body: "rip" },
    });
    const id = join(workDir, "skills", "doomed.md");
    expect(existsSync(id)).toBe(true);

    const result = await client.callTool({ name: "delete", arguments: { id } });
    expect(result.isError).toBeFalsy();
    expect(existsSync(id)).toBe(false);
    const versions = readdirSync(join(workDir, "skills", "_versions"));
    expect(versions.length).toBe(1);
  });

  test("missing file returns isError, not silent success", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({
      name: "delete",
      arguments: { id: join(workDir, "skills", "ghost.md") },
    });
    expect(result.isError).toBe(true);
  });
});

// ── activate / deactivate ────────────────────────────────────────────────

describe("skills__activate / skills__deactivate", () => {
  test("activate sets status=active; deactivate sets status=disabled", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    await client.callTool({
      name: "create",
      arguments: { scope: "platform", name: "togglable", body: "x" },
    });
    const id = join(workDir, "skills", "togglable.md");

    const off = await client.callTool({ name: "deactivate", arguments: { id } });
    expect(off.isError).toBeFalsy();
    expect(readManifestField(id, "status")).toBe("disabled");

    const on = await client.callTool({ name: "activate", arguments: { id } });
    expect(on.isError).toBeFalsy();
    // status: active is the default; the writer suppresses default emission,
    // so the field disappears after activate. Re-read confirms no `status:`
    // line on disk and the loader will fill in "active".
    expect(readManifestField(id, "status")).toBeUndefined();
  });
});

// ── move_scope ───────────────────────────────────────────────────────────

describe("skills__move_scope", () => {
  test("relocates from workspace → platform; original deleted, version snapshot kept", async () => {
    runtime.wsId = "ws_demo";
    const src = await buildSource();
    const client = src.getClient()!;
    const create = await client.callTool({
      name: "create",
      arguments: { scope: "workspace", name: "promote-me", body: "wide value" },
    });
    expect(create.isError).toBeFalsy();
    const sourcePath = join(workDir, "workspaces", "ws_demo", "skills", "promote-me.md");
    expect(existsSync(sourcePath)).toBe(true);

    const result = await client.callTool({
      name: "move_scope",
      arguments: { id: sourcePath, target_scope: "platform" },
    });
    expect(result.isError).toBeFalsy();
    expect(existsSync(sourcePath)).toBe(false);
    const targetPath = join(workDir, "skills", "promote-me.md");
    expect(existsSync(targetPath)).toBe(true);
    expect(readFileSync(targetPath, "utf-8")).toContain("wide value");

    const versions = readdirSync(join(workDir, "workspaces", "ws_demo", "skills", "_versions"));
    expect(versions.length).toBe(1);
  });

  test("refuses no-op move", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    await client.callTool({
      name: "create",
      arguments: { scope: "platform", name: "stay", body: "x" },
    });
    const id = join(workDir, "skills", "stay.md");
    const result = await client.callTool({
      name: "move_scope",
      arguments: { id, target_scope: "platform" },
    });
    expect(result.isError).toBe(true);
  });

  test("refuses to overwrite an existing skill at the target", async () => {
    runtime.wsId = "ws_demo";
    const src = await buildSource();
    const client = src.getClient()!;
    await client.callTool({
      name: "create",
      arguments: { scope: "platform", name: "collide", body: "platform" },
    });
    await client.callTool({
      name: "create",
      arguments: { scope: "workspace", name: "collide", body: "workspace" },
    });
    const wsPath = join(workDir, "workspaces", "ws_demo", "skills", "collide.md");
    const result = await client.callTool({
      name: "move_scope",
      arguments: { id: wsPath, target_scope: "platform" },
    });
    expect(result.isError).toBe(true);
  });
});
