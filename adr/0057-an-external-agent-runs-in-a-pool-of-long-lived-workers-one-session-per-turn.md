# 0057. An external agent runs in a pool of long-lived workers, one session per turn

- Status: Proposed
- Date: 2026-10-26
- Serves: orchestrate remote MCP, secure RBAC
- Refines: ADR-0047 (how its remote execution provider is hosted), ADR-0056 (where an out-of-process agent runs)

## Context

ADR-0056 puts an agent with its own loop either in the runtime's process or
outside the installation, never beside it as a child, and names what an
out-of-process agent needs to join: a remote ACP transport, the tool projection
served on the runtime's own server behind a run-scoped credential, and the
installation's model gateway. It does not say how such agents are hosted.

The only process shape built so far is a test one: the live parity eval starts
an agent as a child per run, over stdio, and stops it when the run ends. That
shape cannot carry production traffic. Every turn would pay a process start,
an agent's start-up cost is its own and can be seconds, and a pod that creates
and reaps a process per turn churns in proportion to traffic.

What a turn actually needs from an agent is a session, not a process. ACP
multiplexes sessions over one connection, and an agent turn spends nearly all
its time waiting on the model and on tool calls, so one agent process holds
many turns at once at little cost per turn (ADR-0047 makes the same observation
for the native loop).

The door already makes the agent stateless between turns. Every execution opens
a fresh session from the history the door hands over (ADR-0056); no agent-side
session is the record of anything. So which agent process takes a turn does
not matter, and nothing ties a conversation to one.

ADR-0047 frames its first remote provider as one durable job per run, so that a
run survives a runtime restart. A turn held on a live connection to a pool does
not: when the runtime pod holding the connection goes, the turn goes with it.

Agents differ in what they can do to their host. One whose only tools are the
run's projection touches nothing local; one with a shell or file tools of its
own acts on whatever machine it runs on. A driver already says which an agent
is (`AcpDriver.toolSurface`).

## Decision

**An external agent runs as a pool of long-lived workers.** Each worker is a
process that serves ACP over a network transport and holds many sessions at
once. A worker starts once and serves turns until it is drained; nothing starts
a process per turn or per conversation.

**A session is one turn, and a worker keeps nothing between turns.** The door
hands each turn its whole context (system prompt, history, limits) at
`session/new`, so any worker in the pool can take any turn. There is no
session affinity, no session store, and no handoff on a rollout.

**The runtime holds one persistent connection per runtime process to the
pool**, and opens each turn as a session on it. The runtime's ACP transport is
that connection; the generic ACP runtime and the driver are unchanged by it.

**Workers hold no secret and no tenant state.** A turn reaches tools through
the tool projection on the runtime's own server, with the run-scoped credential
it was handed for that turn, and reaches the model through the installation's
model gateway, which holds the keys, applies model policy, meters, and checks
the run's budget. A worker's own configuration names the gateway and nothing
else it could misuse.

**One pool per installation.** An installation serves one tenant, so its pool
serves one tenant, and a compromised worker reaches only the runs that tenant
has in flight on it. Sharing a pool across installations is a later decision,
made once run credentials and the gateway have held under production traffic.

**The door's admission queue stays the only queue.** The runtime opens a
session on the pool only for a run that holds a slot (ADR-0047); a worker never
queues. The pool is sized and scaled on sessions in flight per worker, not CPU,
and the door's slots bound how many it is asked to hold.

**A worker drains before it stops.** On shutdown it refuses new sessions and
finishes the ones it holds, within the longest turn the installation allows.
A turn whose worker or connection is lost ends as an error the door records;
an unattended source handles it as it handles any failed run.

**A pooled turn is not durable across a restart.** A run that must survive one
(a long unattended run) needs ADR-0047's durable job provider, which this does
not replace: the pool is the provider for chat and for unattended runs short
enough to retry.

**An agent with tools of its own runs in a sandbox per session.** A driver
whose agent has tools beyond the projection (`toolSurface` other than
`projection`, such as a shell or file editing) gets one isolated sandbox per
session, not a shared worker, because its tools act on the machine it runs on.
An agent whose tools are the projection alone uses the shared pool.

## Consequences

- A turn's start-up cost is one ACP request on an open connection; an agent's
  own start-up is paid once per worker.
- Rollouts and scaling need no coordination with conversations, because no
  worker holds one. A drained worker's turns finish or end as errors; none moves.
- The runtime gains a long-lived outbound connection per process, so a pool
  outage fails turns at once rather than at the next process start. It needs a
  health check and a reconnect with backoff, and the door must refuse a run it
  cannot place rather than queue a second time.
- A turn cut off by a restart is lost, not resumed. Chat shows the error, and an
  unattended run is retried or recorded as failed by its source. Durable runs
  wait for ADR-0047's job provider.
- Each installation runs a pool even when idle. The cost is a small floor per
  installation, traded for one tenant per pool.
- Agents split into two hosting tiers by what they can do: a shared pool for
  agents whose tools are the projection, a sandbox per session for agents with
  tools of their own. The driver's declaration decides which, so the platform
  never guesses.
- Nothing here changes the seam (ADR-0056), the door, the conversation store, or
  the web client. It is the hosting the seam's out-of-process path was waiting
  for, alongside the transport, the run-scoped credential and the gateway.

## Alternatives considered

- **A process per turn or per conversation** — rejected: start-up cost on every
  turn, process churn in proportion to traffic, and a per-conversation process
  holds state the door already owns.
- **A job per run (ADR-0047's first framing) for every run** — not for
  interactive turns: job scheduling latency on every chat turn buys durability a
  chat turn does not need. Kept for the long unattended runs that do.
- **Sticky sessions: a conversation pinned to one worker that keeps its
  session** — rejected: it makes the worker a second record of the conversation
  and ties rollouts to live conversations, for a saving the door's handover
  already makes unnecessary.
- **One pool shared by every installation from the start** — deferred: cheaper,
  but a compromised worker would reach every tenant's runs in flight. Earned once
  run credentials and the gateway are proven.
- **Every agent in a sandbox per session** — rejected for agents whose tools are
  the projection: isolation they do not need, at the per-session start-up cost
  the pool exists to avoid.
