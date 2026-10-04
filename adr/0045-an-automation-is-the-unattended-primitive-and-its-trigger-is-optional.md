# 0045. An automation is the unattended primitive; its trigger is optional, and its outcome separates running from being good

- Status: Proposed
- Date: 2026-10-03, revised 2026-10-04
- Serves: orchestrate remote MCP, secure RBAC

## Context

The runtime has two ways to wake the agent, and they are defined by different
things. A conversation is defined by who is in the loop: a person, turn by turn,
in a thread that can be continued. An automation is defined by what wakes it: a
saved prompt whose `schedule` field is required, and an event is one kind of
schedule. The automation is its trigger.

That leaves out two cases, and production shows both being forced into the
automation's shape:

- **One action at a time T.** With no one-shot schedule, single actions are
  encoded as annually recurring crons that stay armed after they fire (#1001).
- **One action now, with no trigger at all.** "Do this one thing, here is the
  setup and the input, run it and give me the result." A remote client driving
  per-item work has been observed creating an automation with a schedule that
  never fires, running it, reading the result, and deleting it, once per item.
  Everything keyed to the automation's identity is defeated: a budget resets with
  each new definition, and the definition is gone before anyone looks. Those
  runs' results were also never judged, and a large share of them had failed or
  degraded without anything flagging it (internal design note, available on
  request).

Admission is the third pressure. The global concurrent-run limit lives in the
automations scheduler, so each way of starting a run enforces it separately, and
the paths that do not have dropped or stalled runs at the limit (#1450, #1451).

The engine for the untriggered case already exists. `Runtime.executeTask` runs
one unattended, one-shot run through the run-start door (ADR-0021) and returns a
deliverable, not a conversation. The door deliberately leaves persisting the
run's result to the caller that has a resource to keep. What is missing is the
resource: something that names the work, may or may not be triggered, keeps the
result, and says whether the result was any good.

"Was it any good" is its own question. A run that completes has only stopped. It
can stop with a deliverable that meets what the author meant, or one that does
not, and no stop reason distinguishes them. An author can say what a good result
is in plain language ("every claim cites a live source", "at most two
prospects"), and a judge can answer bounded questions about a deliverable cheaply
and with a calibrated confidence. A judge is a capability, though, and
capabilities reach the runtime as MCP servers (ADR-0020).

Remote callers already speak the protocol for "start this, give me a handle,
poll it": the MCP tasks extension, which the `/mcp` endpoint serves. Its server
half holds no task state of its own: it routes a task lookup to the task-aware
source that started the task.

A workspace holds two kinds of work, and they take different verbs:

- **Executable work** is carried out by the agent, unattended. It is *run*: now,
  at a time, on a schedule, on an event, or over a list of inputs.
- **Tracked work** is a record of something a person or the agent will do. It is
  *opened, assigned, blocked, and checked off*. A tracking connector holds it,
  such as the workspace's Tasks app, a project board, or an issue tracker.

## Decision

**A noun names one kind of work when it takes only that kind's verbs.** You run an
automation and never check one off; you check off a to-do and never run one.
"Task" takes both ("run a task", "complete a task"), so it names tracked work,
as people and every tracking connector already use it, and never the executable
primitive. "Task" also stays the MCP protocol's word for the handle of a
long-running call (ADR-0046). Any future name for either kind of work passes the
same test.

**An automation is the runtime's unattended primitive.** It is a workspace-owned,
path-authoritative primitive (ADR-0003), private to its owner by default
(ADR-0004), with two layers:

- **An automation** is the definition: what to do (a prompt, or a skill plus an
  input), an optional input schema and output schema, optional acceptance
  criteria with a confidence threshold, tool scope, per-run limits, a budget, and
  a **trigger, which is optional**: none; a schedule, which may recur or fire once
  at a time T after which the automation is inert until re-armed; or an event.
- **A run** is one execution of an automation: the input it was given, what
  started it, its deliverable and files, its activity, its cost, and its outcome.

A scheduled automation has a trigger. A one-off is an automation run once at
creation with no trigger ("run once"); it is kept with its history and not
listed among saved automations. A batch is one automation run over many inputs:
a parent the automations source keeps, grouping its runs under one concurrency
share and one budget. Running a saved automation by hand, from the UI or a remote
agent, is a run with no trigger involved. Starting a run takes the same standing
in the workspace as calling a tool there (ADR-0036).

The automations source is the platform source `automations`, with tools
`automations__*`, storage under `workspaces/<ws>/automations/`, configuration in
the `automations` block, and the sidebar route `@nimblebraininc/automations`.

**Every run starts at the run-start door, and the door stays ignorant of
automations.** The automations source describes a run to `executeTask`; it never
builds an engine. The door hands the resolved run to whatever executes the engine
loop, which today is the runtime's own process. Two invariants of every
unattended run are asserted at the door rather than by any one source:

- **Admission**: how many unattended runs execute at once, the queue beyond that,
  and a fair share between workspaces.
- **Spend**: the run's description names a list of **spend accounts**, each an
  opaque id the source chose, with a unit (dollars, input tokens, or output
  tokens) and the amount remaining. The door keeps **one live balance per account
  id** for as long as any run naming it is in flight: the first run to name an id
  sets the balance, and every run naming it checks and debits that same balance,
  so runs that share an account cannot together exceed it. Before each model
  call the door reserves the call's projected cost against every account,
  lowering the call's output ceiling to what they can pay for, and ends the run
  with a typed stop reason when they cannot pay for a minimal call; after the
  call it releases the reservation and debits the actual cost, and the source
  learns what was spent from the run's reported usage. The door never interprets
  an account: whether an id stands for a batch, an automation, or a workspace is
  the source's knowledge, so the door gains no notion of a run's parent
  (ADR-0021).

A source that starts runs inherits both by construction, including sources not
yet written.

**A run's outcome has two independent parts.** *Execution* says how the run
ended:

| Execution | Meaning |
|---|---|
| `skipped` | Never started: refused at admission, over a spend account, a duplicate, or the owner is no longer a member |
| `completed` | Ended on its own with a deliverable |
| `incomplete` | Ended at a limit (iterations, input tokens, duration, output length, a spend account) with a partial deliverable |
| `failed` | Ended without a deliverable: a model or provider error, a refusal, or a limit reached before anything was produced |
| `cancelled` | Stopped by a person or a caller |

A run is a **duplicate** when its call repeats an idempotency key already used
for that automation, or when the same trigger fires while the automation already
has a run from that trigger running or queued. Manual and batch runs are never
duplicates of each other on that ground: they differ by input. The
execution record also carries **unrecovered tool failures**: the tools whose
calls failed with no later call making them good, so part of the work did not
happen. It is recorded whatever the execution value, and it is read without any
criteria.

*Assessment* says whether the deliverable is acceptable, and exists only for a
run that produced one:

| Assessment | Meaning |
|---|---|
| `pass` | The deliverable meets the output schema and the criteria |
| `fail` | It does not, with the reasons per criterion |
| `uncertain` | The judge's confidence on some criterion is below the automation's confidence threshold |
| `not_assessed` | The automation names no schema and no criteria |

Each criterion passes at its own level (a yes, a rubric level, a choice); the
automation's confidence threshold is separate and decides only `uncertain`. The
checks run cheapest first: the output schema is validated deterministically, and
only a schema-valid deliverable goes to the judge. A person can set the
assessment on any run, and a person's verdict replaces the judge's. The parts
stay separate on the record. Any single label a UI shows ("succeeded", "needs
review", "poor result", "failed") is derived from them and never stored, and a
run with unrecovered tool failures never derives to "succeeded".

**Acceptance criteria are written in natural language and judged through an MCP
tool.** An automation's criteria are a list of rules, each optionally typed as a
yes/no, a level on an ordered rubric, or a choice. The automations source sends
the criteria, the input, and the deliverable to a judge tool the workspace has
connected and records the typed verdicts and confidences it returns. The runtime
names no judge. A typed judging model and a general model prompted as a judge are
two servers in the same slot, and a workspace with neither still gets schema
validation and the unrecovered-failure signal.

**Over the wire, a run is an MCP task.** Running an automation from a remote
client is a task-augmented tool call. The automations source is the task-aware
source the `/mcp` endpoint routes to, and the task id it hands out is the run id,
so a lookup reads the run record. The record is written before the handle is
returned, so the handle survives a lost connection, and on the current protocol
revision it also survives a runtime restart; the older revision routes task
lookups in memory, so there a restart drops the handle while the run record
stays. A client that does not opt in to the tasks extension gets the same
operations as plain tools that return and look up a run id. No field outside the
spec is needed for either.

**Run history is kept indefinitely.** A run's record is meaningless without its
automation, so one-off definitions are kept with it. The run index is
partitioned (by period) and read a page at a time, so no read loads an
automation's whole history.

## Consequences

- One noun covers the triggered, the untriggered, the once-at-T, and the batched
  case, and one history shows them all. "What runs next" is a query over
  automation triggers and the admission queue; "what happened" is a query over
  runs; "was it good" is a filter on assessment.
- Each word names one thing. "An automation runs every Monday and adds a task for
  each stalled deal" reads one way, and "starting an automation returns a task
  handle" reads one way to an engineer. A tracking connector keeps `create_task`
  without competing with the runtime's own tools.
- The author says what good means once, beside the automation, and every run is
  held to it. Poor results surface as a count, a filter, and a notification
  rather than as something a person notices later. A batch can stop itself when
  its pass rate collapses, before it spends its whole budget on a systematic
  failure.
- A person's verdict on a run is a labeled example. Criteria can be refined
  against those examples, and a judge's agreement with people can be measured.
- Admission and spend move out of the automations scheduler into the door. That
  is a change to every unattended run, and the queue becomes runtime state, not
  one source's state. Per-automation and per-batch budgets become spend accounts
  the automations source names, checked before each call instead of after a run.
- An automation's token budget (separate input and output caps, reset each
  period, the automation disabled when one runs out) becomes two token-unit
  spend accounts the automations source re-issues at each period's start; when a
  run exhausts one, the source disables the automation's trigger, as today.
- Stored automations keep their place and gain the new fields, reconciled at boot
  so no step depends on an operator remembering it; storage written under
  `tasks/` returns to `automations/` the same way. Run statuses map:
  `success` → `completed`; `degraded` → `completed` with its unrecovered tool
  failures; `failure` → `failed`; `timeout` → `incomplete` when the run left a
  partial deliverable and `failed` when it left none; `cancelled` and `skipped`
  unchanged. A never-firing annual cron that stood for one action at T becomes a
  once-at-T schedule.
- The `tasks` forms break: a client calling `tasks__*`, a saved `allowedTools`
  pattern naming them, or a deployment setting the `tasks` block moves to the
  `automations` form.
- Stored automations lose today's cap on retained runs. Storage grows with use,
  and the partitioned, paged index is what keeps reading it bounded.
- Assessment costs a judge call per run, and sending a deliverable to a judge
  is a data flow. A workspace connects a judge the way it connects any server,
  with the same consent, so where the deliverable goes is the workspace's
  decision.
- A run acts with the reach of the identity that owns its automation, including
  the credentials its tools need, used where they are stored. The unattended tool
  policy and an automation's own tool scope bound what a run can do.
- Executing the loop somewhere other than the runtime's process is left open: the
  door already hands over a resolved run. Doing it needs a way for `/mcp` to
  recognize a run-scoped credential and re-apply the run's bounds, a model-call
  path that keeps spend checks in the runtime, and a path for the run's activity
  and cost back into its record. That is a separate decision (ADR-0047), made
  when there is a job service to run it on.

## Alternatives considered

- **One automation per item** — rejected: it is the workaround this decision
  removes. Every per-definition invariant resets with each definition.
- **Conversations as automations** — rejected: a conversation is a thread for a
  person, with continuation and persistence an unattended run never uses. A run
  can offer "continue as a conversation", seeded from its result, without being
  one.
- **A separate batch runner beside automations** — rejected: it would be a third
  primitive with its own admission and budget, which is two implementations of
  what the door now owns.
- **A kernel automation noun** — rejected: the door owns the run and leaves the
  caller's resource to the caller (ADR-0021). The automation is that resource.
- **The door checks batch and automation budgets by name** — rejected: it would
  teach the door what a batch and an automation are, which is the parent plumbing
  ADR-0021 keeps out. Opaque spend accounts give the same check without the
  knowledge.
- **A run status that folds assessment in** ("succeeded with poor results") —
  rejected: whether a run ended and whether its result is good change for
  different reasons and are filtered separately.
- **A built-in judge** — rejected: judging is a capability, and capabilities
  reach the runtime as MCP servers. Building one in would pick a vendor for every
  tenant.
- **"Task" as the noun** — rejected: it takes both kinds' verbs. The runtime's
  `tasks__create` sits beside a tracking connector's `create_task` in the same
  workspace, and a built-in `tasks` route takes the sidebar page of a tracker that
  declares the same one.
- **"Job"** — rejected: it takes both kinds' verbs too ("run a job", "a job to be
  done"), it is a posting to a recruiting connector and a work order to a
  field-service one, and it reads as engineering to the operators who author
  automations.
- **"Routine"** — rejected: it implies recurrence, and a one-off or a batch has
  none.
- **"Run"** — rejected: it names one execution, the child of the primitive.
- **"Workflow" or "playbook"** — rejected: both imply a graph of steps, and an
  automation is one unattended run of the agent loop.
- **"Automation" implies a trigger** — considered and accepted: products that use
  the word run an automation by hand or once ("run once"), and people read it as
  "the system does this for me", not "this has a schedule".
