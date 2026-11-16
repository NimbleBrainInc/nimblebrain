/**
 * Eval: Skill Catalog Activation
 *
 * The Skill Catalog renders one line per skill into the system prompt — name
 * plus description — and the model decides from that line alone whether to
 * load the body with `nb__use_skill`. The description is therefore the entire
 * activation signal, and until now nothing measured whether it works.
 *
 * That gap is not theoretical. A capability-first description — one that says
 * what a skill IS rather than when to reach for it — has been observed to sit
 * in a rendered catalog, be read by the model, and still not activate for the
 * task it covers. Nothing in the test suite could catch that, because nothing
 * exercised the decision at all.
 *
 * Fixtures below are invented, not copies of any shipped skill. What is under
 * test is the STYLE contrast (activation contract vs capability blurb), which
 * any pair of descriptions in those two styles exhibits.
 *
 * Assumptions this falsifies:
 *
 *   A1. A description written as an activation contract ("use when the user
 *       asks you to...") gets activated for the utterances it names.
 *   A2. Activation survives a capability-blurb phrasing of the same skill, or
 *       else the margin between the two styles is large enough to name. The
 *       margin is reported, never asserted: on a model that activates well
 *       regardless of wording it is legitimately zero.
 *   A3. Activation DISCRIMINATES. An on-topic utterance activates the one
 *       relevant skill, not whatever sits first in the catalog.
 *   A4. Activation does not over-fire. Off-topic utterances load nothing,
 *       so a description tuned for recall is not silently bought with
 *       precision.
 *
 * Read A1/A2 together: a single pass rate means little in isolation, and the
 * DIFFERENCE between the two phrasings of the same skill is the finding. That
 * pairing is why both live in one file.
 *
 * Scoring is a rate over `SAMPLES` runs, not a boolean. Model choice is
 * stochastic; a pass/fail on one sample is a coin flip dressed as a gate, and
 * a flaky gate is worse than no gate.
 *
 * Not covered here, deliberately: whether activation wins against tool-search
 * when both are available. These fixtures are filesystem skills with no tools,
 * so activation is the only route to the body. Production shows the model
 * often reaches for `nb__search` + `nb__manage_tools` instead when a skill's
 * server has tools — the tool makes the action POSSIBLE, the skill only makes
 * it correct. Measuring that competition needs sources with tools and is its
 * own eval; see the header note in the sibling file when it lands.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-ant-... bun test test/eval/skill-catalog-activation.eval.test.ts
 *
 * These tests call a real LLM and cost real money. They are NOT included in
 * `bun run test` or `bun run verify`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../../src/runtime/runtime.ts";
import { provisionTestWorkspace } from "../helpers/test-workspace.ts";

/**
 * The model under test, pinned rather than inherited.
 *
 * Activation is a property OF a model, so a rate is meaningless without one
 * named beside it. Inheriting the runtime default would let this number move
 * when config moves, silently, and two runs a month apart would not be
 * comparable. Override to compare across models:
 *
 *   EVAL_MODEL=claude-sonnet-5 bun test test/eval/skill-catalog-activation.eval.test.ts
 */
const EVAL_MODEL = process.env.EVAL_MODEL ?? "claude-sonnet-4-6";

/**
 * Runs per utterance.
 *
 * Five resolves only LARGE effects. A measured contrast between two runs of an
 * identical configuration showed 100% and 20% for the same utterance, which is
 * within binomial noise at this n and is not distinguishable from a real
 * difference — so anything subtler than "never" versus "always" needs this
 * raised. Override to check whether a result is signal:
 *
 *   EVAL_SAMPLES=20 bun test test/eval/skill-catalog-activation.eval.test.ts
 */
const SAMPLES = Number(process.env.EVAL_SAMPLES ?? 5);

/** Fraction of samples that must activate the expected skill. */
const RECALL_THRESHOLD = 0.6;

/** Fraction of off-topic samples that must activate NOTHING. */
const PRECISION_THRESHOLD = 0.8;

const testDir = join(tmpdir(), `nimblebrain-eval-catalog-${Date.now()}`);
let runtime: Runtime;

/**
 * Catalog fixtures.
 *
 * `CONTRACT_DESCRIPTION` and `BLURB_DESCRIPTION` are the SAME capability under
 * two phrasings, sharing one name, so A2 varies exactly one thing. They never
 * appear in the same catalog — see `seedSkills`.
 *
 * The rest are foils, phrased the way the deployed fleet phrases itself
 * (capability-first), so discrimination is measured against realistic
 * neighbours rather than strawmen.
 */
/**
 * The skill's catalog name, identical in every arm.
 *
 * The name sits in the catalog line the model reads, so naming the two
 * phrasings differently would vary two things at once and make the margin
 * uninterpretable. They are never in the catalog together (see `seedSkills`),
 * so they can share a name.
 */
const SKILL_NAME = "recall";

/** Activation-contract style: names the moment, in the words a user would use. */
const CONTRACT_DESCRIPTION =
  "Use when the user asks you to remember, save, note, or recall something, " +
  "including a preference, a fact, a decision, a correction, or phrasings like " +
  "don't forget, keep track of, and what did I tell you about X.";

/** Capability-blurb style: the same capability, described rather than triggered. */
const BLURB_DESCRIPTION =
  "A durable key-value store for facts that outlive a single conversation. " +
  "Records are grouped into namespaces and read back by key, so state gathered " +
  "in one session is available to the next.";

/**
 * Neighbours, all blurb-style, so discrimination is measured against plausible
 * alternatives rather than obvious non-answers. Invented domains — these are not
 * any product's skills.
 */
const FOILS: Array<{ name: string; description: string }> = [
  {
    name: "ledger",
    description: "A double-entry bookkeeping ledger with accounts, journals, and reconciliation.",
  },
  {
    name: "shipping",
    description: "Carrier rate shopping, label generation, and parcel tracking.",
  },
  {
    name: "translate",
    description: "Machine translation between language pairs with glossary support.",
  },
];

function skillFile(name: string, description: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "metadata:",
    "  nimblebrain:",
    "    loading-strategy: dynamic",
    "    priority: 50",
    "---",
    "",
    `# ${name}`,
    "",
    `Guidance body for ${name}. Reaching this text means the skill was activated.`,
    "",
  ].join("\n");
}

/** The catalog a sample runs against: one memory phrasing plus the foils. */
interface Catalog {
  memoryName: string;
  memoryDescription: string;
}

/**
 * Seed `wsId` with exactly `catalog.memoryName` plus the foils.
 *
 * Only one memory phrasing is ever present: with both in the catalog the model
 * would be choosing between two descriptions of one capability, which measures
 * preference between wordings rather than whether a wording activates at all.
 */
function seedSkills(wsId: string, catalog: Catalog): void {
  const dir = join(testDir, "workspaces", wsId, "skills");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${catalog.memoryName}.md`),
    skillFile(catalog.memoryName, catalog.memoryDescription),
  );
  for (const foil of FOILS) {
    writeFileSync(join(dir, `${foil.name}.md`), skillFile(foil.name, foil.description));
  }
}

/** Monotonic so every sample gets a workspace no earlier sample has touched. */
let workspaceCounter = 0;

/**
 * A workspace no conversation has happened in yet, seeded with `catalog`.
 *
 * Sampling in a SHARED workspace does not produce independent samples. Measured
 * on claude-sonnet-4-6, same runtime, same description, same utterance, the two
 * arms interleaved in one run:
 *
 *   shared workspace : 13%  Y.......
 *   fresh workspace  : 100% YYYYYYYY
 *
 * The first conversation in a workspace activates and later ones do not, so a
 * "rate" over a shared workspace mostly reports how many conversations preceded
 * the sample. That artifact produced a 100% and a 5% reading of the identical
 * configuration before it was found.
 *
 * The cause is not established, and it may not be confined to tests — if
 * accumulated workspace state suppresses activation in the product too, every
 * real workspace sits in the suppressed state permanently. Tracked separately;
 * this helper only makes the measurement honest.
 */
async function freshWorkspace(catalog: Catalog): Promise<string> {
  const wsId = `ws_eval_${++workspaceCounter}`;
  await provisionTestWorkspace(runtime, wsId);
  seedSkills(wsId, catalog);
  return wsId;
}

/** Names passed to `nb__use_skill` across a run, in call order. */
function activatedSkills(result: { toolCalls: Array<{ name: string; input: unknown }> }): string[] {
  return result.toolCalls
    .filter((tc) => tc.name === "nb__use_skill")
    .map((tc) => String((tc.input as { name?: unknown } | null)?.name ?? ""));
}

/**
 * Send `utterance` `SAMPLES` times, each in a fresh WORKSPACE, and report how
 * often `expected` was activated. A fresh conversation is not enough — see
 * {@link freshWorkspace} for the measurement that shows why.
 *
 * `expected: null` scores the precision direction — the share of runs that
 * activated NOTHING.
 */
async function activationRate(
  utterance: string,
  expected: string | null,
  catalog: Catalog,
): Promise<{ rate: number; observed: string[][] }> {
  const observed: string[][] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const wsId = await freshWorkspace(catalog);
    const result = await runtime.chat({ workspaceId: wsId, message: utterance });
    observed.push(activatedSkills(result));
  }
  const hits = observed.filter((names) =>
    expected === null ? names.length === 0 : names.includes(expected),
  ).length;
  return { rate: hits / SAMPLES, observed };
}

/**
 * Render a rate with the per-run detail behind it, and ALWAYS print it.
 *
 * A bare pass hides the margin, and the margin is most of the information: a
 * threshold cleared by one sample out of five says something very different
 * from one cleared by five, and only one of those is worth propagating to
 * other skills. This is also the record a future run gets compared against, so
 * it has to exist on green.
 */
function report(utterance: string, rate: number, observed: string[][]): string {
  const detail = observed.map((n) => (n.length ? n.join("+") : "(none)")).join(", ");
  const line = `[${EVAL_MODEL}] "${utterance}" → ${(rate * 100).toFixed(0)}% over ${SAMPLES} runs [${detail}]`;
  console.log(line);
  return line;
}

beforeAll(async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is required for evals. Run with: ANTHROPIC_API_KEY=sk-ant-... bun test test/eval/",
    );
  }
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    model: { provider: "anthropic", apiKey },
    defaultModel: EVAL_MODEL,
    noDefaultBundles: true,
    workDir: testDir,
    telemetry: { enabled: false },
    logging: { disabled: true },
  });
});

afterAll(async () => {
  await runtime?.shutdown();
  rmSync(testDir, { recursive: true, force: true });
});

describe("skill catalog — activation contract vs capability blurb", () => {
  const ASKS = [
    "can you remember my favorite color is turquoise?",
    "save this for me: I prefer morning meetings",
    "what did I tell you about my email signature?",
  ];

  it("A1 — a contract-phrased description activates for the asks it names", async () => {
    const catalog = { memoryName: SKILL_NAME, memoryDescription: CONTRACT_DESCRIPTION };
    for (const utterance of ASKS) {
      const { rate, observed } = await activationRate(utterance, SKILL_NAME, catalog);
      expect(rate, report(utterance, rate, observed)).toBeGreaterThanOrEqual(RECALL_THRESHOLD);
    }
  }, 300_000);

  it("A2 — activation holds up, and the contract-vs-blurb margin is reported", async () => {
    // Asserts a FLOOR on the contract phrasing, and reports the margin rather
    // than requiring one.
    //
    // The margin is the interesting number, but it is not a correctness
    // property: a model good enough to activate from a capability blurb scores
    // zero margin, and that is the outcome we want, not a regression. Asserting
    // contract > blurb would turn "the model improved" into a red build, which
    // is how a suite teaches people to ignore it. Measured: 60 points on one
    // model and 0 on a stronger one, with both activating correctly.
    //
    // So the gate is "activation works", and the margin goes to the log for
    // whoever is tuning descriptions.
    const contract = await activationRate(ASKS[0]!, SKILL_NAME, {
      memoryName: SKILL_NAME,
      memoryDescription: CONTRACT_DESCRIPTION,
    });
    const blurb = await activationRate(ASKS[0]!, SKILL_NAME, {
      memoryName: SKILL_NAME,
      memoryDescription: BLURB_DESCRIPTION,
    });

    const margin = contract.rate - blurb.rate;
    console.log(
      `[${EVAL_MODEL}] A2 margin: contract ${(contract.rate * 100).toFixed(0)}% ` +
        `- blurb ${(blurb.rate * 100).toFixed(0)}% = ${(margin * 100).toFixed(0)} points`,
    );
    expect(
      contract.rate,
      `contract phrasing under the floor; margin vs blurb ${(margin * 100).toFixed(0)} points`,
    ).toBeGreaterThanOrEqual(RECALL_THRESHOLD);
  }, 300_000);

  it("A3 — an on-topic ask activates the relevant skill, not a neighbour", async () => {
    const utterance = "remember that I always want plain-text emails";
    const { observed } = await activationRate(utterance, SKILL_NAME, {
      memoryName: SKILL_NAME,
      memoryDescription: CONTRACT_DESCRIPTION,
    });

    const strays = observed.flat().filter((n) => n && n !== SKILL_NAME);
    expect(strays, `activated non-memory skills: ${strays.join(", ") || "(none)"}`).toEqual([]);
  }, 300_000);

  it("A4 — off-topic asks activate nothing", async () => {
    // Recall is cheap to buy by making a description fire on everything. This
    // is the price tag: an over-eager description spends a capped body per
    // conversation on skills the turn never needed.
    const catalog = { memoryName: SKILL_NAME, memoryDescription: CONTRACT_DESCRIPTION };
    for (const utterance of ["what is 17 times 4?", "write me a haiku about rain"]) {
      const { rate, observed } = await activationRate(utterance, null, catalog);
      expect(rate, report(utterance, rate, observed)).toBeGreaterThanOrEqual(
        PRECISION_THRESHOLD,
      );
    }
  }, 300_000);
});
