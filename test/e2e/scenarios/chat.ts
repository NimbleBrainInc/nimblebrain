/**
 * Chat: a turn's lifecycle and stream, tool calls in a turn, cancel, reload,
 * and the conversation tools the shell uses to list, search, rename and export.
 */

import type { ConversationsListOutput } from "../../../contracts/conversations/source/public.ts";
import type { ApiErrorBody } from "../../../src/api/schemas/responses.ts";
import { type SseEvent, structured, textOf } from "../client.ts";
import { directive, E2E_TITLE } from "../directive-model.ts";
import { expect, expectEq, type Scenario, until } from "../scenario.ts";

const types = (events: SseEvent[]) => events.map((e) => e.type);

interface GetOutput {
  metadata?: { id: string; title: string | null; model?: string; workspaceId?: string };
  totalMessages: number;
  messages: Array<{ role: string; content: string; toolCalls?: Array<{ name: string }> }>;
}

export const chatReply: Scenario = {
  id: "chat.reply",
  title: "Send a message, stream the reply, reload the conversation",
  groups: ["smoke"],
  async run(t) {
    const turn = await t.client.turn(
      t.alice,
      t.ws,
      { message: "Reply with one short sentence." },
      { timeoutMs: 60_000 },
    );
    t.note("conversationId", turn.conversationId);

    await t.check("the turn starts, streams a reply and ends done", () => {
      expectEq(turn.startStatus, 200, "start status");
      expect(/^conv_[0-9a-f]{16}$/.test(turn.conversationId), "a conv_ id", turn.conversationId);
      expectEq(turn.end, "done", "the stream ends done");
      const seen = types(turn.events);
      for (const want of ["user.message", "chat.start", "text.delta", "done"]) {
        expect(seen.includes(want), `a ${want} frame`, seen);
      }
      expect((turn.done?.response ?? "").trim().length > 0, "a reply", turn.done);
      return { frames: [...new Set(seen)], reply: turn.done?.response };
    });

    await t.check("reload gives the message and the reply", async () => {
      const got = structured<GetOutput>(
        await t.client.tool(t.alice, t.ws, "conversations__get", {
          id: turn.conversationId,
          expand: "full",
        }),
      );
      const roles = got.messages.map((m) => m.role);
      expectEq(roles[0], "user", "the user message first");
      expect(roles.includes("assistant"), "an assistant message", roles);
      return { roles, totalMessages: got.totalMessages };
    });
  },
};

export const chatTurn: Scenario = {
  id: "chat.turn",
  title: "Send, stream, tool call, tool error, auto-title, reload",
  requires: ["scripted-model"],
  async run(t) {
    const turn = await t.client.turn(t.alice, t.ws, {
      message: `look things up ${directive({
        steps: [
          [{ tool: "conversations__list", args: { limit: 5 } }],
          [{ tool: "files__info", args: { id: "file_does_not_exist" } }],
        ],
        reply: "E2E-REPLY all done",
        chunks: 3,
      })}`,
    });
    t.note("conversationId", turn.conversationId);

    await t.check("chat/start answers a conversation id and the turn runs detached", () => {
      expectEq(turn.startStatus, 200, "start status");
      expect(/^conv_[0-9a-f]{16}$/.test(turn.conversationId), "a conv_ id", turn.conversationId);
      expectEq(turn.end, "done", "the stream ends done");
      return { conversationId: turn.conversationId };
    });

    await t.check("the stream carries the lifecycle frames in order", () => {
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

    await t.check("a tool call runs inside the turn and its result feeds the next call", () => {
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
      expect(turn.done?.response.includes("E2E-REPLY"), "the closing reply", turn.done?.response);
      return calls.map((c) => ({ name: c.name, ok: (c as { ok?: boolean }).ok }));
    });

    await t.check("a failing tool is an error result and the turn goes on", () => {
      const failed = turn.done?.toolCalls.find((c) => c.name === "files__info") as
        | { ok?: boolean; isError?: boolean }
        | undefined;
      expect(failed, "the failing call is recorded", turn.done?.toolCalls);
      expect(failed.ok === false || failed.isError === true, "marked as an error", failed);
      expectEq(turn.done?.stopReason, "complete", "the turn completed");
      return failed;
    });

    await t.check("the first turn writes a title", async () => {
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
      expectEq(got.metadata?.title, E2E_TITLE, "the fast model's title");
      return got.metadata;
    });

    await t.check("reload reconstructs the turn: user message, tool calls, reply", async () => {
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
      expect(last?.content.includes("E2E-REPLY"), "the reply is stored", last);
      return { roles, tools, totalMessages: got.totalMessages };
    });
  },
};

export const chatCancel: Scenario = {
  id: "chat.cancel",
  title: "Cancel mid-turn, a second start while running, disconnect and replay",
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

    await t.check("a second start on a running conversation is refused 409", () => {
      expectEq(secondStart, 409, "second start status");
      return { status: secondStart };
    });

    await t.check("cancel answers cancelled:true and the stream ends cancelled", () => {
      expectEq(cancelAnswer?.status, 200, "cancel status");
      expectEq((cancelAnswer?.body as { cancelled?: boolean })?.cancelled, true, "cancelled");
      expectEq(read.end, "cancelled", "the stream's last frame");
      return { cancel: cancelAnswer, end: read.end, frames: read.events.length };
    });

    // A turn whose viewer never connects still finishes and is stored.
    const detached = await t.client.startChat(t.alice, t.ws, {
      message: `detached ${directive({ reply: "E2E-DETACHED", delayMs: 600, chunks: 6 })}`,
    });
    const detachedId = (detached.json as { conversationId: string }).conversationId;

    await t.check(
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

    await t.check("a turn with no viewer still finishes and stores its reply", async () => {
      const got = await until(
        async () =>
          structured<GetOutput>(
            await t.client.tool(t.alice, t.ws, "conversations__get", {
              id: detachedId,
              expand: "full",
            }),
          ),
        (g) => g.messages.some((m) => m.role === "assistant" && m.content.includes("E2E-DETACHED")),
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
  requires: ["second-identity"],
  async run(t) {
    const bob = t.bob;
    const bobWs = t.bobWs;
    if (!bob || !bobWs) throw new Error("no second identity");
    const mine = await t.client.turn(t.alice, t.ws, { message: "hello" });

    await t.check("a malformed conversation id is 400 bad_request", async () => {
      const r = await t.client.startChat(t.alice, t.ws, {
        message: "x",
        conversationId: "../../x",
      });
      expectEq(r.status, 400, "status");
      expectEq((r.json as ApiErrorBody).error, "bad_request", "error");
      return r.json;
    });

    await t.check(
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

    await t.check("a model outside the allowlist is refused, naming the model", async () => {
      const r = await t.client.startChat(t.alice, t.ws, {
        message: "x",
        model: "nosuch:model-x",
      });
      expect(r.status >= 400 && r.status < 500, "a 4xx", r.status);
      expect(r.text.includes("nosuch:model-x"), "names the model", r.json);
      return { status: r.status, body: r.json };
    });
  },
};

export const conversationTools: Scenario = {
  id: "chat.conversations",
  title: "Conversation list, search, rename, export",
  async run(t) {
    const marker = `E2ESEARCH${Date.now().toString(36)}`;
    const turn = await t.client.turn(t.alice, t.ws, { message: `remember ${marker}` });
    expectEq(turn.end, "done", "the seed turn");
    const id = turn.conversationId;

    await t.check("list pages with nextCursor and totalCount", async () => {
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

    await t.check("search finds the conversation by message text, with a snippet", async () => {
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
    });

    await t.check("update renames it, and list shows the title", async () => {
      const r = await t.client.tool(t.alice, t.ws, "conversations__update", {
        id,
        title: "E2E renamed",
      });
      expect(!r.isError, "update succeeds", textOf(r));
      const page = structured<ConversationsListOutput>(
        await t.client.tool(t.alice, t.ws, "conversations__list", { search: "E2E renamed" }),
      );
      expect(
        page.conversations.some((c) => c.id === id && c.title === "E2E renamed"),
        "listed",
        page,
      );
      return page.conversations.map((c) => c.title);
    });

    await t.check("export gives a markdown and a JSON transcript", async () => {
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
    });

    // Public inputs are bounded.
    await t.check("list limit over 200 and a title over 200 characters are refused", async () => {
      const big = await t.client.tool(t.alice, t.ws, "conversations__list", { limit: 500 });
      expect(big.isError, "limit 500 refused", textOf(big));
      const long = await t.client.tool(t.alice, t.ws, "conversations__update", {
        id,
        title: "t".repeat(300),
      });
      expect(long.isError, "a 300-character title refused", textOf(long));
      return { list: textOf(big).slice(0, 200), update: textOf(long).slice(0, 200) };
    });
  },
};
