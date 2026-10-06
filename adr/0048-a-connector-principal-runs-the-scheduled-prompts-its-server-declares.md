# 0048. A connector principal runs the scheduled prompts its server declares

- Status: Proposed
- Date: 2026-10-06
- Serves: orchestrate remote MCP, secure RBAC

## Context

A task is the runtime's unattended primitive (ADR-0045). Every task today is
created by a member or by the agent acting for one, and every run acts as its
owner, with the owner's reach.

Some servers are only useful with standing work beside them: a nightly pass
that folds a day's corrections into a workspace skill, a morning digest of what
arrived overnight, a periodic health check. MCP gives a server tools,
resources, prompts and skills, and no way to say "run this on a schedule". So
each workspace that installs such a server has a person create the tasks by
hand, from a template the server ships. Every copy is pasted at creation, so a
server release improves no workspace until someone re-creates the task, and an
uninstall leaves tasks behind that fail on their next run.

Two existing rules constrain any answer.

- **A run acts as someone.** A task the server brings with it was chosen by no
  person. Running it as the installer would spend one member's identity, files
  and credentials on work that member never chose, and would stop the work when
  they leave the workspace (ADR-0007).
- **A grant is reviewed before it takes effect, by the party whose reach it
  spends.** A server's own statement about itself can decide how the host
  treats that server, never what anyone else can do or is exposed to
  (ADR-0024, ADR-0025). Work that runs unattended, spends the workspace's
  budget, and reaches other servers' tools is such a grant.

MCP already has the right carrier for the procedure. A prompt is server-authored
content, retrieved with `prompts/get`, parameterized by string arguments, able
to link and embed resources, and announced as changed with
`notifications/prompts/list_changed`. "Tasks" is the wrong word for a new wire
name: `io.modelcontextprotocol/tasks` already names long-running tool calls
(ADR-0046), and the domain task already shares that word (ADR-0045).

## Decision

**A server declares scheduled prompts.** Under the advertised capability
`ai.nimblebrain/scheduled-prompts`, a server marks ordinary MCP prompts with
`_meta["ai.nimblebrain/scheduled-prompts"]`. The marker carries:

- the declared **bounds**: a `schedule`; the server's own `tools`, named bare;
  per-run `limits`; and a `budget`;
- `needs`: what else the run needs, as outcomes in words ("durable memory to
  record corrections", "look up a contact"), shown to a person and never
  matched by the runtime;
- optionally, an output schema, acceptance criteria, `onPoorResult`, and
  whether the task starts enabled.

The prompt's `arguments` are the per-workspace values. A prompt is listed like
any other, so a host without the extension still sees an ordinary prompt.

**A declaration never names another server.** The marker has no field for
another server's name, tools or resources, and the runtime refuses a `tools`
entry that the declaring server does not list as its own. A server that needs
reach beyond itself says so in `needs`, and **the workspace binds each need to
connectors it has installed**. A named dependency breaks when the other server
is renamed, replaced or absent, and it ties together servers a workspace
installs separately. Only the workspace knows what it has installed.

**A connector principal owns and runs the tasks.** For each workspace a
connector is installed in, the runtime holds a principal for that installed
connector. The principal:

- **holds no role and cannot sign in.** It is the owner of the tasks the runtime
  creates from that connector's scheduled prompts;
- **has standing in place of membership.** The run-start door admits its run
  only while the connector is installed in the run's workspace. After an
  uninstall the run is recorded skipped, as a removed member's run is;
- **reaches only what the workspace holds.** Its run calls only its server's
  approved tools and the connectors bound to its needs, through the workspace wall, the unattended policy and the run's tool
  bound. It gets no identity tools and no personal connector, because a
  personal-connector grant belongs to the user who made it (ADR-0006);
- **uses the workspace's credential for each connector it calls.** A connector
  reachable only with a member's own credential cannot declare scheduled
  prompts;
- **is charged to one spend account per install**, which every run names beside
  its task's own. The door holds the account as it holds any other, opaquely.

**A workspace admin approves the bounds before they take effect.** The install
flow lists the server's scheduled prompts with their bounds and needs, takes
the argument values, and asks which of the workspace's connectors may meet each
need. It pre-selects none, because the runtime never guesses which connector
meets a need. The approval records the bounds, the values and the bindings,
never the prompt text. After install:

- A declaration whose bounds narrow or stay the same applies at once.
- One that widens them waits for approval: a new tool of its own, a more
  frequent schedule, higher limits or budget. Until then the approved bounds
  keep running.
- Reach into another connector is widened only by the workspace. A release
  that changes `needs` changes the wording shown, never a binding.
- A bound connector that is uninstalled is unbound from every task, and the
  admin is asked to choose another.
- A prompt added after install waits for approval too.
- An agent that installs a connector asks before approving, as it asks before
  creating a task.

**The server owns the procedure; the workspace owns the bounds.** A run starts
from `prompts/get` with the approved arguments, called at run time, so a
server release reaches every workspace at its next run. The returned user-role
messages become the run's opening instruction, and linked or embedded
resources are read through the host. A procedure change never asks for
approval. It acts only within bounds a person approved, which is the trust that
installing a server already gives its tools.

**The runtime reconciles; it never deletes.** It reconciles when the connection
reaches running, on `notifications/prompts/list_changed`, on boot, and before
teardown on uninstall, keyed by workspace, server and prompt name:

- It creates the task for an approved prompt that has none.
- It updates the bounds of one that narrowed.
- It disables the task of a prompt that was withdrawn (gone, unmarked, or
  answering `-32602` at run time).
- It disables every task of an uninstalled connector.

Run history is kept in every case.

**An admin's changes win over the declaration.** A pause, a moved schedule or a
lowered budget is an override, stored apart from the declaration and never
undone by a reconcile. A raised budget or a more frequent schedule is a
widening, and so an approval. A delete is a suppression: no reconcile or
reinstall recreates the task until an admin re-enables it.

**The operator bounds every declaration** in the runtime's task configuration:
whether scheduled prompts are read at all, a minimum interval, a maximum number
per connector, a maximum budget per install, and whether approvals start checked
for catalogued servers. A declaration outside those bounds is shown as not
approvable.

**A scheduled prompt has a schedule and nothing else.** A task whose provenance
is a connector cannot have an event trigger: an event route is a workspace
admin's grant, and the provenance allowlist refuses it.

## Consequences

- Installing a server can bring its standing work with it, approved once and
  kept current by the server's own releases. Hand-written provisioning templates
  for that work go away.
- The runtime gains a second kind of actor beside members. Every place that
  asks "who is this run" must answer for it: the door's standing check, the
  tool router's identity tools, the visibility of its tasks (workspace-wide,
  managed by admins, never private to a person), and notifications (the
  workspace inbox). A gap in any of them is a gap in the wall, so each is
  tested with the principal as the caller.
- Which platform tools act on the workspace and which act on a person becomes
  a property each platform tool must state. A principal reaches only the
  first kind.
- Binding a connector to a task is trusting the declaring server's procedure
  with that connector, unattended, for as long as both stay installed. The
  approval says so in words. The runtime enforces the bounds whatever the
  procedure says. It cannot judge whether a
  new procedure uses them well.
- Every scheduled run makes one `prompts/get` call before its first model call.
  A server that is down fails the run as transient, and the task's own backoff
  applies.
- The extension is private. Upstream has no home for server-declared recurring
  work yet. If one appears, the move is a rename of the capability and the
  marker, because the carrier is already the specification's own prompt.

## Alternatives considered

- **The installer owns the declared tasks** — rejected: it spends a person's
  reach on work they did not choose, and the work stops when they leave.
- **The server registers tasks with a tool call at runtime** — rejected: the
  server would choose workspace state with no review, and a server down at
  install registers nothing.
- **Declarations read from the operator catalog** — rejected: the catalog is
  shared across workspaces and cannot hold a workspace's approval, and it would
  leave out a server installed from outside it.
- **Offers only, each task created by a member** — rejected: it keeps a person
  in the loop for work the workspace wants running without one, which is the
  capability this decision exists to add.
- **A bespoke definition format instead of prompts** — rejected: prompts
  already carry server-authored instructions, arguments, resource links and
  change notification, and other hosts already show them.
- **Declarations that name the tools they need on other servers** — rejected:
  it hard-links one server to another's names, and it lets a server's release
  widen its own reach into other connectors.
- **A shared vocabulary of capabilities that servers provide and the runtime
  matches** — rejected for now: it is a registry every server must agree on,
  ahead of any evidence that a person binding needs by reading them fails.
- **Naming the extension `ai.nimblebrain/tasks`** — rejected: the protocol's
  tasks extension and the domain task already share the word.
- **Pinning the procedure to the version that was approved** — rejected: it
  asks for approval on every release, and it buys nothing a bound does not
  already enforce.
