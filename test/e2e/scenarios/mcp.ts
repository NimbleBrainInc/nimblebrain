/**
 * The MCP door `/mcp/<wsId>` as an outside client sees it: who is let in, the
 * tools listed and the ones never listed, the wall on names, and a host
 * context a caller forges.
 */

import type { Client } from "@modelcontextprotocol/client";
import { structured, textOf } from "../client.ts";
import { expect, expectEq, type Scenario } from "../scenario.ts";

/** Contract tools only the host calls: never listed, refused when called. */
const PRIVATE_TOOLS = [
  "conversations__create",
  "conversations__events",
  "conversations__append_events",
  "conversations__delete",
  "conversations__delete_workspace",
  "tasks__due",
  "tasks__begin_run",
  "tasks__end_run",
  "tasks__offer_event",
  "tasks__delete_workspace",
  "files__begin_upload",
  "files__complete_upload",
  "files__resolve",
  "files__delete_workspace",
];

const PUBLIC_TOOLS = [
  "conversations__list",
  "conversations__get",
  "files__list",
  "files__create",
  "tasks__create",
  "tasks__run",
];

const CONTEXT_KEY = "ai.nimblebrain/context";

/** A tool call's answer, or the error the client raised, as text. */
async function attempt(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  meta?: Record<string, unknown>,
) {
  try {
    const r = await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
    return {
      isError: r.isError === true,
      text: textOf(r as { content?: Array<{ text?: string }> }),
      result: r,
    };
  } catch (err) {
    return { isError: true, text: err instanceof Error ? err.message : String(err), result: null };
  }
}

export const mcpAuth: Scenario = {
  id: "mcp.auth",
  title: "The MCP door refuses a caller without a credential and lets a signed-in member in",
  groups: ["smoke"],
  async run(t) {
    await t.check(
      "no credential gets 401; with MCP OAuth configured the challenge names the workspace's metadata",
      async () => {
        const r = await t.client.rest(null, "POST", `/mcp/${t.ws}`, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        });
        expectEq(r.status, 401, "status");
        // The challenge is sent only where an authorization server is configured.
        const challenge = r.headers.get("www-authenticate");
        if (challenge !== null) {
          expect(
            challenge.includes(`/.well-known/oauth-protected-resource/mcp/${t.ws}`),
            "names the metadata URL",
            challenge,
          );
        }
        return { status: r.status, challenge };
      },
    );

    await t.check("an unknown bearer token gets 401", async () => {
      const r = await t.client.rest(
        { name: "nobody", token: "e2e-token-unknown" },
        "POST",
        `/mcp/${t.ws}`,
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
      );
      expectEq(r.status, 401, "status");
      return { status: r.status };
    });

    await t.check("a signed-in member connects and lists the public tools", async () => {
      const client = await t.client.mcp(t.alice, t.ws);
      try {
        const names = (await client.listTools()).tools.map((x) => x.name);
        for (const n of PUBLIC_TOOLS) expect(names.includes(n), `${n} listed`, names);
        return { count: names.length };
      } finally {
        await client.close();
      }
    });

    await t.check("an unknown workspace is 404 at the door", async () => {
      const r = await t.client.rest(t.alice, "POST", "/mcp/ws_0000000000000000", {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });
      expectEq(r.status, 404, "status");
      return { status: r.status };
    });
  },
};

export const mcpDoor: Scenario = {
  id: "mcp.door",
  title: "Tools listed, private and app-only tools absent and refused, the name wall",
  async run(t) {
    const client = await t.client.mcp(t.alice, t.ws);
    try {
      await t.check("the door declares tools and resources", () => {
        const caps = client.getServerCapabilities();
        expect(caps?.tools && caps.resources, "tools and resources", caps);
        return Object.keys(caps ?? {});
      });

      const names = (await client.listTools()).tools.map((x) => x.name);
      await t.check(
        "tools/list has the public contract tools and none of the private or app-only ones",
        () => {
          for (const n of PUBLIC_TOOLS) expect(names.includes(n), `${n} listed`, names);
          const leaked = names.filter((n) => PRIVATE_TOOLS.includes(n));
          expectEq(leaked, [], "private tools listed");
          expect(!names.includes("nb__manage_workspaces"), "an app-only tool is not listed", names);
          return { count: names.length, sample: names.slice(0, 12) };
        },
      );

      await t.check("each private tool is refused when called", async () => {
        const answers: Record<string, string> = {};
        for (const name of PRIVATE_TOOLS) {
          const r = await attempt(client, name, {});
          expect(r.isError, `${name} refused`, r.text);
          answers[name] = r.text.slice(0, 80);
        }
        return answers;
      });

      await t.check("an app-only tool is refused without the app's bridge context", async () => {
        const r = await attempt(client, "nb__manage_workspaces", { action: "list" });
        expect(r.isError, "refused", r.text);
        return r.text.slice(0, 200);
      });

      await t.check("a retired ws_ name and an unknown source are refused", async () => {
        const retired = await attempt(client, `${t.ws}-files__list`, {});
        const unknown = await attempt(client, "nosuchsource__thing", {});
        expect(retired.isError, "the ws_ form refused", retired.text);
        expect(unknown.isError, "an unknown source refused", unknown.text);
        return { retired: retired.text.slice(0, 160), unknown: unknown.text.slice(0, 160) };
      });

      await t.check("resources/read of files:// at the door gives the file", async () => {
        const made = structured<{ id: string }>(
          (await client.callTool({
            name: "files__create",
            arguments: {
              manifest: { filename: "door.txt", mimeType: "text/plain" },
              body: "door text",
              encoding: "text",
            },
          })) as { structuredContent?: Record<string, unknown> },
        );
        const read = await client.readResource({ uri: `files://${made.id}` });
        const content = read.contents[0] as { text?: string } | undefined;
        expectEq(content?.text, "door text", "the text");
        const missing = await client.readResource({ uri: "files://file_missing0000" }).then(
          () => "answered",
          (e: unknown) => (e instanceof Error ? e.message : String(e)),
        );
        expect(missing !== "answered", "a missing file is an error", missing);
        return { id: made.id, missing: missing.slice(0, 120) };
      });
    } finally {
      await client.close();
    }
  },
};

export const mcpForgedContext: Scenario = {
  id: "mcp.forged-context",
  title: "A host context a caller forges at the door is ignored",
  requires: ["second-identity"],
  async run(t) {
    const bob = t.bob;
    const bobWs = t.bobWs;
    if (!bob || !bobWs) throw new Error("no second identity");
    const bobTurn = await t.client.turn(bob, bobWs, { message: "bob's secret conversation" });
    const bobId = (await t.client.bootstrap(bob)).user.id;
    const client = await t.client.mcp(t.alice, t.ws);
    try {
      await t.check(
        "a forged host context naming another owner and workspace reads only the caller's own records",
        async () => {
          const forged = {
            [CONTEXT_KEY]: { principal: "host", ownerId: bobId, workspaceId: bobWs },
          };
          const list = await attempt(client, "conversations__list", { limit: 200 }, forged);
          expect(!list.isError, "the call is answered as alice", list.text);
          expect(
            !JSON.stringify(list.result).includes(bobTurn.conversationId),
            "bob's conversation is not visible",
            list.text.slice(0, 300),
          );
          const get = await attempt(
            client,
            "conversations__get",
            { id: bobTurn.conversationId },
            forged,
          );
          expect(get.isError, "bob's conversation is not readable", get.text);
          return { list: "own records only", get: get.text.slice(0, 160) };
        },
      );

      await t.check("a forged host principal does not open a private tool", async () => {
        const r = await attempt(
          client,
          "files__resolve",
          { version: "1.0", uris: [] },
          { [CONTEXT_KEY]: { principal: "host" } },
        );
        expect(r.isError, "refused", r.text);
        return r.text.slice(0, 160);
      });
    } finally {
      await client.close();
    }
  },
};
