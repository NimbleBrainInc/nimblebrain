/**
 * Workspaces: create, members, delete into a tombstone that every door
 * refuses, restore with its data, and purge.
 */

import { structured, textOf } from "../client.ts";
import { expect, expectEq, Mismatch, type Scenario } from "../scenario.ts";

/** The first `id` (or `workspaceId`) in a tool answer. */
function workspaceIdOf(answer: Record<string, unknown>): string | undefined {
  const ws = answer.workspace as { id?: string } | undefined;
  return ws?.id ?? (answer.workspaceId as string | undefined) ?? (answer.id as string | undefined);
}

export const workspacesLifecycle: Scenario = {
  id: "workspaces.lifecycle",
  title: "Create, members, delete (tombstone refused at every door), restore, purge",
  requires: ["org-admin", "second-identity"],
  async run(t) {
    const bob = t.bob;
    if (!bob) throw new Error("no second identity");
    const admin = (args: Record<string, unknown>) =>
      t.client.identityTool(t.alice, "nb__manage_workspaces", args);
    const name = `E2E WS ${Date.now().toString(36)}`;
    const created = await admin({ action: "create", name });
    const ws = workspaceIdOf(structured(created));
    if (!ws) throw new Mismatch("create answered no id", textOf(created));
    t.disposable(ws);

    await t.check(
      "create makes a workspace with a generated id and seats the creator",
      async () => {
        expect(/^ws_[0-9a-f]{16}$/.test(ws), "a generated ws_ id", ws);
        const boot = await t.client.bootstrap(t.alice);
        expect(
          boot.workspaces.some((w) => w.id === ws),
          "the creator sees it",
          boot.workspaces,
        );
        return { ws, created: structured(created) };
      },
    );

    await t.check("a non-member gets the unknown-workspace 404 at REST and MCP", async () => {
      const shell = await t.client.rest(bob, "GET", `/v1/workspaces/${ws}/shell`);
      expectEq(shell.status, 404, "shell as a non-member");
      const tool = await t.client.tool(bob, ws, "files__list", {});
      expectEq(tool.status, 404, "tools/call as a non-member");
      const own = await t.client.rest(t.alice, "GET", `/v1/workspaces/${ws}/shell`);
      expectEq(own.status, 200, "shell as a member");
      const mcp = await t.client.rest(bob, "POST", `/mcp/${ws}`, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });
      const bad = await t.client.rest(bob, "POST", "/mcp/ws_0000000000000000", {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });
      expectEq(mcp.status, 404, "MCP as a non-member");
      expectEq(bad.status, 404, "MCP for an unknown workspace");
      return { shell: shell.status, tool: tool.status, mcp: mcp.status, unknown: bad.status };
    });

    const bobId = (await t.client.bootstrap(bob)).user.id;
    await t.check("add_member seats a person; list_members shows them", async () => {
      const added = await admin({
        action: "add_member",
        workspaceId: ws,
        userId: bobId,
        role: "member",
      });
      expect(!added.isError, "added", textOf(added));
      const members = structured<{ members?: Array<{ userId: string; role: string }> }>(
        await t.client.identityTool(bob, "nb__manage_workspaces", {
          action: "list_members",
          workspaceId: ws,
        }),
      );
      expect(
        members.members?.some((m) => m.userId === bobId && m.role === "member"),
        "bob is a member",
        members,
      );
      return members.members;
    });

    // Data in the workspace, to find again after a restore.
    const file = structured<{ id: string }>(
      await t.client.tool(t.alice, ws, "files__create", {
        manifest: { filename: "keep.txt", mimeType: "text/plain" },
        body: "kept through a delete",
        encoding: "text",
      }),
    );
    const turn = await t.client.turn(t.alice, ws, { message: "remember me" });
    const task = structured<{ task?: { id: string } }>(
      await t.client.tool(t.alice, ws, "tasks__create", {
        manifest: { name: "E2E kept" },
        body: "x",
      }),
    ).task;

    // Delete writes a tombstone with a purge time.
    const deleted = await admin({ action: "delete", workspaceId: ws });
    await t.check("delete answers deleted with a purgeAt", () => {
      const out = structured<{ deleted?: boolean; purgeAt?: string }>(deleted);
      expectEq(out.deleted, true, "deleted");
      expect(out.purgeAt && Date.parse(out.purgeAt) > Date.now(), "a future purgeAt", out);
      return out;
    });

    await t.check("every door refuses the deleted workspace like a missing one", async () => {
      const doors = {
        shell: (await t.client.rest(t.alice, "GET", `/v1/workspaces/${ws}/shell`)).status,
        toolsCall: (await t.client.tool(t.alice, ws, "files__list", {})).status,
        chatStart: (await t.client.startChat(t.alice, ws, { message: "x" })).status,
        resume: (
          await t.client.startChat(t.alice, ws, {
            message: "x",
            conversationId: turn.conversationId,
          })
        ).status,
        events: (await t.client.readEvents(t.alice, ws, turn.conversationId, { timeoutMs: 1500 }))
          .status,
        download: (await t.client.rest(t.alice, "GET", `/v1/workspaces/${ws}/files/${file.id}`))
          .status,
        upload: (
          await t.client.rest(
            t.alice,
            "POST",
            `/v1/workspaces/${ws}/resources`,
            (() => {
              const f = new FormData();
              f.append("file", new Blob(["x"], { type: "text/plain" }), "x.txt");
              return f;
            })(),
          )
        ).status,
        mcp: (
          await t.client.rest(t.alice, "POST", `/mcp/${ws}`, {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
          })
        ).status,
      };
      for (const [door, status] of Object.entries(doors)) expectEq(status, 404, `${door} status`);
      const members = await t.client.identityTool(bob, "nb__manage_workspaces", {
        action: "list_members",
        workspaceId: ws,
      });
      // Refused without a roster. A member-tool refusal answers with
      // `isError: false` (`memberPermissionDenied`), so the roster is what is checked.
      const roster = structured<{ members?: unknown[] }>(members).members;
      expect(!roster, "list_members gives a member no roster", {
        doors,
        listMembers: textOf(members),
      });
      return {
        ...doors,
        listMembers: { isError: members.isError, text: textOf(members).slice(0, 120) },
      };
    });

    await t.check("list leaves it out; list_deleted names it with its purge time", async () => {
      const list = JSON.stringify(structured(await admin({ action: "list" })));
      expect(!list.includes(ws), "not in list", list.slice(0, 400));
      const gone = structured<{ deleted?: Array<{ workspaceId: string; purgeAt?: string }> }>(
        await admin({ action: "list_deleted" }),
      );
      const row = gone.deleted?.find((w) => w.workspaceId === ws);
      expect(row?.purgeAt, "listed with purgeAt", gone);
      return row;
    });

    await t.check("restore brings it back with its files, conversations and tasks", async () => {
      const restored = await admin({ action: "restore", workspaceId: ws });
      expect(!restored.isError, "restored", textOf(restored));
      const read = await t.client.tool(t.alice, ws, "files__read", { id: file.id });
      expect(
        textOf(read).includes("kept through a delete") ||
          JSON.stringify(read).includes("kept through"),
        "the file",
        textOf(read),
      );
      const conv = await t.client.tool(t.alice, ws, "conversations__get", {
        id: turn.conversationId,
        expand: "metadata",
      });
      expect(!conv.isError, "the conversation", textOf(conv));
      const status = await t.client.tool(t.alice, ws, "tasks__status", {
        taskId: task?.id ?? "e2e-kept",
      });
      expect(!status.isError, "the task", textOf(status));
      return {
        restored: structured(restored),
        file: !read.isError,
        conversation: !conv.isError,
        task: !status.isError,
      };
    });

    await t.check("purge removes a deleted workspace for good", async () => {
      await admin({ action: "delete", workspaceId: ws });
      const purged = await admin({ action: "purge", workspaceId: ws });
      expect(!purged.isError, "purged", textOf(purged));
      const gone = JSON.stringify(structured(await admin({ action: "list_deleted" })));
      expect(!gone.includes(ws), "no longer listed as deleted", gone.slice(0, 300));
      const restore = await admin({ action: "restore", workspaceId: ws });
      expect(restore.isError, "restore refused", textOf(restore));
      const shell = await t.client.rest(t.alice, "GET", `/v1/workspaces/${ws}/shell`);
      expectEq(shell.status, 404, "shell");
      return { purged: structured(purged), restore: textOf(restore).slice(0, 160) };
    });
  },
};
