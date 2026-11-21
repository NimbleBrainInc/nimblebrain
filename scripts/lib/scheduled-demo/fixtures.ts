/**
 * What the Scheduled page demo (`bun run dev:scheduled-demo`) holds: one
 * workspace, the dev user's saved tasks in every state the board draws, each
 * with the run history that puts it there, and the one-offs and batches the
 * Runs tab lists.
 *
 * Pure data. Times are offsets from the moment the seed runs, so the board
 * always reads as current; `seed.ts` turns them into records through the tasks
 * store. Every name here is fictional.
 */

import type { Criterion, ScheduleSpec, TaskRun } from "../../../src/platform/tasks/types.ts";

/** The dev identity every request runs as (`DEV_IDENTITY` in `src/identity/providers/dev.ts`). */
export const DEMO_USER_ID = "usr_default";

export const DEMO_WORKSPACE = {
  name: "Acme Operations",
  about: "Sales and operations at Acme",
} as const;

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * How one run ended. `ok`: succeeded. `fail`: ended without a deliverable.
 * `review`: the judge was not sure. `poor`: the judge said it fell short.
 */
export type Outcome = "ok" | "fail" | "review" | "poor";

/** The word the board shows for a task (`healthOf` in the panel's `lib/attention.ts`). */
export type BoardWord =
  | "Healthy"
  | "Flaky"
  | "Failing"
  | "Turned off"
  | "Fell short"
  | "Needs review"
  | "Paused"
  | "No runs yet"
  | "Done";

export interface TaskFixture {
  id: string;
  name: string;
  prompt: string;
  /** Absent with no `onceInMs`: run only on demand. */
  schedule?: ScheduleSpec;
  /**
   * A once schedule, as an offset from now. Ahead: armed, no runs yet. Behind:
   * fired, and inert since (`onceDone`).
   */
  onceInMs?: number;
  /** Absent: on. */
  enabled?: boolean;
  /** Set: the runtime turned it off, and this is why. */
  disabledReason?: string;
  /** Run outcomes, oldest first. */
  outcomes: Outcome[];
  /**
   * Time between runs, for a task whose runs are not at cron times (interval,
   * event, on demand). A cron task's runs fall on its own previous fire times.
   */
  every: number;
  trigger: NonNullable<TaskRun["trigger"]>;
  /** What a successful run delivered. */
  preview: string;
  /** Why a failed run failed. */
  error?: string;
  criteria?: Criterion[];
  inputSchema?: Record<string, unknown>;
  /** Inputs the runs were given, cycled. */
  inputs?: unknown[];
  /** What the board should show for it. */
  board: BoardWord;
}

const okTimes = (n: number): Outcome[] => Array<Outcome>(n).fill("ok");

const CHECKED: Criterion[] = [
  {
    id: "complete",
    rule: "Every requested field is filled in, with nothing invented.",
    type: "boolean",
  },
];

export const TASKS: readonly TaskFixture[] = [
  // Healthy
  {
    id: "morning-email-digest",
    name: "Morning email digest",
    prompt:
      "Summarize my unread email from the last day: who wrote, what they ask, anything due today. Replies needed first.",
    schedule: { type: "cron", expression: "0 7 * * 1-5" },
    outcomes: okTimes(10),
    every: DAY,
    trigger: "scheduled",
    preview:
      "14 unread · 3 need a reply today: the contract redline, a pricing question, and Thursday's agenda.",
    board: "Healthy",
  },
  {
    id: "weekly-pipeline-review",
    name: "Weekly pipeline review",
    prompt:
      "Review open deals: what moved, what stalled for 14+ days, and the three deals most likely to close this month. Email it to me.",
    schedule: { type: "cron", expression: "0 8 * * 1" },
    outcomes: okTimes(8),
    every: 7 * DAY,
    trigger: "scheduled",
    preview:
      "11 open deals, 2 moved stages, 3 stalled. Most likely to close: the renewal, the pilot expansion, the agency deal.",
    board: "Healthy",
  },
  {
    id: "support-inbox-triage",
    name: "Support inbox triage",
    prompt:
      "When a support email arrives, label it by product area and urgency, and draft a reply for anything about billing.",
    schedule: { type: "event", match: { name: "mail.*" } },
    outcomes: okTimes(10),
    every: 2 * HOUR,
    trigger: "event",
    preview: "Labelled Billing · Urgent. Drafted a reply about the duplicate charge.",
    board: "Healthy",
  },
  {
    id: "competitor-pricing-watch",
    name: "Competitor pricing watch",
    prompt:
      "Check the pricing pages of our three main competitors and tell me if anything changed since the last check.",
    schedule: { type: "interval", intervalMs: 6 * HOUR },
    outcomes: okTimes(10),
    every: 6 * HOUR,
    trigger: "scheduled",
    preview: "No changes since the last check.",
    board: "Healthy",
  },
  // Intermittent
  {
    id: "slack-channel-recap",
    name: "Slack channel recap",
    prompt:
      "At the end of each day, recap #product and #eng: decisions, open questions, and anything that mentions me.",
    schedule: { type: "cron", expression: "0 17 * * 1-5" },
    outcomes: ["ok", "fail", "ok", "ok", "fail", "ok", "ok", "ok", "fail", "ok"],
    every: DAY,
    trigger: "scheduled",
    preview: "2 decisions, 4 open questions, 1 mention in #eng about the release date.",
    error: "Slack rate-limited the history read (429). It will try again on the next run.",
    board: "Flaky",
  },
  {
    id: "calendar-prep-brief",
    name: "Calendar prep brief",
    prompt:
      "Before my first meeting, brief me on each external meeting today: who's attending, our last interaction, and open items.",
    schedule: { type: "cron", expression: "30 7 * * 1-5" },
    outcomes: ["ok", "ok", "ok", "review", "ok", "ok", "review", "ok", "ok", "ok"],
    every: DAY,
    trigger: "scheduled",
    preview: "3 external meetings today. The 2pm has a new attendee from their finance team.",
    criteria: CHECKED,
    board: "Healthy",
  },
  // Failing
  {
    id: "invoice-reconciliation",
    name: "Invoice reconciliation",
    prompt:
      "Match last month's invoices against payments received and list anything unpaid or mismatched. Save it as a file.",
    schedule: { type: "cron", expression: "0 9 * * 1" },
    outcomes: ["ok", "ok", "ok", "fail", "fail", "fail"],
    every: 7 * DAY,
    trigger: "scheduled",
    preview: "42 invoices, 39 paid, 3 outstanding over 30 days.",
    error: "Couldn't reach the accounting system: the connection expired. Reconnect it in Plugins.",
    board: "Failing",
  },
  {
    id: "weekly-metrics-to-leadership",
    name: "Weekly metrics to #leadership",
    prompt:
      "Every Friday, pull this week's signups, activation and revenue, and post a short summary in #leadership.",
    schedule: { type: "cron", expression: "0 16 * * 5" },
    enabled: false,
    disabledReason:
      "Turned off after 5 runs in a row failed. The last one: Slack refused the post (not_in_channel).",
    outcomes: ["ok", "ok", "fail", "fail", "fail", "fail", "fail"],
    every: 7 * DAY,
    trigger: "scheduled",
    preview: "Signups 214 (+12%), activation 41%, revenue $38.2k.",
    error: "Slack refused the post: the agent isn't in #leadership (not_in_channel).",
    board: "Turned off",
  },
  {
    id: "lead-enrichment",
    name: "Lead enrichment",
    prompt:
      "For each new lead from the website form, find the company, size and a likely buyer, and add it to the CRM.",
    schedule: { type: "event", match: { name: "form.submitted" } },
    outcomes: ["ok", "ok", "ok", "ok", "poor"],
    every: 5 * HOUR,
    trigger: "event",
    preview: "Added the company, but the size and buyer came back empty.",
    criteria: CHECKED,
    board: "Fell short",
  },
  // Needs review
  {
    id: "draft-call-follow-ups",
    name: "Draft call follow-ups",
    prompt:
      "After each external call, draft a follow-up email from the meeting notes and leave it in my drafts. Never send.",
    schedule: { type: "event", match: { name: "meeting.ended" } },
    outcomes: ["ok", "ok", "ok", "ok", "review"],
    every: 9 * HOUR,
    trigger: "event",
    preview: "Draft ready for the partner call. It mentions pricing, so check it before sending.",
    criteria: CHECKED,
    board: "Needs review",
  },
  // Paused
  {
    id: "quarterly-board-memo",
    name: "Quarterly board memo draft",
    prompt: "Draft the quarterly board memo from this quarter's metrics, wins, misses and asks.",
    schedule: { type: "cron", expression: "0 9 1 1,4,7,10 *" },
    enabled: false,
    outcomes: ["ok", "ok"],
    every: 90 * DAY,
    trigger: "scheduled",
    preview: "Draft saved: Q3 board memo (6 pages).",
    board: "Paused",
  },
  // Once
  {
    id: "renewal-reminder",
    name: "Contract renewal reminder",
    prompt:
      "Remind me the vendor contract renews in 30 days, with the current terms and the notice deadline.",
    onceInMs: 2 * DAY,
    outcomes: [],
    every: DAY,
    trigger: "scheduled",
    preview: "",
    board: "No runs yet",
  },
  {
    id: "launch-day-checklist",
    name: "Launch day checklist",
    prompt: "On launch morning, check the status page, the signup form and the pricing page.",
    onceInMs: -3 * DAY,
    outcomes: ["ok"],
    every: DAY,
    trigger: "scheduled",
    preview: "All three pages up. Signup form tested end to end.",
    board: "Done",
  },
  // On demand
  {
    id: "research-a-company",
    name: "Research a company",
    prompt:
      "Research the company: what they do, size, funding, recent news, and who we know there.",
    outcomes: ["ok", "ok", "fail", "ok"],
    every: 3 * DAY,
    trigger: "manual",
    preview:
      "Series B logistics software company, ~180 people. Raised $40M in March. Two contacts in the CRM.",
    error: "The web search connector timed out.",
    inputSchema: {
      type: "object",
      properties: { company: { type: "string", description: "Company name or domain" } },
      required: ["company"],
    },
    inputs: [
      { company: "Northwind" },
      { company: "Contoso" },
      { company: "Fabrikam" },
      { company: "Initech" },
    ],
    board: "Healthy",
  },
  {
    id: "summarize-a-document",
    name: "Summarize a document",
    prompt:
      "Summarize the document I name in one page: the point, the numbers, and what it asks of us.",
    outcomes: ["ok", "ok"],
    every: 5 * DAY,
    trigger: "manual",
    preview: "One-page summary saved: the vendor proposal asks for a 2-year term at $96k/yr.",
    board: "Healthy",
  },
];

/** A one-off: work an MCP client ran once (`tasks__run` with an inline definition). */
export interface OneoffFixture {
  /** What its id is derived from, as the idempotency key would be. */
  key: string;
  /** Absent: the panel names it from its prompt. */
  name?: string;
  prompt: string;
  via?: string;
  /** When it ran, before now. */
  agoMs: number;
  ok: boolean;
  preview: string;
  error?: string;
}

const GRADE_PROMPT = "Grade the account's fit against our ICP.";

export const ONEOFFS: readonly OneoffFixture[] = [
  ...Array.from(
    { length: 8 },
    (_, i): OneoffFixture => ({
      key: `grade-fit-account-${i + 1}`,
      name: "Grade fit for one account",
      prompt: GRADE_PROMPT,
      via: "Claude Code",
      agoMs: 26 * HOUR - i * MINUTE,
      ok: i !== 5,
      preview:
        "Fit: strong. Mid-market, in our core industry, already uses two of our integrations.",
      error: "The CRM connector timed out.",
    }),
  ),
  {
    key: "northwind-first-touch",
    prompt: "Research Northwind and draft a first-touch email for their head of ops.",
    via: "Claude Code",
    agoMs: 50 * MINUTE,
    ok: true,
    preview: "Draft saved: a three-line note that leads with their new warehouse opening.",
  },
  {
    key: "vendor-proposal-summary",
    name: "Summarize the vendor proposal",
    prompt: "Summarize the attached vendor proposal in one page.",
    agoMs: 3 * DAY + HOUR,
    ok: false,
    preview: "",
    error: "The web search connector timed out.",
  },
];

/** A batch: one inline definition run over many inputs (`tasks__run_batch`). */
export interface BatchFixture {
  /** The idempotency key it was asked with; the panel names a nameless batch from it. */
  key: string;
  name?: string;
  prompt: string;
  via?: string;
  /** When its last item ended, before now. */
  agoMs: number;
  pass: number;
  fail: number;
  /** Items not yet run: the batch is paused with these waiting. */
  pending?: number;
  /** What each item's run cost, in USD. */
  itemCostUsd: number;
}

export const BATCHES: readonly BatchFixture[] = [
  {
    key: "fit-pilot-armA",
    name: "Fit grade pilot, arm A",
    prompt: GRADE_PROMPT,
    via: "Claude Code",
    agoMs: 2 * HOUR,
    pass: 85,
    fail: 15,
    itemCostUsd: 0.047,
  },
  {
    key: "fit-pilot-armB-small-model",
    prompt: GRADE_PROMPT,
    via: "Claude Code",
    agoMs: 2 * HOUR + MINUTE,
    pass: 100,
    fail: 0,
    itemCostUsd: 0.0027,
  },
  {
    key: "enrich-new-signups",
    name: "Enrich new signups",
    prompt: "Find the company, size and a likely buyer.",
    via: "Cursor",
    agoMs: 20 * MINUTE,
    pass: 37,
    fail: 2,
    pending: 61,
    itemCostUsd: 0.023,
  },
  {
    key: "cap-test-C-2000",
    prompt: "Grade fit with a 2000-token cap.",
    via: "Claude Code",
    agoMs: 3 * DAY,
    pass: 1,
    fail: 19,
    itemCostUsd: 0.014,
  },
];
