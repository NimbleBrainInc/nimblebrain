/**
 * Eval: asking for the person's own plugin that is off in this workspace
 *
 * The person has Linear as a personal plugin, not turned on in the workspace
 * the chat is in. Asked to use Linear, the model should find it with
 * nb__search and call nb__request_plugin with its name, which
 * shows the person a one-click "Use here", rather than send them to the
 * Plugins page in prose (ADR-0070). The card is the question, so the reply
 * after the call should not ask it again.
 *
 * Each prompt runs several times in fresh conversations, and the suite passes
 * at a call rate of 90% or more: one model answer is a sample, not a verdict.
 *
 * Run:
 *   NB_EVAL_MODEL=anthropic:claude-sonnet-4-6 ANTHROPIC_API_KEY=sk-ant-... \
 *     bun test test/eval/request-plugin.eval.test.ts
 *
 * `NB_EVAL_TRIALS` sets the runs per prompt (default 4). These tests call a
 * real LLM and cost real money. They are NOT included in `bun run test` or
 * `bun run verify`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { IdentityConnectorStore } from "../../src/identity/connector-store.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import type { ChatResult } from "../../src/runtime/types.ts";
import { getEvalRuntime, runEval, shutdownEvalRuntime } from "./helpers.ts";

/** Linear's server name, as the shipped example catalog's `app.linear/mcp` slugs. */
const LINEAR = "app-linear-mcp";

const PROMPTS = [
  "can you use linear to find the open issues?",
  "what's open in Linear?",
  "check my linear tickets",
];
const TRIALS = Number(process.env.NB_EVAL_TRIALS || 4);
const CONCURRENCY = 4;

beforeAll(async () => {
  const runtime = await getEvalRuntime();
  // Installed for the person, granted in no workspace.
  await new IdentityConnectorStore({ workDir: runtime.getWorkDir() }).add(DEV_IDENTITY.id, {
    url: "https://mcp.linear.app/mcp",
    serverName: LINEAR,
    ui: null,
  });
});

afterAll(async () => {
  await shutdownEvalRuntime();
});

function requested(result: ChatResult): boolean {
  return result.toolCalls.some(
    (tc) => tc.name === "nb__request_plugin" && tc.input.plugin === LINEAR && tc.ok,
  );
}

/** A reply that asks the card's question again instead of leaving it to the card. */
function restatesQuestion(reply: string): boolean {
  return /\?|would you like|do you want|want me to/i.test(reply);
}

async function pool<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < jobs.length) {
        const i = next++;
        out[i] = await (jobs[i] as () => Promise<T>)();
      }
    }),
  );
  return out;
}

describe("the person's own plugin, off in this workspace", () => {
  it("asks with nb__request_plugin instead of pointing to Plugins", async () => {
    const jobs = PROMPTS.flatMap((prompt) =>
      Array.from({ length: TRIALS }, () => async () => {
        const result = await runEval(prompt);
        const calls = result.toolCalls.map((tc) => tc.name).join(", ") || "(none)";
        return {
          prompt,
          ok: requested(result),
          restated: requested(result) && restatesQuestion(result.response),
          calls,
          reply: result.response,
        };
      }),
    );
    const outcomes = await pool(jobs, CONCURRENCY);
    for (const o of outcomes) {
      const tag = o.ok ? (o.restated ? "RESTATED" : "ASKED   ") : "MISSED  ";
      console.log(
        `${tag} | ${o.prompt} | ${o.calls} | ${o.reply.replace(/\s+/g, " ").slice(0, 160)}`,
      );
    }
    const asked = outcomes.filter((o) => o.ok);
    const restated = asked.filter((o) => o.restated).length;
    console.log(`nb__request_plugin call rate: ${asked.length}/${outcomes.length}`);
    console.log(`replies restating the card's question: ${restated}/${asked.length}`);
    expect(asked.length / outcomes.length).toBeGreaterThanOrEqual(0.9);
    expect(restated / Math.max(asked.length, 1)).toBeLessThanOrEqual(0.1);
  }, 600_000);
});
