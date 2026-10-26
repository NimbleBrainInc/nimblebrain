# 0056. An agent runtime executes what the door decided

- Status: Proposed
- Date: 2026-10-24
- Serves: orchestrate remote MCP, secure RBAC
- Refines: ADR-0047 (one seam for where a loop runs and which loop runs)

## Context

`Runtime.startRun` decides a run (ADR-0021): the workspace and the membership
gate, the composed prompt and skills, the walled tool router, the history read
back from the conversation log, the model and the limits. It then ran the
engine loop itself, at one line.

Agents that run their own loop are now common, and several speak the Agent
Client Protocol (ACP), which lets a client drive any of them the same way. Running
a turn on one of them, beside the engine and not instead of it, raises two
questions: where the line between NimbleBrain and the agent falls, and what keeps
each new agent from becoming a change to the platform.

ADR-0047 already answers the first for one case: the door decides a run and an
execution provider runs it, and a provider may narrow what a run allows, never
widen it. It frames a provider as *where* the loop runs (in this process or in
a durable job). An agent with its own loop is a second axis, *which* loop runs,
and the line falls in the same place.

What NimbleBrain must keep is the record and the reach. The conversation log is
the only record of a conversation; the tool router is the only way to a tool;
the door is the only place a run's tools, prompt, model and limits are decided.
An agent's own session store, tool configuration or credentials must never
become any of these.

## Decision

**One seam behind the door: an agent runtime executes a resolved run.**
`AgentRuntime.execute(run, io)` receives what the door resolved (the system
prompt, the history, the tools surfaced, the model and limits, the cancellation
signal) and the run's I/O: its walled tool router and its event sink. The seam
carries NimbleBrain's types only. ADR-0047's execution providers and agents with
their own loops are both implementations of it; where a runtime physically runs
is that runtime's concern.

**Which runtime runs a run is installation configuration** (`execution` in
`nimblebrain.json`), never a task author's or a model's choice. The native
engine is the default and the reference.

**Every runtime records in the engine's own vocabulary.** It emits
`EngineEventPayloads` events stamped with the door's run id (the native engine
takes it through `EngineConfig.runId`), so the conversation
log and the browser stream are unchanged and a turn on any runtime replays on
any other. Each run records one `execution.bound` naming its runtime and that
runtime's own session id: a conversation maps to its runs, a run to the runtime
and session that executed it. A runtime's session is never reused as the
conversation: each execution opens a fresh one from the history the door hands
over, because no runtime's checkpoint is portable to another.

**An external runtime reaches tools through a per-run projection of the router,
and only through it.** The projection is an MCP endpoint over the run's walled
router, opened for the run and closed with it, reachable on loopback behind a
random path and bearer. It applies the checks the engine applies to a model's
call and the run's call-level hooks, and it emits the run's tool record from
what it dispatched. It is not `/mcp/<wsId>`, which serves a person's attended
surface and would widen an unattended run's reach (ADR-0047).

**No agent runs as a child of the runtime.** A runtime reaches its agent in
the runtime's own process (NimbleBrain's engine) or outside the installation,
never by spawning one beside it. A child would share the runtime's user, network
namespace and filesystem, and on Linux a same-user process can read its parent's
environment, which holds every secret the runtime has; scrubbing the child's own
environment does not change that. An agent with its own loop is the riskiest
extension the platform hosts, so it gets isolation of its own or does not run.
`src/execution/` cannot spawn a process (lint-enforced).

An external agent such as Goose therefore runs out of process and joins when
three things exist: a remote ACP transport, the tool projection served on the
runtime's own server behind a run-scoped credential (ADR-0047's callback, so
local and remote runtimes share one way back to the router), and the
installation's model gateway as the agent's model endpoint, which holds the keys,
the model policy and the meter. Until then the Goose driver serves only the live
parity eval.

**A runtime declares what it holds, and the door refuses a run it cannot hold.**
A runtime that does not check each model call against the run's spend accounts
and its run-wide input-token cap is refused any run that names an account or
sets the cap, rather than running it unchecked. The loop
policy that lives inside the engine (in-turn windowing and compaction, tool
promotion, the loop supervisor, bound-skill delivery) is declared absent for an
external runtime; the policy at the tool boundary holds for every runtime,
because it lives in the projection.

**ACP is the first external transport, behind a generic runtime that names no
agent.** What one agent needs beyond ACP v1 (how to open it and the working
directory it owns, whether its tools are the projection alone, how the door's
prompt and history reach it) is a driver. NimbleBrain's own engine, served as an
ACP agent, is the reference driver: the same resolved run through the native
runtime and through it must leave the same record. ACP v1 has no slot for a
client's system prompt or for history the agent did not produce. Each driver
delivers them in its agent's own terms: NimbleBrain's driver in a `_meta` format
private to it and its agent, Goose's through Goose's own method and the
generic fallback, and an agent with no means of its own gets them as contained
text ahead of the turn's first message. The
reference agent is driven both ways, so the plain-ACP path every other agent
takes is held to the same record.

**The reference agent becomes nimblebrain-agent, a standalone ACP agent.** It is kept
extractable (it imports the engine and its driver's wire format, nothing else of
the platform) and works over plain ACP on its own defaults. The `_meta` format
it shares with its driver is no platform extension: no other agent is asked to
implement it, and the agent's session options are designed with it.

## Consequences

- Adding an ACP agent that runs out of process is a driver and a configuration
  entry. Adding a runtime that is not ACP (an in-process agent SDK, a remote
  job) is an implementation of the seam. Neither changes the door, the conversation store or the web client.
- An external runtime runs no spend gate, so it serves chat, not budgeted or
  input-capped task runs, until its model calls go through a gateway that enforces a run's budget.
  Each installation serves one tenant, so the gateway meters that tenant; the
  usage an agent reports in ACP is for display, never the billing record.
- An external agent manages its own working context within a turn. Between turns
  the door still windows and compacts the history it hands over, so a
  conversation's cost is bounded at turn boundaries even when it is not within
  one.
- The agent's private reasoning streams to the person but is not persisted as
  conversation content.
- Every tool call of an external runtime is an HTTP round trip on loopback; the
  projection's lifetime is the run's, so nothing listens after it ends.
- ACP names a tool call only by a free-text title, so a permission request
  cannot be matched to a tool reliably. A driver declares whether its agent's
  tools are the projection alone; when they are, every request is allowed,
  because the projection checks the call again when it runs. Interactive
  approval by a person has no channel yet, on any runtime.
- An agent's own session id is meaningful to that runtime only. With a fresh
  store per run, a runtime may reuse the same id across runs, which is harmless
  only because nothing keys on it.

## Alternatives considered

- **Point the agent at `/mcp/<wsId>`** — rejected: it builds an attended context
  from the caller's identity, so an unattended run would reach authoring tools
  its `allowedTools` excludes, and no run-scoped credential exists for it.
- **Reuse the agent's session across turns (`session/load`)** — deferred: it
  makes the agent's store a second record of the conversation, which is out of
  step with the log after compaction or after a turn on another runtime.
- **A separate seam for "which loop" beside ADR-0047's "where the loop runs"** —
  rejected: both receive a resolved run and call back through the same I/O, so
  two abstractions would describe one boundary.
- **Rewrite the native engine as an ACP server and drive every run over ACP** —
  rejected: it adds a protocol hop to every native run for no gain; the engine is
  served over ACP only as the reference agent.
