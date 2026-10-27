# 0057. An external agent runs out of process, on credentials only the runtime mints

- Status: Proposed
- Date: 2026-10-27
- Serves: orchestrate remote MCP, secure RBAC
- Supersedes: ADR-0047's remote execution provider (the seam half is ADR-0056)
- Amends: ADR-0056 (no agent runs in the runtime's process; its reference agent is retired)

## Context

ADR-0056 puts an agent with its own loop either in the runtime's process or
outside the installation, never beside it as a child, and keeps every guarantee
of a run at the door: the tool bound and unattended policy, spend, credentials
used where they are stored, and admission. This ADR decides how an agent outside
the installation is reached, hosted, and given what it needs, without moving any
of those guarantees.

**What a turn needs is a session, not a process.** ACP multiplexes sessions over
one connection, and an agent turn spends nearly all its time waiting on the model
and on tool calls, so one agent process can hold many turns at little cost per
turn. Starting a process per turn pays an agent's own start-up (seconds, for
some) on every turn and churns in proportion to traffic. The door already makes
an agent stateless between turns: every execution opens a fresh session from the
history the door hands over (ADR-0056), so which process takes a turn does not
matter.

**An out-of-process agent calls back in two directions, and each callee must
know which turn is calling.** The tool projection listens on loopback behind a
random per-run bearer, which only an agent on the same host can reach. The
installation's model gateway holds the provider keys, applies model policy and
meters, and must refuse a caller that is not a turn of its installation; to hold
a run to its budget it must know which turn a call belongs to.

**What an agent accepts per session is set by ACP and by the agent.** ACP's
`session/new` carries MCP servers with headers, so a tool credential per session
reaches any agent that takes HTTP MCP servers. ACP has no slot for a model
credential. nimblebrain-agent takes whatever its driver sends at `session/new`;
an agent we do not maintain may read provider keys only from its own process
configuration, which makes a model credential per turn impossible for it while
it serves many turns.

**A turn is work the runtime owns.** The door decides it, its bounds live in the
runtime, and its end is a runtime event. The platform's trust model lets a
service mint scoped tokens for the work it owns, as a task worker's token is.

**A pooled turn rides a live connection and does not survive a restart.** Some
unattended runs must: a long run that a rollout would otherwise end.

**Agents differ in what they can do to their host.** One whose only tools are
the run's projection touches nothing local; one with a shell or file tools acts
on the machine it runs on. A driver says which (`AcpDriver.toolSurface`).

**The same shape has to run on a developer's machine with no cluster:** a worker
started by hand and the runtime, as local processes.

## Decision

### Reach and hosting

**Every external agent runs out of process; none runs in the runtime's.**
NimbleBrain's engine served as an ACP agent is nimblebrain-agent, a standalone
repository that mirrors the engine and documents its own session options. The
in-process reference agent ADR-0056 describes is retired, and with it the
private `_meta` format it shared with its driver. Until a driver reaches an
agent at a configured address, `nimblebrain.json` names no runtime but the
native engine. A scripted ACP agent in the test suite holds the generic runtime
to the native record, and the live eval holds each real agent to it.

**An external agent is reached over a network transport, at an address the
installation configures.** Who starts it is not the runtime's concern: a
developer starts one by hand; an installation's runtime provisioning runs the
pool. The runtime never starts an agent (ADR-0056).

**An external agent runs as a pool of long-lived workers.** Each worker is a
process that serves ACP over the network and holds many sessions at once. It
starts once and serves turns until it is drained; nothing starts a process per
turn or per conversation.

**A session is one turn, and a worker keeps nothing between turns.** The door
hands each turn its whole context when the session opens, through the driver's
own delivery (`session/new`, then `prepareSession`, then the opening prompt), so
any worker can take any turn. There is no session affinity, no session store,
and no handoff on a rollout.

**The runtime holds one persistent connection per runtime process to the pool,**
and opens each turn as a session on it. The generic ACP runtime today opens a
connection per run; pooling moves the connection's lifetime out of the run and
routes each session's updates and tool calls to its run by session id. A run
still enters through the resolved run, and each driver still delivers its context
its own way.

**One pool per installation.** An installation serves one tenant, so its pool
serves one tenant, and a compromised worker reaches only that tenant's turns in
flight. Sharing a pool across installations is a later decision.

**There is one queue, at the door.** The runtime opens a session only for a run
that holds an admission slot; a worker never queues. The pool is sized on
sessions in flight, and the door's slots bound how many it is asked to hold.

**A worker drains before it stops.** On shutdown it refuses new sessions and
finishes the ones it holds, within the longest turn the installation allows. A
turn whose worker or connection is lost ends as an error the door records.

**A run that must survive a restart runs as a durable job instead.** The job
receives the same resolved run and the same credentials as a pooled turn, and
nothing else. The resolved run is stored beside the run record when the run
starts; on boot the source re-enqueues queued runs it may resume, asks the job
service for the status of runs it recorded as running, and reseeds the run's
spend accounts from the usage ledger before authorizing any call from one of
them. The pool serves chat and unattended runs short enough to retry.

**An agent with tools of its own runs in a sandbox per session.** A driver whose
agent has tools beyond the projection (`toolSurface` other than `projection`)
gets one isolated sandbox per session, not a shared worker. An agent whose tools
are the projection alone uses the shared pool.

### Credentials

**The runtime mints a turn's credentials with the installation's run key.** The
run key is installation configuration read through the secrets backend
(ADR-0035), an EdDSA key named by a key id, distinct from the platform's signing
key. Its public half is served at a well-known path on the runtime's own server,
so a gateway verifies without a copy. A credential is minted when the run starts,
not when it is queued, and is held only in memory by whatever receives it: never
written to disk, logs, or a job service's own store.

**A credential names a turn and nothing it could widen.** It carries the issuer
(the installation), an audience, the door's run id as subject, the workspace,
and an expiry. Allowed tools, the unattended policy, spend accounts and limits
stay in the runtime, looked up by run id, so a credential never claims more than
the door decided.

**Each callee gets its own credential.** A turn holds one for the tool
projection and one for the model gateway, with different audiences, so a leaked
model credential cannot call a tool and a leaked tool credential cannot spend.

**The tool credential ends with the turn.** For a remote agent the projection is
a path on the runtime's own server, opened for the turn, behind the tool
credential, and handed to the agent as the session's one MCP server with the
credential as its header. Closing the turn closes the path, so the credential
stops working at the turn's end whatever its expiry says. An agent on the same
host keeps the loopback projection and its random bearer.

**The model credential is per turn where the agent takes one, and per pool where
it cannot.** A driver declares which (`modelCredential: "session" | "process"`).

- `session`: the driver hands the turn's model credential at `session/new`. The
  gateway verifies it, attributes each call to the run, and holds the run to its
  budget. It expires at the turn's longest allowed duration plus the gateway's
  clock leeway.
- `process`: the worker is started with a pool credential, minted with the same
  key, audience the gateway, subject the pool. The gateway can attribute calls to
  the pool only, so the door treats such a runtime as having no spend gate
  (ADR-0056) and serves it chat, not budgeted runs.

**A worker holds no secret, with two named exceptions.** It holds no connector
credential, no provider key and no tenant state; a turn reaches tools and models
only with the turn's credentials. A worker of a `process` agent holds its pool
credential, useful nowhere but this installation's gateway, rotated with the run
key. A worker whose agent can check only a shared secret on its ACP endpoint
holds that secret, which grants nothing beyond opening sessions on that pool.

**A worker's ACP endpoint is reachable only by its installation's runtime,** by
network policy and by a connection credential the runtime presents, verified
with a public key where the agent supports one. Opening a session grants nothing
by itself: everything a session can reach, it reaches with the turn's
credentials.

### Models and development

**The installation's model gateway is every external agent's model endpoint.**
It holds the provider keys, applies model policy, meters every call, and checks
a run's budget where the credential names the run. Usage an agent reports over
ACP is for display, never the billing record.

**Development needs no cluster.** A developer runs one worker on their machine (a
pool of one) and points the installation's `execution` entry at it; the runtime
serves the projection on its own server as in an installation. A gateway is
optional only when the instance runs the `dev` identity provider (ADR-0040): with
no gateway named, the driver may hand the agent a provider key from
configuration. Under any other identity provider the runtime refuses to start an
external runtime without a gateway.

## Consequences

- A turn's start-up cost is opening a session on an open connection; an agent's
  own start-up is paid once per worker.
- Rollouts and scaling need no coordination with conversations, because no
  worker holds one. A drained worker's turns finish or end as errors; none moves.
- The runtime gains a long-lived outbound connection per process, which needs a
  health check and a reconnect with backoff; the door refuses a run it cannot
  place rather than queue it a second time.
- A pooled turn cut off by a restart is lost, not resumed: chat shows the error,
  and an unattended source retries or records the failure. Durable runs need the
  job path and its reconcile.
- Each installation runs a pool even when idle: a small floor per installation,
  traded for one tenant per pool.
- An installation gains a run key and a public-key endpoint; both rotate by key
  id, the old key verifying until its last credential expires.
- The tool projection gains a second listener shape, a path on the runtime's
  server that only a live turn's credential opens.
- Any gateway that verifies JWTs against a published key set can be the model
  gateway; nothing in it is specific to NimbleBrain beyond the audience.
- Agents we maintain can be held to a run's budget at the gateway. An agent that
  reads provider configuration per process cannot while pooled: it stays
  chat-only until ACP or the agent gives a session a model credential, or it runs
  as a durable job per run.
- A model credential can outlive its turn: it lasts as long as the longest turn
  the installation allows, plus the gateway's clock leeway, so raising that limit
  lengthens every model credential's exposure. The tool side ends with the turn.
- Agents split into two hosting tiers by what they can do, decided by the
  driver's declaration, so the platform never guesses.
- Development and installation differ only in who starts the worker and whether a
  gateway stands between it and the provider; the driver, transport and
  projection are the same code.

## Alternatives considered

- **A process per turn or per conversation** — rejected: start-up cost on every
  turn, churn in proportion to traffic, and a per-conversation process holds state
  the door already owns.
- **A durable job for every run** — not for interactive turns: job scheduling on
  every chat turn buys durability a chat turn does not need. Kept for runs that
  must survive a restart.
- **Sticky sessions, a conversation pinned to one worker** — rejected: the worker
  becomes a second record of the conversation and rollouts wait on conversations.
- **One pool shared by every installation from the start** — deferred: a
  compromised worker would reach every tenant's turns in flight.
- **Every agent in a sandbox per session** — rejected for agents whose tools are
  the projection: isolation they do not need, at the start-up cost the pool
  avoids.
- **Shipping a run's connector credentials or a provider key to the agent** —
  rejected: every secret the run touches would leave the store and the wall, and
  spend would be checked by the party that wants to spend.
- **The platform's token service minting turn credentials** — rejected: a turn's
  bounds and its end live in the runtime, so a central minter would need both to
  revoke anything. Revisit if a gateway is shared across installations.
- **One credential for tools and models** — rejected: a leak in either direction
  would reach both.
- **The turn's bounds carried in the credential** — rejected: the runtime holds
  them, and a copy in a token can only drift or be stretched.
- **Callbacks through `/mcp/<wsId>`** — rejected (ADR-0056): it is a person's
  attended surface, not a turn's bound.
- **A runtime-hosted model endpoint** — rejected for the installation's gateway:
  the gateway already holds keys, policy and the meter, and a runtime-hosted
  endpoint would put every model call's traffic through the runtime.
- **A queue in the pool or the job service** — rejected: a second ordering of
  waiting runs that admission and fair share cannot see.
- **Requiring a cluster or containers for development** — rejected: a worker is
  one local process and the runtime already serves HTTP.
