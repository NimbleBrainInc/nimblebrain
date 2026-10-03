# 0043. A task is the unattended primitive; its trigger is optional, an execution provider runs it, and its outcome separates running from being good

- Status: Proposed
- Date: 2026-10-03
- Serves: orchestrate remote MCP, secure RBAC

## Context

The runtime has two ways to wake the agent, and they are defined by different
things. A conversation is defined by who is in the loop: a person, turn by turn,
in a thread that can be continued. An automation is defined by what wakes it: a
saved prompt with a schedule or an event. The schedule is required, so the
automation is the trigger.

That leaves out the case that has no trigger: "do this one thing, here is the
setup and the input, run it and give me the result." A caller who wants it,
whether a person or a remote agent connected over MCP, has two bad options. It can
open a conversation, which is a thread for a person and carries continuation and
persistence nobody reads. Or it can create an automation with a schedule that
never fires, run it now, read the result, and delete it. The second is what a
caller does when the data model has no word for what it wants, and it defeats
everything keyed to the automation's identity: budgets reset with each new
definition, and the definition is gone before anyone looks.

The engine for the missing case already exists. `Runtime.executeTask` runs one
unattended, one-shot run through the run-start door (ADR-0021) and returns a
deliverable, not a conversation. The door deliberately leaves persisting the run's
result to the caller that has a resource to keep. What is missing is the resource:
something that names the work, can be triggered or not, keeps the result, and says
whether the result was any good.

"Was it any good" is its own question. A run that completes has only stopped. It
can stop with a deliverable that meets what the author meant, or one that does
not, and nothing in a stop reason distinguishes them. An author can say what a
good result is in plain language ("every claim cites a live source", "at most two
prospects"), and a judge can answer bounded questions about a deliverable cheaply
and with a calibrated confidence. A judge is a capability, though, and capabilities
reach the runtime as MCP servers (ADR-0020).

Remote callers already speak the protocol for "start this, give me a handle,
poll it": MCP task augmentation (ADR-0029), which the MCP endpoint serves. Task
augmentation is how an operation is carried over the wire. It is not a domain
noun. Where a run's loop executes is a third question: in the runtime's own
process today, and an installation with a durable job service could run it there
instead, for durability and scale, if the job is told exactly what the run may do.

## Decision

**A task is the runtime's unattended primitive.** It is a workspace-owned,
path-authoritative primitive (ADR-0003), private to its owner by default
(ADR-0004), with two layers:

- **A task** is the definition: what to do (a prompt, or a skill plus an input),
  an optional input schema and output schema, optional acceptance criteria, tool
  scope, per-run limits, a budget, and a **trigger, which is optional**: none, a
  schedule, or an event.
- **A run** is one execution of a task: the input it was given, what started it,
  its deliverable and files, its activity, its cost, and its outcome.

An automation is a task whose trigger is set. A one-off is a task run once at
creation with no trigger; it is kept for its history and not listed among saved
tasks. A batch is one task run over many inputs: a parent that groups its runs,
with one concurrency share and one budget. Running a saved task by hand, from the
UI or a remote agent, is a run with no trigger involved.

**Every run starts at the run-start door.** The tasks source describes a run to
`executeTask`; it never builds an engine. Two invariants of every unattended run
are asserted at that door rather than by any one source: **admission** (how many
unattended runs execute at once, the queue beyond that, and a fair share between
workspaces) and **spend** (a budget checked before each model call, against the
run, its batch, its task, and its workspace). A source that starts runs inherits
both by construction, including sources not yet written.

**The door decides a run; an execution provider runs it.** The door resolves
everything a run is allowed to be (the workspace, the membership check, the tool
set and prompt, the model, the budgets) into a resolved run specification, and
hands it to the configured **execution provider**, which runs the engine loop and
returns the run's outcome. The runtime ships one provider, **in-process**, which
runs the loop in the runtime's own process and needs nothing else; it is the
default, and an installation with no other provider runs every task with it. A
**remote provider** runs the loop elsewhere, for example as a job on a durable
job service, and is selected by configuration, never by the task's author. A
remote provider receives the resolved specification and a credential scoped to
that one run, and nothing else: it holds no stored secret, it reaches tools only
by calling back through the runtime's MCP endpoint with that credential, so every
tool call still passes the workspace wall, consent, and the unattended policy, and
its model calls are metered against the same spend governor. A provider can narrow
what the door decided but cannot widen it, which is what keeps it from being a
second run-start door.

**A run's outcome has two independent parts.** *Execution* says how the run
ended:

| Execution | Meaning |
|---|---|
| `skipped` | Never started: refused at admission, over budget, a duplicate, or the owner is no longer a member |
| `completed` | Ended on its own with a deliverable |
| `incomplete` | Ended with a deliverable at a limit (iterations, input tokens, duration, output length) |
| `failed` | Ended without a deliverable: a model or provider error, or a refusal |
| `cancelled` | Stopped by a person or a caller |

*Assessment* says whether the deliverable is acceptable, and exists only for a
run that produced one:

| Assessment | Meaning |
|---|---|
| `pass` | The deliverable meets the output schema and the criteria |
| `fail` | It does not, with the reasons per criterion |
| `uncertain` | The judge's confidence is below the task's threshold |
| `not_assessed` | The task names no schema and no criteria |

The checks run cheapest first: the output schema is validated deterministically,
and only a schema-valid deliverable goes to the judge. A person can set the
assessment on any run, and a person's verdict replaces the judge's. The two parts
stay separate on the record; any single label a UI shows ("succeeded", "needs
review", "poor result", "failed") is derived from them and never stored.

**Acceptance criteria are written in natural language and judged through an MCP
tool.** A task's criteria are a list of rules, each optionally typed as a yes/no,
a level on an ordered rubric, or a choice, with a pass threshold. The tasks source
sends the criteria, the input, and the deliverable to a grader tool the workspace
has connected and records the typed verdicts and confidences it returns. The
runtime names no grader. A typed judging model and a general model prompted as a
judge are two servers in the same slot, and a workspace with neither still gets
schema validation.

**Over the wire, a run is an MCP task.** Running a task from a remote client is a
task-augmented tool call (ADR-0029): the call returns a handle, the client polls
it, and the result carries the deliverable and the assessment. The run record is
written before the handle is returned, so the handle survives a lost connection.
A client that does not opt in to task augmentation gets the same operations as
plain tools that return and look up a run id. No field outside the spec is needed
for either.

## Consequences

- One noun covers the triggered, the untriggered, and the batched case, and one
  history shows them all. "What runs next" is a query over task triggers and the
  admission queue; "what happened" is a query over runs; "was it good" is a filter
  on assessment.
- The author says what good means once, beside the task, and every run is held to
  it. Poor results surface as a count, a filter, and a notification rather than as
  something a person notices weeks later. A batch can stop itself when its pass
  rate collapses, before it spends its whole budget on a systematic failure.
- A person's verdict on a run is a labeled example. Criteria can be refined
  against those examples, and a judge's agreement with people can be measured.
- Admission and spend move out of the automations scheduler into the door. That is
  a change to every unattended run, and the queue becomes runtime state, not one
  source's state.
- Automations migrate. Their storage becomes task storage, reconciled at boot so
  no step depends on an operator remembering it, and their tools stay available
  under their current names for a deprecation window.
- Run history is kept indefinitely, one-off definitions with it, since a run's
  record is meaningless without the task it ran. Storage grows with use, and the
  run index needs no trim.
- A remote provider buys durability and scale: a queued or running run survives a
  runtime restart, and a batch's concurrency is bounded by budget rather than by
  the runtime's own process. It costs a network hop on every tool and model call,
  so a short task may run faster in-process, and the provider is chosen per
  installation and may be chosen per task.
- The in-process provider is the reference: a remote provider must produce the
  same outcome for the same specification, and the conformance tests run against
  both.
- Assessment costs a grader call per run, and sending a deliverable to a grader is
  a data flow. A workspace connects a grader the way it connects any server, with
  the same consent, so where the deliverable goes is the workspace's decision.
- "Task" now names the domain primitive, and MCP task augmentation is how a run
  travels. The glossary has to say so, because the protocol word and the domain
  word meet on every remote run.
- A run acts with the reach of the identity that owns its task, including the
  credentials its tools need. Those credentials are used where they are stored;
  no provider receives a copy. The unattended tool policy and a task's own tool
  scope bound what a run can do; a scope on the caller's credential is not part
  of this decision.

## Alternatives considered

- **One automation per item** — rejected: it is the workaround this decision
  removes. Every per-definition invariant resets with each definition.
- **Conversations as tasks** — rejected: a conversation is a thread for a person,
  with continuation and persistence an unattended run never uses. A run can offer
  "continue as a conversation", seeded from its result, without being one.
- **A separate batch runner beside automations** — rejected: it would be a third
  primitive with its own admission and budget, which is two implementations of
  what the door now owns.
- **A kernel task noun** — rejected: the door owns the run and leaves the
  caller's resource to the caller (ADR-0021). The task is that resource.
- **A durable job service as the run-start path** — rejected: if the job
  service decided what a run may do, it would be a second door. As an execution
  provider it runs what the door decided, which is the accepted form.
- **Shipping the specification with the credentials it needs** — rejected: a
  remote provider would then hold every secret its runs touch, outside the store
  and the wall. Calling back for tools keeps one place where secrets live.
- **Only a remote provider** — rejected: the runtime must run tasks on a laptop
  and in an installation with no job service, so the in-process provider is the
  default and the reference.
- **A run status that folds assessment in** ("succeeded with poor results") —
  rejected: whether a run ended and whether its result is good change for
  different reasons and are filtered separately.
- **A built-in judge** — rejected: judging is a capability, and capabilities reach
  the runtime as MCP servers. Building one in would pick a vendor for every tenant.
