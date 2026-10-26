# 0058. A turn on an external agent carries credentials only the runtime can mint and end

- Status: Proposed
- Date: 2026-10-26
- Serves: secure RBAC, orchestrate remote MCP
- Refines: ADR-0056 (the run-scoped credential it requires), ADR-0057 (what a pooled worker holds)

## Context

ADR-0056 lets an agent with its own loop join an installation once three things
exist: a remote ACP transport, the tool projection served on the runtime's own
server behind a run-scoped credential, and the installation's model gateway.
ADR-0057 hosts such agents as a pool of long-lived workers, one ACP session per
turn, and keeps every secret off the workers.

An out-of-process agent calls back in two directions during a turn, and each
callee must know which turn is calling:

- **Tools.** The tool projection today listens on loopback behind a random
  per-run bearer, which only an agent on the same host can reach. A remote agent
  reaches it over the network, so the projection needs a credential a network
  peer can present and only this turn holds.
- **Models.** The gateway holds the provider keys, applies model policy and
  meters. It must refuse a caller that is not a turn of its installation, and to
  check a run's budget it must know which turn a call belongs to.

What an agent accepts per session is set by ACP and by the agent, not by us.
ACP's `session/new` carries MCP servers with headers, so a tool credential per
session reaches any agent that takes HTTP MCP servers. ACP has no slot for a
model credential; agents read provider keys from their own process
configuration. An agent built on NimbleBrain's engine takes whatever its driver
sends at `session/new`; an agent we do not maintain may take nothing per session,
which makes a model credential per turn impossible for it while it is pooled.

The platform's trust model has one minter for platform tokens, and lets a
service mint scoped tokens for the work it owns (a task worker's token is the
existing case). A turn is work the runtime owns: the door decides it, its
bounds live in the runtime, and its end is a runtime event.

The same shape has to run on a developer's machine with no cluster: a worker
started by hand, the runtime, and optionally a gateway, as local processes.

## Decision

**The runtime mints a turn's credentials with the installation's run key.** The
run key is installation configuration read through the secrets backend
(ADR-0035), an EdDSA key named by a key id, and its public half is served at a
well-known path on the runtime's own server so a gateway can verify without a
copy. No other service mints them, and no request field names whose they are.

**A credential names a turn and nothing else it could widen.** It carries the
issuer (the installation), an audience, the door's run id as subject, the
workspace, and an expiry. Allowed tools, the unattended policy, spend accounts
and limits stay in the runtime and are looked up by run id, so a credential can
never claim more than the door decided.

**Each callee gets its own credential.** A turn holds one for the tool
projection and one for the model gateway, with different audiences, so a
leaked model credential cannot call a tool and a leaked tool credential cannot
spend.

**The tool credential is revoked when the turn ends.** For a remote agent the
projection is a path on the runtime's own server, opened for the turn, behind
the tool credential, handed to the agent as the session's one MCP server with
the credential as its header. Closing the turn closes the path, so the
credential stops working at the turn's end whatever its expiry says. An agent on
the same host keeps the loopback projection and its random bearer.

**The model credential is per turn where the agent takes one, and per pool
where it cannot.** A driver declares which (`modelCredential: "session" |
"process"`).

- `session`: the driver hands the turn's model credential at `session/new`. The
  gateway checks it, attributes each call to the run, and can hold the run to its
  budget. Its expiry bounds it: the turn's longest allowed duration, plus the
  gateway's clock leeway.
- `process`: the worker is started with a pool credential, minted with the same
  key, audience the gateway, subject the pool. It is the one secret a worker of
  such an agent holds, it is useless anywhere but this installation's gateway,
  and it rotates with the run key. The gateway can attribute calls to the pool
  only, so the door treats such a runtime as having no spend gate (ADR-0056) and
  serves it chat, not budgeted runs.

**A worker's ACP endpoint is reachable only by its installation's runtime.** The
pool accepts connections from the runtime alone, by network policy and by a
connection credential the runtime presents. Opening a session grants nothing by
itself: everything a session can reach, it reaches with the turn's credentials.

**Development needs no cluster.** A developer runs one worker on their machine
(a pool of one), points the installation's `execution` entry at its address,
and the runtime serves the projection on its own server as it would in an
installation. A gateway is optional in development: when the instance runs the
`dev` identity provider (ADR-0040) and names no gateway, the driver may hand the
agent a provider key from configuration instead. Any other identity provider
requires a gateway for an external runtime, and the runtime refuses to start
without one.

## Consequences

- An installation gains a run key and a public-key endpoint; both rotate by key
  id, with the old key verifying until its last credential expires.
- The tool projection gets a second listener shape (a path on the runtime's
  server) beside loopback, and the runtime's server gains a route that only a
  live turn's credential opens.
- A gateway that verifies JWTs against a published key set can be the model
  gateway; nothing in it is specific to NimbleBrain beyond the audience.
- Agents we maintain can be held to a run's budget at the gateway. Agents that
  read provider configuration per process cannot while pooled, so they stay
  chat-only until ACP or the agent gives a session a model credential, or until
  they run one session per process.
- A credential outlives its turn by the gateway's clock leeway on the model
  side; the tool side ends with the turn. Expiries stay short for that reason,
  and a turn longer than one expiry needs renewal, which this ADR does not
  provide: such a turn runs on ADR-0047's durable provider or on the native
  runtime.
- Development and installation differ in who starts the worker and whether a
  gateway sits between it and the provider; the driver, the transport and the
  projection are the same code.

## Alternatives considered

- **The platform's token service mints turn credentials** — rejected: a turn's
  bounds and its end live in the runtime, and a central minter would need both
  to revoke anything. Revisit if a gateway is ever shared across installations.
- **One credential for tools and models** — rejected: a leak in either
  direction would reach both.
- **Put the turn's bounds (allowed tools, budget) in the credential** — rejected:
  the runtime already holds them, and a copy in a token can only drift or be
  stretched.
- **Reach the projection through `/mcp/<wsId>`** — rejected in ADR-0056: it is a
  person's attended surface, not a turn's bound.
- **Hand a model credential per turn to every agent by starting a process per
  turn** — rejected for pooled agents: it is the per-turn start-up ADR-0057
  exists to avoid. An agent that needs per-turn model credentials and cannot take
  them per session pays that cost by running as its own job instead.
- **Require a cluster, or containers, for development** — rejected: a worker is
  one local process and the runtime already serves HTTP.
