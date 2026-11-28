/**
 * Chat: a turn's lifecycle and stream, tool calls in a turn, cancel, reload,
 * and the conversation tools the shell uses to list, search, rename and export.
 */

import type { ConversationsListOutput } from "../../../contracts/conversations/source/public.ts";
import type { ApiErrorBody } from "../../../src/api/schemas/responses.ts";
import { type SseEvent, structured, textOf } from "../client.ts";
import { directive, PARITY_TITLE } from "../directive-model.ts";
import { expect, expectEq, type Scenario, until } from "../scenario.ts";

const types = (events: SseEvent[]) => events.map((e) => e.type);

interface GetOutput {
  metadata?: { id: string; title: string | null; model?: string; workspaceId?: string };
  totalMessages: number;
  messages: Array<{ role: string; content: string; toolCalls?: Array<{ name: string }> }>;
}

export const chatTurn: Scenario = {
  id: "chat.turn",
  title: "Send, stream, tool call, tool error, auto-title, reload",
  covers: [
    "API-02",
    "API-04",
    "CH-1",
    "CH-10",
    "CH-27",
    "CH-28",
    "CH-37",
    "CH-38",
    "CH-44",
    "CH-54",
  ],
  requires: ["scripted-model"],
  async run(t) {
    await t.check(
      ["API-02", "CH-54"],
      "bootstrap names the caller, their workspaces, chat and models",
      async () => {
        const boot = await t.client.bootstrap(t.alice);
        expect(
          boot.workspaces.some((w) => w.id === t.ws),
          "the workspace is listed",
          boot.workspaces,
        );
        // `config.chat` is next/engine's (chat off when nothing binds conversations); main has none.
        expect(boot.config.chat !== false, "chat is not off", boot.config);
        expect(
          typeof boot.config.models?.default === "string",
          "a default model slot",
          boot.config.models,
        );
        return {
          user: boot.user.id,
          workspaces: boot.workspaces.length,
          models: boot.config.models,
        };
      },
    );

    const turn = await t.client.turn(t.alice, t.ws, {
      message: `look things up ${directive({
        steps: [
          [{ tool: "conversations__list", args: { limit: 5 } }],
          [{ tool: "files__info", args: { id: "file_does_not_exist" } }],
        ],
        reply: "PARITY-REPLY all done",
        chunks: 3,
      })}`,
    });
    t.note("conversationId", turn.conversationId);

    await t.check(
      ["API-04", "CH-1"],
      "chat/start answers a conversation id and the turn runs detached",
      () => {
        expectEq(turn.startStatus, 200, "start status");
        expect(/^conv_[0-9a-f]{16}$/.test(turn.conversationId), "a conv_ id", turn.conversationId);
        expectEq(turn.end, "done", "the stream ends done");
        return { conversationId: turn.conversationId };
      },
    );

    await t.check("CH-10", "the stream carries the lifecycle frames in order", () => {
      const seen = types(turn.events);
      for (const want of [
        "subscribed",
        "user.message",
        "chat.start",
        "text.delta",
        "llm.done",
        "done",
      ]) {
        expect(seen.includes(want), `a ${want} frame`, seen);
      }
      expect(
        seen.indexOf("chat.start") < seen.indexOf("text.delta"),
        "chat.start before text",
        seen,
      );
      expect(seen.at(-1) === "done", "done last", seen);
      expect(
        seen.filter((x) => x === "text.delta").length >= 2,
        "the reply streamed in deltas",
        seen,
      );
      return [...new Set(seen)];
    });

    await t.check(
      "CH-27",
      "a tool call runs inside the turn and its result feeds the next call",
      () => {
        const seen = types(turn.events);
        for (const want of ["tool.preparing", "tool.start", "tool.done"]) {
          expect(seen.includes(want), `a ${want} frame`, seen);
        }
        const calls = turn.done?.toolCalls ?? [];
        // A call held for its tool's guidance runs nothing and is made again.
        expectEq(
          calls.map((c) => c.name).filter((n, i, all) => n !== all[i - 1]),
          ["conversations__list", "files__info"],
          "the done frame lists both calls",
        );
        expect(
          turn.done?.response.includes("PARITY-REPLY"),
          "the closing reply",
          turn.done?.response,
        );
        return calls.map((c) => ({ name: c.name, ok: (c as { ok?: boolean }).ok }));
      },
    );

    await t.check("CH-28", "a failing tool is an error result and the turn goes on", () => {
      const failed = turn.done?.toolCalls.find((c) => c.name === "files__info") as
        | { ok?: boolean; isError?: boolean }
        | undefined;
      expect(failed, "the failing call is recorded", turn.done?.toolCalls);
      expect(failed.ok === false || failed.isError === true, "marked as an error", failed);
      expectEq(turn.done?.stopReason, "complete", "the turn completed");
      return failed;
    });

    await t.check("CH-37", "the first turn writes a title", async () => {
      const got = await until(
        async () =>
          structured<GetOutput>(
            await t.client.tool(t.alice, t.ws, "conversations__get", {
              id: turn.conversationId,
              expand: "metadata",
            }),
          ),
        (g) => !!g.metadata?.title,
        "the title",
        10_000,
      );
      expectEq(got.metadata?.title, PARITY_TITLE, "the fast model's title");
      return got.metadata;
    });

    await t.check(
      ["CH-38", "CH-44"],
      "reload reconstructs the turn: user message, tool calls, reply",
      async () => {
        const got = structured<GetOutput>(
          await t.client.tool(t.alice, t.ws, "conversations__get", {
            id: turn.conversationId,
            expand: "full",
          }),
        );
        const roles = got.messages.map((m) => m.role);
        expect(roles[0] === "user", "the user message first", roles);
        expect(roles.includes("assistant"), "an assistant message", roles);
        const tools = got.messages.flatMap((m) => m.toolCalls ?? []).map((c) => c.name);
        expect(tools.includes("conversations__list"), "the tool calls are kept", tools);
        const last = got.messages.at(-1);
        expect(last?.content.includes("PARITY-REPLY"), "the reply is stored", last);
        return { roles, tools, totalMessages: got.totalMessages };
      },
    );
  },
};

export const chatCancel: Scenario = {
  id: "chat.cancel",
  title: "Cancel mid-turn, a second start while running, disconnect and replay",
  covers: ["API-05", "CH-13", "CH-6", "CH-8", "CH-9", "API-06"],
  requires: ["scripted-model"],
  async run(t) {
    // A slow reply: cancel at its first delta.
    const slow = directive({ reply: "x".repeat(200), delayMs: 4000, chunks: 40 });
    const start = await t.client.startChat(t.alice, t.ws, { message: `slow ${slow}` });
    const conversationId = (start.json as { conversationId: string }).conversationId;

    let cancelAnswer: { status: number; body: unknown } | undefined;
    let secondStart: number | undefined;
    const read = await t.client.readEvents(t.alice, t.ws, conversationId, {
      timeoutMs: 15_000,
      onEvent: (e) => {
        if (e.type !== "text.delta" || cancelAnswer) return;
        cancelAnswer = { status: 0, body: null };
        void (async () => {
          const again = await t.client.startChat(t.alice, t.ws, {
            message: "again",
            conversationId,
          });
          secondStart = again.status;
          const r = await t.client.rest(
            t.alice,
            "POST",
            `/v1/workspaces/${t.ws}/conversations/${conversationId}/cancel`,
          );
          cancelAnswer = { status: r.status, body: r.json };
        })();
      },
    });
    await until(
      async () => cancelAnswer?.status ?? 0,
      (s) => s !== 0,
      "the cancel answer",
      5000,
    );

    await t.check("CH-6", "a second start on a running conversation is refused 409", () => {
      expectEq(secondStart, 409, "second start status");
      return { status: secondStart };
    });

    await t.check(
      ["API-05", "CH-13"],
      "cancel answers cancelled:true and the stream ends cancelled",
      () => {
        expectEq(cancelAnswer?.status, 200, "cancel status");
        expectEq((cancelAnswer?.body as { cancelled?: boolean })?.cancelled, true, "cancelled");
        expectEq(read.end, "cancelled", "the stream's last frame");
        return { cancel: cancelAnswer, end: read.end, frames: read.events.length };
      },
    );

    // A turn whose viewer never connects still finishes and is stored.
    const detached = await t.client.startChat(t.alice, t.ws, {
      message: `detached ${directive({ reply: "PARITY-DETACHED", delayMs: 600, chunks: 6 })}`,
    });
    const detachedId = (detached.json as { conversationId: string }).conversationId;

    await t.check(
      ["CH-9", "API-06"],
      "a viewer joining mid-turn with afterSeq sees only later events, then the end",
      async () => {
        await Bun.sleep(200);
        const first = await t.client.readEvents(t.alice, t.ws, detachedId, { timeoutMs: 10_000 });
        const seqs = first.events.map((e) => e.seq).filter((s): s is number => s !== undefined);
        expect(
          seqs.length > 2,
          "events carry sequence ids",
          first.events.map((e) => [e.type, e.seq]),
        );
        const cut = seqs[Math.floor(seqs.length / 2)] as number;
        const replay = await t.client.readEvents(t.alice, t.ws, detachedId, {
          afterSeq: cut,
          timeoutMs: 5000,
        });
        const replayed = replay.events
          .map((e) => e.seq)
          .filter((s): s is number => s !== undefined);
        const suffix = seqs.filter((s) => s > cut);
        expectEq(first.end, "done", "the first viewer saw the turn end");
        expectEq(replay.status, 200, "the replay is served");
        expectEq(replay.end, "done", "the replay reaches the turn's end");
        expect(replayed.length > 0, "the replay returns events", { cut, replayed });
        expect(
          replayed.every((s) => s > cut),
          "only events after the cut",
          { cut, replayed },
        );
        expectEq(replayed, suffix, "the replay is the events after the cut");
        return { cut, firstEnd: first.end, replayed: replay.events.map((e) => e.type) };
      },
    );

    await t.check("CH-8", "a turn with no viewer still finishes and stores its reply", async () => {
      const got = await until(
        async () =>
          structured<GetOutput>(
            await t.client.tool(t.alice, t.ws, "conversations__get", {
              id: detachedId,
              expand: "full",
            }),
          ),
        (g) =>
          g.messages.some((m) => m.role === "assistant" && m.content.includes("PARITY-DETACHED")),
        "the stored reply",
        10_000,
      );
      return got.messages.map((m) => m.role);
    });
  },
};

export const chatWalls: Scenario = {
  id: "chat.walls",
  title: "Malformed ids, another person's conversation, a disallowed model",
  covers: ["CH-5", "CH-40", "CH-7"],
  requires: ["second-identity"],
  async run(t) {
    const bob = t.bob;
    const bobWs = t.bobWs;
    if (!bob || !bobWs) throw new Error("no second identity");
    const mine = await t.client.turn(t.alice, t.ws, { message: "hello" });

    await t.check("CH-5", "a malformed conversation id is 400 bad_request", async () => {
      const r = await t.client.startChat(t.alice, t.ws, {
        message: "x",
        conversationId: "../../x",
      });
      expectEq(r.status, 400, "status");
      expectEq((r.json as ApiErrorBody).error, "bad_request", "error");
      return r.json;
    });

    await t.check(
      "CH-40",
      "resuming another person's or another workspace's conversation is 404",
      async () => {
        const asBob = await t.client.startChat(bob, bobWs, {
          message: "x",
          conversationId: mine.conversationId,
        });
        expectEq(asBob.status, 404, "bob, his workspace");
        expectEq((asBob.json as ApiErrorBody).error, "conversation_not_found", "error");
        const events = await t.client.readEvents(bob, bobWs, mine.conversationId, {
          timeoutMs: 2000,
        });
        expectEq(events.status, 404, "bob reading its events");
        const wrongWs = await t.client.startChat(t.alice, bobWs, {
          message: "x",
          conversationId: mine.conversationId,
        });
        expect(wrongWs.status === 404, "alice in a workspace she is not in", wrongWs.status);
        return { asBob: asBob.status, events: events.status, wrongWs: wrongWs.status };
      },
    );

    await t.check(
      "CH-7",
      "a model outside the allowlist is refused, naming the model",
      async () => {
        const r = await t.client.startChat(t.alice, t.ws, {
          message: "x",
          model: "nosuch:model-x",
        });
        expect(r.status >= 400 && r.status < 500, "a 4xx", r.status);
        expect(r.text.includes("nosuch:model-x"), "names the model", r.json);
        return { status: r.status, body: r.json };
      },
    );
  },
};

export const conversationTools: Scenario = {
  id: "chat.conversations",
  title: "Conversation list, search, rename, export",
  covers: ["CH-43", "CH-45", "CH-46", "CH-48", "CH-49", "MCP-60", "MCP-62", "MCP-63", "MCP-65"],
  async run(t) {
    const marker = `PARITYSEARCH${Date.now().toString(36)}`;
    const turn = await t.client.turn(t.alice, t.ws, { message: `remember ${marker}` });
    expectEq(turn.end, "done", "the seed turn");
    const id = turn.conversationId;

    await t.check(["CH-43", "MCP-60"], "list pages with nextCursor and totalCount", async () => {
      await t.client.turn(t.alice, t.ws, { message: "another" });
      const page = structured<ConversationsListOutput>(
        await t.client.tool(t.alice, t.ws, "conversations__list", { limit: 1 }),
      );
      expectEq(page.conversations.length, 1, "one row");
      expect(page.totalCount >= 2, "totalCount counts all", page.totalCount);
      expect(typeof page.nextCursor === "string", "a next cursor", page.nextCursor);
      const next = structured<ConversationsListOutput>(
        await t.client.tool(t.alice, t.ws, "conversations__list", {
          limit: 1,
          cursor: page.nextCursor,
        }),
      );
      expect(
        next.conversations[0]?.id !== page.conversations[0]?.id,
        "the next page moves on",
        next,
      );
      return {
        totalCount: page.totalCount,
        first: page.conversations[0]?.id,
        second: next.conversations[0]?.id,
      };
    });

    await t.check(
      ["CH-45", "MCP-62"],
      "search finds the conversation by message text, with a snippet",
      async () => {
        const found = structured<{
          results: Array<{ id: string; matches: Array<{ snippet: string }> }>;
        }>(await t.client.tool(t.alice, t.ws, "conversations__search", { query: marker }));
        const hit = found.results.find((r) => r.id === id);
        expect(hit, "the conversation is a result", found);
        expect(
          hit.matches.some((m) => m.snippet.includes(marker)),
          "a snippet holds the text",
          hit,
        );
        return hit;
      },
    );

    await t.check(["CH-46", "MCP-63"], "update renames it, and list shows the title", async () => {
      const r = await t.client.tool(t.alice, t.ws, "conversations__update", {
        id,
        title: "Parity renamed",
      });
      expect(!r.isError, "update succeeds", textOf(r));
      const page = structured<ConversationsListOutput>(
        await t.client.tool(t.alice, t.ws, "conversations__list", { search: "Parity renamed" }),
      );
      expect(
        page.conversations.some((c) => c.id === id && c.title === "Parity renamed"),
        "listed",
        page,
      );
      return page.conversations.map((c) => c.title);
    });

    await t.check(
      ["CH-48", "MCP-65"],
      "export gives a markdown and a JSON transcript",
      async () => {
        const md = structured<{ content: string }>(
          await t.client.tool(t.alice, t.ws, "conversations__export", { id, format: "markdown" }),
        );
        expect(md.content.includes(marker), "markdown holds the message", md.content.slice(0, 300));
        const js = structured<{ content: string }>(
          await t.client.tool(t.alice, t.ws, "conversations__export", { id, format: "json" }),
        );
        expect(js.content.includes(marker), "JSON holds the message", js.content.slice(0, 300));
        JSON.parse(js.content);
        return { markdown: md.content.length, json: js.content.length };
      },
    );

    // Decided on next/engine (inventory CH-49): bounded public inputs.
    await t.check(
      "CH-49",
      "list limit over 200 and a title over 200 characters are refused",
      async () => {
        const big = await t.client.tool(t.alice, t.ws, "conversations__list", { limit: 500 });
        expect(big.isError, "limit 500 refused", textOf(big));
        const long = await t.client.tool(t.alice, t.ws, "conversations__update", {
          id,
          title: "t".repeat(300),
        });
        expect(long.isError, "a 300-character title refused", textOf(long));
        return { list: textOf(big).slice(0, 200), update: textOf(long).slice(0, 200) };
      },
    );
  },
};
