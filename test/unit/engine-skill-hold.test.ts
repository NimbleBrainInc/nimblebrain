import { describe, expect, it } from "bun:test";
import type { LanguageModelV4CallOptions, LanguageModelV4Prompt } from "@ai-sdk/provider";
import { StaticToolRouter } from "../../src/adapters/static-router.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import { AgentEngine } from "../../src/engine/engine.ts";
import type {
  ConnectorSkillCandidate,
  EngineConfig,
  EngineEvent,
  EventSink,
  ToolCall,
  ToolResult,
  ToolSchema,
} from "../../src/engine/types.ts";
import { SKILL_GUIDANCE_PENDING } from "../../src/engine/types.ts";
import { MAX_SKILL_BODY_CHARS } from "../../src/skills/truncate.ts";
import { createMockModel } from "../helpers/mock-model.ts";

const config: EngineConfig = {
  model: "mock",
  maxIterations: 10,
  maxInputTokens: 500_000,
  maxOutputTokens: 4096,
};

const draftTool: ToolSchema = {
  name: "outreach__draft_email",
  description: "Draft",
  inputSchema: {},
};
const listTool: ToolSchema = {
  name: "outreach__list_campaigns",
  description: "List",
  inputSchema: {},
  annotations: { readOnlyHint: true },
};

const DRAFTING: ConnectorSkillCandidate = {
  name: "connector:outreach:drafting",
  body: "DRAFTING RULES: never open with a compliment.",
  scope: "provided",
  toolAffinity: ["outreach__draft_email"],
};

/** A model that sends `turns[i]` as its i-th response (tool calls), then stops; records every prompt. */
function scripted(turns: Array<Array<{ id: string; name: string }>>) {
  const prompts: LanguageModelV4Prompt[] = [];
  const model = createMockModel((options: LanguageModelV4CallOptions) => {
    prompts.push(options.prompt);
    const calls = turns[prompts.length - 1];
    if (!calls) return { content: [{ type: "text", text: "done" }] };
    return {
      content: calls.map((c) => ({
        type: "tool-call" as const,
        toolCallId: c.id,
        toolName: c.name,
        input: "{}",
      })),
    };
  });
  return { model, prompts };
}

function recorder(): { sink: EventSink; events: EngineEvent[] } {
  const events: EngineEvent[] = [];
  return { sink: { emit: (e) => events.push(e) }, events };
}

function run(opts: {
  turns: Array<Array<{ id: string; name: string }>>;
  candidates: ConnectorSkillCandidate[];
  tools?: ToolSchema[];
  extra?: Partial<EngineConfig>;
}) {
  const { model, prompts } = scripted(opts.turns);
  const executed: string[] = [];
  const handler = (call: ToolCall): ToolResult => {
    executed.push(call.id);
    return { content: textContent("ok"), isError: false };
  };
  const tools = opts.tools ?? [draftTool, listTool];
  const { sink, events } = recorder();
  const engine = new AgentEngine(model, new StaticToolRouter(tools, handler), sink);
  const result = engine.run(
    { ...config, connectorSkillCandidates: opts.candidates, ...opts.extra },
    "",
    [{ role: "user", content: [{ type: "text", text: "write the email" }] }],
    tools,
  );
  return { result, prompts, executed, events };
}

/** Every text in a prompt, in order. */
function texts(prompt: LanguageModelV4Prompt): string[] {
  const out: string[] = [];
  for (const m of prompt) {
    if (typeof m.content === "string") {
      out.push(m.content);
      continue;
    }
    for (const part of m.content) {
      if (part.type === "text") out.push(part.text);
      if (part.type === "tool-result" && "value" in part.output)
        out.push(String(part.output.value));
    }
  }
  return out;
}

describe("engine: a bound skill reaches the model before its tool's first call runs", () => {
  it("holds the first call, delivers the body, then runs the re-issued call", async () => {
    const r = run({
      turns: [
        [{ id: "c1", name: "outreach__draft_email" }],
        [{ id: "c2", name: "outreach__draft_email" }],
      ],
      candidates: [DRAFTING],
    });
    const result = await r.result;

    expect(r.executed).toEqual(["c2"]);
    const second = texts(r.prompts[1] ?? []);
    const heldAt = second.findIndex((t) => t.startsWith("Not run: outreach__draft_email"));
    const guidanceAt = second.findIndex((t) => t.includes("DRAFTING RULES"));
    expect(heldAt).toBeGreaterThan(-1);
    expect(guidanceAt).toBeGreaterThan(heldAt);

    const [held, ran] = result.toolCalls;
    expect(held).toMatchObject({
      id: "c1",
      ok: false,
      held: true,
      errorReason: SKILL_GUIDANCE_PENDING,
    });
    expect(ran).toMatchObject({ id: "c2", ok: true });
    expect(ran?.held).toBeUndefined();

    const injected = r.events.filter((e) => e.type === "connector.skill.injected");
    expect(injected).toHaveLength(1);
    expect(injected[0]?.data).toMatchObject({ skillName: DRAFTING.name, heldToolCallId: "c1" });
    const done = r.events.find((e) => e.type === "tool.done" && e.data.id === "c1");
    expect(done?.data).toMatchObject({ held: true, ok: false });
    expect(done?.type === "tool.done" && done.data.resourceUri).toBeFalsy();
  });

  it("holds every parallel call bound to the skill, and delivers it once", async () => {
    const r = run({
      turns: [
        [
          { id: "c1", name: "outreach__draft_email" },
          { id: "c2", name: "outreach__draft_email" },
        ],
      ],
      candidates: [DRAFTING],
    });
    const result = await r.result;
    expect(r.executed).toEqual([]);
    expect(result.toolCalls.every((c) => c.held === true)).toBe(true);
    expect(r.events.filter((e) => e.type === "connector.skill.injected")).toHaveLength(1);
  });

  it("does not hold a read the server's own default binding covers; delivers after it", async () => {
    const r = run({
      turns: [[{ id: "c1", name: "outreach__list_campaigns" }]],
      candidates: [{ ...DRAFTING, toolAffinity: ["outreach__*"], implicitBinding: true }],
    });
    await r.result;
    expect(r.executed).toEqual(["c1"]);
    expect(texts(r.prompts[1] ?? []).some((t) => t.includes("DRAFTING RULES"))).toBe(true);
  });

  it("holds a read-only call when the skill names the tool explicitly", async () => {
    const r = run({
      turns: [[{ id: "c1", name: "outreach__list_campaigns" }]],
      candidates: [{ ...DRAFTING, toolAffinity: ["outreach__list_campaigns"] }],
    });
    await r.result;
    expect(r.executed).toEqual([]);
  });

  it("lets the call run when no body arrives, and records the gap", async () => {
    const r = run({
      turns: [
        [{ id: "c1", name: "outreach__draft_email" }],
        [{ id: "c2", name: "outreach__draft_email" }],
      ],
      candidates: [{ ...DRAFTING, body: "", loadBody: async () => null }],
    });
    await r.result;
    expect(r.executed).toEqual(["c1", "c2"]);
    const gaps = r.events.filter((e) => e.type === "skill.not_delivered");
    expect(gaps[0]?.data).toMatchObject({ skillName: DRAFTING.name, reason: "fetch_failed" });
  });

  it("ends a run cancelled while guidance loads, without running the call", async () => {
    const controller = new AbortController();
    const r = run({
      turns: [[{ id: "c1", name: "outreach__draft_email" }]],
      candidates: [
        {
          ...DRAFTING,
          body: "",
          loadBody: () => new Promise<string | null>((done) => setTimeout(() => done("late"), 300)),
        },
      ],
      extra: { signal: controller.signal },
    });
    setTimeout(() => controller.abort(), 20);
    await expect(r.result).rejects.toThrow();
    expect(r.executed).toEqual([]);
  });

  it("caps one hold's guidance and names what it left out", async () => {
    const big = (n: number): ConnectorSkillCandidate => ({
      ...DRAFTING,
      name: `connector:outreach:s${n}`,
      body: `S${n} ${"x".repeat(MAX_SKILL_BODY_CHARS - 10)}`,
      priority: n,
    });
    const r = run({
      turns: [
        [{ id: "c1", name: "outreach__draft_email" }],
        [{ id: "c2", name: "outreach__draft_email" }],
      ],
      candidates: [big(4), big(1), big(3), big(2)],
    });
    const result = await r.result;
    expect(result.toolCalls[0]?.output).toContain("connector:outreach:s4");
    const delivered = r.events
      .filter((e) => e.type === "connector.skill.injected")
      .map((e) => (e.type === "connector.skill.injected" ? e.data.skillName : ""));
    expect(delivered).toEqual([
      "connector:outreach:s1",
      "connector:outreach:s2",
      "connector:outreach:s3",
    ]);
    const capped = r.events.filter((e) => e.type === "skill.not_delivered");
    expect(capped.map((e) => e.data)).toEqual([
      expect.objectContaining({ skillName: "connector:outreach:s4", reason: "capped" }),
    ]);
    // The re-issue runs: the left-out skill does not hold again this run.
    expect(r.executed).toEqual(["c2"]);
  });

  it("does not run afterToolCall for a held call", async () => {
    const seen: string[] = [];
    const r = run({
      turns: [
        [{ id: "c1", name: "outreach__draft_email" }],
        [{ id: "c2", name: "outreach__draft_email" }],
      ],
      candidates: [DRAFTING],
      extra: {
        hooks: {
          afterToolCall: async (call, result) => {
            seen.push(call.id);
            return result;
          },
        },
      },
    });
    await r.result;
    expect(seen).toEqual(["c2"]);
  });

  it("does not hold when the skill was delivered earlier in the conversation", async () => {
    const r = run({
      turns: [[{ id: "c1", name: "outreach__draft_email" }]],
      candidates: [DRAFTING],
      extra: { alreadyInjectedConnectorSkills: [DRAFTING.name] },
    });
    await r.result;
    expect(r.executed).toEqual(["c1"]);
  });

  it("caps a call that runs and gets guidance after it, and keeps the rest eligible", async () => {
    // Whole-server, implicit bindings on a read-only tool: no hold, delivered after the call.
    const big = (n: number): ConnectorSkillCandidate => ({
      ...DRAFTING,
      name: `connector:outreach:s${n}`,
      body: `S${n} ${"x".repeat(MAX_SKILL_BODY_CHARS - 10)}`,
      toolAffinity: ["outreach__*"],
      implicitBinding: true,
      priority: n,
    });
    const r = run({
      turns: [
        [{ id: "c1", name: "outreach__list_campaigns" }],
        [{ id: "c2", name: "outreach__list_campaigns" }],
      ],
      candidates: [big(4), big(1), big(3), big(2)],
    });
    await r.result;
    expect(r.executed).toEqual(["c1", "c2"]);
    const delivered = r.events
      .filter((e) => e.type === "connector.skill.injected")
      .map((e) => (e.type === "connector.skill.injected" ? e.data.skillName : ""));
    // Three fit in the first drain; the fourth is capped, then delivered after the next call.
    expect(delivered).toEqual([
      "connector:outreach:s1",
      "connector:outreach:s2",
      "connector:outreach:s3",
      "connector:outreach:s4",
    ]);
    const capped = r.events.filter((e) => e.type === "skill.not_delivered");
    expect(capped.map((e) => e.data)).toEqual([
      expect.objectContaining({ skillName: "connector:outreach:s4", reason: "capped" }),
    ]);
    expect(texts(r.prompts[1] ?? []).some((t) => t.includes("S4 "))).toBe(false);
  });

  it("delivers every body a hold kept, past the cap, and caps the rest", async () => {
    // Two parallel holds keep two full-size bodies each; a third call runs and claims one more.
    const notesTool: ToolSchema = {
      name: "notes__list",
      description: "List notes",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    };
    const big = (name: string, toolAffinity: string[], priority: number) => ({
      ...DRAFTING,
      name,
      body: `${name} ${"x".repeat(MAX_SKILL_BODY_CHARS - 40)}`,
      toolAffinity,
      priority,
    });
    const r = run({
      turns: [
        [
          { id: "c1", name: "outreach__draft_email" },
          { id: "c2", name: "outreach__list_campaigns" },
          { id: "c3", name: "notes__list" },
        ],
      ],
      tools: [draftTool, listTool, notesTool],
      candidates: [
        big("connector:outreach:h1", ["outreach__draft_email"], 50),
        big("connector:outreach:h2", ["outreach__draft_email"], 50),
        big("connector:outreach:l1", ["outreach__list_campaigns"], 40),
        big("connector:outreach:l2", ["outreach__list_campaigns"], 40),
        // Ahead of every kept body by priority, but no hold counted it.
        { ...big("connector:notes:n", ["notes__*"], 0), implicitBinding: true },
      ],
    });
    await r.result;
    expect(r.executed).toEqual(["c3"]);
    const delivered = r.events
      .filter((e) => e.type === "connector.skill.injected")
      .map((e) => (e.type === "connector.skill.injected" ? e.data.skillName : ""));
    expect(delivered).toEqual([
      "connector:outreach:l1",
      "connector:outreach:l2",
      "connector:outreach:h1",
      "connector:outreach:h2",
    ]);
    const notDelivered = r.events.filter((e) => e.type === "skill.not_delivered");
    expect(notDelivered.map((e) => e.data)).toEqual([
      expect.objectContaining({ skillName: "connector:notes:n", reason: "capped" }),
    ]);
  });
});
