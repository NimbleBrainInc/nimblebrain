/**
 * The workspace a runtime request runs in.
 *
 * The HTTP doors always name a workspace. A caller that drives the runtime
 * directly and names none is refused, under every identity provider (`dev`
 * included): the runtime never chooses a workspace for a request, and
 * provisions none on its behalf.
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
import type { EngineEvent, EngineEventOf } from "../../../src/engine/types.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { devProvider } from "../../helpers/dev-provider.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { seedWorkspace } from "../../helpers/test-workspace.ts";

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
    identityProvider: devProvider,
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
  for (const [label, start] of [
    ["an OIDC provider", () => startWithProvider("with-provider")],
    ["the dev provider", () => startDev("with-dev")],
  ] as const) {
    it(`is refused under ${label} (chat and task), and provisions nothing`, async () => {
      const runtime = await start();

      await expect(runtime.chat({ message: "hi", identity: ALICE })).rejects.toThrow(
        /names no workspace/,
      );
      await expect(runtime.executeTask({ prompt: "do it", identity: ALICE })).rejects.toThrow(
        /names no workspace/,
      );
      expect(await runtime.getWorkspaceStore().getWorkspacesForUser(ALICE.id)).toEqual([]);

      await runtime.shutdown();
    });
  }
});

describe("isPrincipalWorkspaceMember reads the member list", () => {
  it("is false for a workspace whose members lack the principal, whatever its id", async () => {
    const runtime = await startDev("membership");
    const store = runtime.getWorkspaceStore();
    // An id that looks like the old per-user form grants nothing by its shape.
    const ws = await seedWorkspace(store, `ws_user_${ALICE.id}`, {
      name: "Looks personal",
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
    const ws = await runtime.getWorkspaceStore().create("Alice's", {
      members: [{ userId: ALICE.id, role: "admin" }],
    });
    const res = await runtime.chat({
      message: "name this chat",
      identity: ALICE,
      workspaceId: ws.id,
    });

    const deadline = Date.now() + 3000;
    let title: EngineEventOf<"conversation.title"> | undefined;
    while (!title && Date.now() < deadline) {
      title = events.find(
        (e): e is EngineEventOf<"conversation.title"> =>
          e.type === "conversation.title" && e.data.conversationId === res.conversationId,
      );
      if (!title) await new Promise((r) => setTimeout(r, 25));
    }
    expect(title).toBeDefined();
    expect(title!.data.ownerId).toBe(ALICE.id);
    expect("wsId" in title!.data).toBe(false);

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
