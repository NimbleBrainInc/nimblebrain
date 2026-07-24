/**
 * Seed a dev workdir with conversations and skills so the shell renders filled
 * rather than empty.
 *
 * Empty states are the least informative view of a UI: they hide density,
 * wrapping, truncation, scope variety, and every contrast pair that only
 * appears once there is content. A fresh worktree has none, so nobody can see
 * what they are actually building until they have hand-driven the app.
 *
 * DEV ONLY. It writes plain JSONL and SKILL.md files into a workdir; it never
 * calls a model and never touches a real tenant. It refuses to run against a
 * workdir that is not obviously a dev one unless `--force` is passed.
 *
 *   bun run seed:dev                      # the worktree workdir
 *   NB_WORK_DIR=/abs/path bun run seed:dev
 *   bun run seed:dev -- --force           # any workdir, including ~/.nimblebrain
 *
 * Every record it writes is namespaced `seed-` / `conv_seed_`, and it writes
 * only when the target is absent or already identical — so a re-run is a no-op,
 * and it never replaces a real skill or a thread you have since chatted in.
 *
 * All content is fictional and uses reserved example domains. This is a PUBLIC
 * repository: never seed it with anything resembling a real person, customer,
 * or address.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { workspaceConversationsDir } from "../src/conversation/paths.ts";
import { personalWorkspaceIdFor } from "../src/workspace/workspace-store.ts";

const WORKTREE_ROOT = dirname(import.meta.dir);
const DEFAULT_WORKDIR = join(WORKTREE_ROOT, ".nimblebrain-worktree");
const workDir = resolve(process.env.NB_WORK_DIR || DEFAULT_WORKDIR);
const force = process.argv.includes("--force");

// A dev workdir is worktree-local or explicitly forced. This guard is the only
// thing standing between a convenience script and someone's real conversations.
if (!force && !workDir.includes(".nimblebrain-worktree")) {
  console.error(
    `[seed] Refusing to seed ${workDir} — it does not look like a worktree dev workdir.\n` +
      `[seed] Pass --force if you really mean it.`,
  );
  process.exit(1);
}

const USER_ID = "usr_default";
// Both of these formats are single-site by convention (`check:personal-workspace-id`,
// `check:conversation-paths`). Those lints scope to `src/`, so a hand-built string
// here would pass CI and silently write where nothing reads.
const WORKSPACE_ID = personalWorkspaceIdFor(USER_ID);
const MODEL = "anthropic:claude-sonnet-4-6";
/** Marks a file as this script's, so a re-run never clobbers a real one. */
const SEED_SOURCE = "scripts/seed-dev-data.ts";
const SEED_MARKER = `<!-- seeded by ${SEED_SOURCE} -->`;

/** True when a conversation's line-0 header records this script as its author. */
function firstLineIsSeeded(path: string): boolean {
  const firstLine = readFileSync(path, "utf8").split("\n", 1)[0] ?? "";
  try {
    const header = JSON.parse(firstLine) as { metadata?: { seededBy?: unknown } };
    return header.metadata?.seededBy === SEED_SOURCE;
  } catch {
    return false;
  }
}

/**
 * Write only when it is safe to: the file is absent, or already byte-identical
 * to what we would produce.
 *
 * Provenance alone is not enough. A file this script wrote becomes REAL the
 * moment anything else touches it — the runtime appends your turns to a seeded
 * thread as soon as you chat in one — so "we wrote it" does not imply "we may
 * replace it". Identical content is the only safe overwrite, and it is a no-op.
 */
function writeIfSafe(path: string, contents: string, ours: (p: string) => boolean): string | null {
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") === contents) return path;
    const reason = ours(path)
      ? "seeded earlier but changed since — real turns would be lost"
      : "exists and was not written by this script";
    console.warn(`[seed]   skipped ${path} — ${reason}`);
    return null;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

/** Fixed clock so re-seeding is deterministic and diffs stay empty. */
const BASE = Date.parse("2026-07-20T09:00:00.000Z");
const at = (minutesFromBase: number) => new Date(BASE + minutesFromBase * 60_000).toISOString();

type Turn = { user: string; assistant: string };

type Thread = {
  id: string;
  title: string;
  /** Minutes from BASE for the first message; each turn advances a few more. */
  startsAt: number;
  turns: Turn[];
};

/**
 * Threads are written to exercise the surfaces, not to look impressive: a long
 * multi-paragraph answer (prose typography), a one-line answer (short turns), a
 * title long enough to truncate in the sidebar, inline code and emphasis (mixed
 * content against the reading face), and a list.
 */
const THREADS: Thread[] = [
  {
    id: "conv_seed_research",
    title: "Who visited the pricing page twice this week from a district address?",
    startsAt: 0,
    turns: [
      {
        user: "someone from a school district hit the pricing page twice this week. can you look into who that might be?",
        assistant:
          "I traced the sessions to a single visitor and matched the referring profile.\n\nBoth visits landed on `/pricing` from an organic search for *managed agent platform*. The second was four minutes, which is long for that page.\n\nI can enrich the record and add them to People, or dig into why a district would be evaluating infrastructure tooling. Want me to do either?",
      },
      {
        user: "add them to people",
        assistant:
          "Added and enriched. They're now in People:\n\n**Dana Reyes** — dana.reyes@example.org, org: Example Unified School District, title: Operations Lead, lead source: website visit, status: sourced\n\nDossier attached with the research findings.\n\nCheck the sidebar to see the record. No current forcing function identified for the visit — flagged in the dossier as open.",
      },
    ],
  },
  {
    id: "conv_seed_release",
    title: "Cut the 0.42 release",
    startsAt: 180,
    turns: [
      {
        user: "cut a release",
        assistant:
          "Tagged `v0.42.0` and pushed. The release workflow is running.\n\nThree things landed since `v0.41.3`:\n\n- Workspace-scoped conversation resume, which closes the cross-workspace tool leak\n- Bundle UI self-heal on worktree dev start\n- Contrast guard on the theme tokens\n\nI'll report back when the workflow finishes. Nothing in the diff needs an operator migration.",
      },
    ],
  },
  {
    id: "conv_seed_grafana",
    title: "Why did staging latency spike at 14:20?",
    startsAt: 400,
    turns: [
      {
        user: "staging p99 jumped around 14:20, any idea?",
        assistant:
          "It was the connection revalidator, not traffic.\n\nAt 14:19 the provider probe started returning `indeterminate` on every call and the loop retried each one three times before backing off. Request volume was flat through the window, so the p99 is the revalidator's own outbound calls queueing behind a slow upstream, not user requests getting slower.\n\nIt self-recovered at 14:31 when the circuit breaker tripped. Worth raising the backoff floor so a slow provider can't do this again.",
      },
      {
        user: "open an issue for the backoff",
        assistant:
          "Opened an issue — *Raise revalidator backoff floor so a slow provider can't inflate p99*. Unassigned, labelled `platform`.",
      },
    ],
  },
  {
    id: "conv_seed_short",
    title: "Deploy status",
    startsAt: 610,
    turns: [
      {
        user: "is staging green?",
        assistant: "Yes — all three services healthy, last deploy 22 minutes ago.",
      },
    ],
  },
];

/**
 * Skills across all three tiers, so the Skills settings surface shows its scope
 * rails doing real work rather than one repeated colour.
 */
type SeedSkill = { name: string; description: string; body: string; always: boolean };

const WORKSPACE_SKILLS: SeedSkill[] = [
  {
    name: "release-checklist",
    description:
      "Steps to cut and verify a release. Use when the user asks to cut, tag, or ship a release.",
    body: "Confirm CI is green on `main`, tag with a `v` prefix, watch the release workflow, then post the notes to the announce channel.",
    always: false,
  },
  {
    name: "voice-rules",
    description: "How to write in this workspace's voice. Applies to every message.",
    body: "No em-dashes. No AI-speak tics. Say the thing directly and stop.",
    always: true,
  },
];

const USER_SKILLS: SeedSkill[] = [
  {
    name: "personal-voice",
    description: "Personal writing preferences that follow this user across every workspace.",
    body: "Prefer short paragraphs. Lead with the answer, then the reasoning.",
    always: true,
  },
];

const ORG_SKILLS: SeedSkill[] = [
  {
    name: "mpak-guide",
    description: "How to use the mpak CLI to discover, install, and run MCP bundles.",
    body: "Search with `mpak search`, install with `mpak install <bundle>`, then restart the runtime.",
    always: false,
  },
];

function writeThread(thread: Thread): string | null {
  const dir = workspaceConversationsDir(workDir, WORKSPACE_ID, USER_ID);
  const path = join(dir, `${thread.id}.jsonl`);

  // EVENT-SOURCED format. The runtime constructs an EventSourcedConversationStore,
  // and the legacy display projection reads `content` as a STRING — while a
  // correctly-typed legacy StoredMessage carries an array — so a legacy-shaped
  // seed reads back as four titled empty shells: no preview, no tokens, no model.
  const events: unknown[] = [];
  let cursor = thread.startsAt;

  for (const [i, turn] of thread.turns.entries()) {
    const runId = `${thread.id}_run_${i}`;
    events.push({
      ts: at(cursor),
      type: "user.message",
      content: [{ type: "text", text: turn.user }],
      userId: USER_ID,
    });
    cursor += 1;

    events.push({ ts: at(cursor), type: "run.start", runId, model: MODEL });

    // Rough but plausible: prompt grows with history, output tracks reply length.
    const usage = {
      inputTokens: 1800 + i * 1400 + thread.turns.length * 120,
      outputTokens: Math.round(turn.assistant.length / 3.6),
    };

    events.push({
      ts: at(cursor),
      type: "llm.response",
      runId,
      model: MODEL,
      content: [{ type: "text", text: turn.assistant }],
      usage,
      llmMs: 2400 + i * 310,
      finishReason: "stop",
    });
    events.push({
      ts: at(cursor),
      type: "run.done",
      runId,
      stopReason: "stop",
      totalMs: 2600 + i * 310,
    });
    cursor += 4;
  }

  // Line 0 is the Conversation; `format: "events"` selects the event reader.
  const lines = [
    JSON.stringify({
      id: thread.id,
      createdAt: at(thread.startsAt),
      updatedAt: at(cursor),
      title: thread.title,
      lastModel: MODEL,
      ownerId: USER_ID,
      workspaceId: WORKSPACE_ID,
      format: "events",
      // `metadata` is caller-provided and never validated by the runtime, so it
      // is the right place to record provenance without inventing a field.
      metadata: { seededBy: SEED_SOURCE },
    }),
    ...events.map((e) => JSON.stringify(e)),
  ];

  return writeIfSafe(path, `${lines.join("\n")}\n`, firstLineIsSeeded);
}

function writeSkill(baseDir: string, skill: SeedSkill): string | null {
  // Skill dirs are namespaced `seed-` for the same reason conversation ids are
  // `conv_seed_`: several of these names (mpak-guide, release-checklist) are
  // real skills in this org's library, and an unconditional write would replace
  // hard-won content with a one-line stub.
  const target = join(baseDir, `seed-${skill.name}`, "SKILL.md");
  const frontmatter = [
    "---",
    `name: seed-${skill.name}`,
    `description: ${skill.description}`,
    "metadata:",
    "  nimblebrain:",
    `    loading-strategy: ${skill.always ? "always" : "dynamic"}`,
    ...(skill.always ? [] : ["    triggers:", `      - ${skill.name.replace(/-/g, " ")}`]),
    "---",
    "",
    `${SEED_MARKER}`,
    "",
    skill.body,
    "",
  ].join("\n");
  return writeIfSafe(target, frontmatter, (p) => readFileSync(p, "utf8").includes(SEED_MARKER));
}

if (!existsSync(workDir)) {
  console.error(`[seed] No workdir at ${workDir}. Start the app once so it seeds, then re-run.`);
  process.exit(1);
}

console.log(`[seed] Workdir: ${workDir}`);

let conversationsWritten = 0;
for (const thread of THREADS) {
  if (writeThread(thread)) {
    conversationsWritten++;
    console.log(`[seed]   conversation: ${thread.title}`);
  }
}

const tiers: [string, SeedSkill[]][] = [
  [join(workDir, "workspaces", WORKSPACE_ID, "skills"), WORKSPACE_SKILLS],
  [join(workDir, "users", USER_ID, "skills"), USER_SKILLS],
  [join(workDir, "skills"), ORG_SKILLS],
];
let skillsWritten = 0;
for (const [dir, skills] of tiers) {
  for (const skill of skills) {
    if (writeSkill(dir, skill)) {
      skillsWritten++;
      console.log(`[seed]   skill: seed-${skill.name}`);
    }
  }
}

console.log(
  `[seed] Done — ${conversationsWritten} conversations, ` +
    `${skillsWritten} skills across three tiers.`,
);
