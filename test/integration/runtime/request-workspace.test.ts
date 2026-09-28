/**
 * The workspace a runtime request runs in.
 *
 * The HTTP doors always name a workspace. A caller that drives the runtime
 * directly and names none is refused when an identity provider is configured —
 * the server does not choose a workspace for a request. In dev mode (no
 * provider) the caller's default workspace stands in, provisioned if they have
 * none (`Runtime.resolveRequestWorkspace`).
 *
 * Also pins what the removal of the personal workspace changed around it: the
 * membership check reads the member list for every workspace, and a
 * conversation's live title goes to its owner, not to its workspace.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SseEventManager } from "../../../src/api/events.ts";
import type { EngineEvent } from "../../../src/engine/types.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";

const testDir = join(tmpdir(), `nb-request-workspace-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

const ALICE = {
  id: "usr_alice",
  email: "alice@example.com",
  displayName: "Alice Liddell",
  orgRole: "member" as const,
  preferences: {},
};

async function startDev(name: string, events: EngineEvent[] = []): Promise<Runtime> {
  const workDir = join(testDir, name);
  mkdirSync(workDir, { recursive: true });
  return Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    logging: { disabled: true },
    workDir,
    events: [{ emit: (e) => events.push(e) }],
  });
}

async function startWithProvider(name: string): Promise<Runtime> {
  const workDir = join(testDir, name);
  mkdirSync(workDir, { recursive: true });
  writeFileSync(
    join(workDir, "instance.json"),
    JSON.stringify({
      auth: {
        adapter: "oidc",
        issuer: "https://auth.example.com",
        clientId: "test",
        allowedDomains: ["example.com"],
      },
    }),
  );
  return Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    logging: { disabled: true },
    workDir,
  });
}

describe("a request that names no workspace", () => {
  it("is refused when an identity provider is configured (chat and task)", async () => {
    const runtime = await startWithProvider("with-provider");
    expect(runtime.getIdentityProvider()).not.toBeNull();

    await expect(runtime.chat({ message: "hi", identity: ALICE })).rejects.toThrow(
      /names no workspace/,
    );
    await expect(runtime.executeTask({ prompt: "do it", identity: ALICE })).rejects.toThrow(
      /names no workspace/,
    );
    // Nothing was provisioned on the caller's behalf.
    expect(await runtime.getWorkspaceStore().getWorkspacesForUser(ALICE.id)).toEqual([]);

    await runtime.shutdown();
  });

  it("in dev mode runs in a workspace provisioned for the caller, and reuses it", async () => {
    const runtime = await startDev("dev-provision");
    const store = runtime.getWorkspaceStore();
    expect(await store.getWorkspacesForUser(ALICE.id)).toEqual([]);

    const first = await runtime.chat({ message: "hello", identity: ALICE });
    const memberships = await store.getWorkspacesForUser(ALICE.id);
    expect(memberships).toHaveLength(1);
    const ws = memberships[0]!;
    expect(ws.id).toMatch(/^ws_[0-9a-f]{16}$/);
    expect(ws.name).toBe("Alice's workspace");
    expect(ws.members).toEqual([{ userId: ALICE.id, role: "admin" }]);
    expect(await runtime.findConversation(first.conversationId, { userId: ALICE.id })).toBeTruthy();

    // A second request and a task reuse it rather than provisioning another.
    await runtime.chat({ message: "again", identity: ALICE });
    const task = await runtime.executeTask({ prompt: "a task", identity: ALICE });
    expect(task.output).toBeDefined();
    expect(await store.getWorkspacesForUser(ALICE.id)).toHaveLength(1);

    await runtime.shutdown();
  });

  it("in dev mode runs in the caller's default workspace, not their earliest membership", async () => {
    const runtime = await startDev("dev-default");
    const store = runtime.getWorkspaceStore();
    await store.create("Team", "team_early", { members: [{ userId: ALICE.id, role: "member" }] });
    const own = await store.create("Own", "own_later", {
      members: [{ userId: ALICE.id, role: "admin" }],
    });
    await runtime.getUserStore().create({
      id: ALICE.id,
      email: ALICE.email,
      displayName: ALICE.displayName,
      preferences: { defaultWorkspaceId: own.id },
    });

    const res = await runtime.chat({ message: "where am I", identity: ALICE });
    const located = await runtime.findConversation(res.conversationId, { userId: ALICE.id });
    expect(located?.workspaceId).toBe(own.id);

    await runtime.shutdown();
  });
});

describe("isPrincipalWorkspaceMember reads the member list", () => {
  it("is false for a workspace whose members lack the principal, whatever its id", async () => {
    const runtime = await startDev("membership");
    const store = runtime.getWorkspaceStore();
    // An id that looks like the old per-user form grants nothing by its shape.
    const ws = await store.create("Looks personal", `user_${ALICE.id}`, {
      members: [{ userId: "usr_bob", role: "admin" }],
    });
    expect(await runtime.isPrincipalWorkspaceMember(ws.id, ALICE.id)).toBe(false);
    expect(await runtime.isPrincipalWorkspaceMember(ws.id, "usr_bob")).toBe(true);

    await runtime.shutdown();
  });
});

describe("a conversation's live title goes to its owner", () => {
  it("the runtime stamps conversation.title with ownerId, not a workspace", async () => {
    const events: EngineEvent[] = [];
    const runtime = await startDev("title", events);
    const res = await runtime.chat({ message: "name this chat", identity: ALICE });

    const deadline = Date.now() + 3000;
    let title: EngineEvent | undefined;
    while (!title && Date.now() < deadline) {
      title = events.find(
        (e) => e.type === "conversation.title" && e.data.conversationId === res.conversationId,
      );
      if (!title) await new Promise((r) => setTimeout(r, 25));
    }
    expect(title).toBeDefined();
    expect(title!.data.ownerId).toBe(ALICE.id);
    expect(title!.data.wsId).toBeUndefined();

    await runtime.shutdown();
  });

  describe("SSE routing", () => {
    let mgr: SseEventManager;
    const released: Array<() => void> = [];

    beforeEach(() => {
      mgr = new SseEventManager(1_000_000);
      mgr.start();
    });

    afterEach(() => {
      for (const r of released.splice(0)) r();
      mgr.stop();
    });

    function collect(stream: ReadableStream<Uint8Array>): string[] {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      const seen: string[] = [];
      let stopped = false;
      void (async () => {
        try {
          while (!stopped) {
            const { value, done } = await reader.read();
            if (done) break;
            for (const line of decoder.decode(value, { stream: true }).split("\n")) {
              if (line.startsWith("event: ")) {
                const name = line.slice(7).trim();
                if (name && name !== "heartbeat") seen.push(name);
              }
            }
          }
        } catch {
          // Reader released.
        }
      })();
      released.push(() => {
        stopped = true;
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
      });
      return seen;
    }

    test("reaches the owner's tabs alone, not the other members of the workspace", async () => {
      const alice = collect(mgr.addIdentityClient(ALICE.id, new Set(["ws_team"])));
      const bob = collect(mgr.addIdentityClient("usr_bob", new Set(["ws_team"])));
      const workspaceClient = collect(mgr.addClient("ws_team"));

      mgr.emit({
        type: "conversation.title",
        data: { conversationId: "conv_1", title: "Private plans", ownerId: ALICE.id },
      });
      await new Promise((r) => setTimeout(r, 0));

      expect(alice).toEqual(["conversation.title"]);
      expect(bob).toEqual([]);
      expect(workspaceClient).toEqual([]);
    });
  });
});
