# 0048. `/mcp/<wsId>` serves 2026-07-28 only

- Status: Accepted
- Date: 2026-10-07
- Serves: orchestrate remote MCP

## Context

`/mcp/<wsId>` served two protocol revisions on one URL. A 2026-07-28 request
carries its version, client and capabilities in a `_meta` envelope and is
served on its own, with no session. A 2025-11-25 client opens a session with
`initialize` and presents its `Mcp-Session-Id` on every later request.

The 2025 leg was the only stateful part of the door. It held a live transport
per session in the process that answered the `initialize`, a session registry
(in memory or Redis) to tell an evicted session from one held by another
process, idle and capacity reclamation, a binding check so a leaked session id
could not be replayed by another identity or at another workspace's URL, and
load-balancer stickiness so a session's requests reached its process. Every
capability the door gained had to land on both legs, and a parity suite held
them equal.

The clients that reach `/mcp` (the Claude clients, the iframe bridge) speak
2026-07-28. The 2025 leg served no client that could not move.

## Decision

**`/mcp/<wsId>` speaks 2026-07-28 and nothing earlier.** Every request is
served by a server built for it, bound to that request's (identity, workspace,
grant). A request without the 2026-07-28 envelope gets the SDK's `-32022`
naming the supported version; GET and DELETE get `405`. The door logs each
refused client by User-Agent, once per process.

This is the server side only. The runtime as a client still falls back to
2025-11-25 for a connector that speaks only that: those servers are not ours
to upgrade.

## Consequences

- The door holds no per-client state. Any process answers any request, and the
  session registry, its Redis backend, reclamation, the binding check and the
  `sessionStore` config are gone. A config that still carries `sessionStore`
  starts with an unknown-key warning.
- A capability is added once. There is no second leg to keep equal.
- Stickiness is no longer needed for `/mcp`. It remains for the browser flows
  in "Running more than one replica" (`src/api/AGENTS.md`).
- A client that speaks only 2025-11-25 cannot connect. It gets an error naming
  2026-07-28, and its User-Agent shows in the logs.
- ADR-0036's session binding becomes request binding: every request is
  authenticated and membership-checked on its own, so there is no session id
  to replay.

## Alternatives considered

- **Keep both legs** — rejected: it keeps the only stateful part of the door,
  and a second leg to hold equal, for clients that already speak 2026-07-28.
- **Translate 2025 sessions onto per-request handling** — rejected: the session
  is the state; translating it keeps the registry and the stickiness.
