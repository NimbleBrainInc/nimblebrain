# 0026. A brokered provider owns auth-and-session only, never invocation

- Status: Accepted
- Date: 2026-09-03
- Serves: orchestrate remote MCP

## Context

Some third parties will hold a user's OAuth grant for a SaaS product and hand
back a hosted MCP endpoint that speaks to it. That is genuinely useful: it
removes per-vendor OAuth app registration, per-vendor token refresh, and
per-vendor API drift from the runtime's problem list.

It is also two roles wearing one name. The broker **authenticates** — it runs the
OAuth dance, holds the grant, mints a session. And the broker **hosts** — the
session it returns is a remote MCP server. Only the first role is new. The second
is a remote MCP server, which this runtime already knows how to talk to
(ADR-0020, ADR-0022).

Conflating them produces a provider abstraction that also wraps tool calls, at
which point the runtime has two invocation paths — one for MCP and one for "the
provider" — and MCP's own invocation semantics have to be reimplemented behind
the second.

## Decision

**`ManagedConnectorProvider` (`src/connectors/providers/managed-provider.ts`) is
the auth-and-session broker role, and nothing else.** It creates a session,
initiates an OAuth flow, connects an API key, probes liveness, and mounts its
callback routes. It never touches a tool call. MCP already owns invocation; a
provider that shadowed it would be the anti-pattern the seam exists to avoid.

**The seam is for brokered providers only.** `dcr` and `static` stay
runtime-native: the runtime is the OAuth client, the tokens live in its own
credential store (ADR-0027), and no vendor SDK is involved. Folding them in
would dilute the seam into a god-abstraction that means "connector auth,
somehow." The unifying taxonomy is the connector `auth-kind` enum; this registry
is the brokered subset of it.

**Vendor-neutral by construction.** Every method takes and returns plain
shapes — a session is `{ type, url, headers?, providerRef? }`, an initiation is
a redirect URL and an account id — plus a vendor-free owner. No vendor SDK type
crosses the boundary, and the platform-side broker credential is resolved inside
the implementation rather than threaded through the options.

**What the provider mints, it names.** A broker's session is a stateful object on
the broker's side, so liveness and teardown need to refer to it later.
`ManagedSession.providerRef` carries opaque provider-scoped coordinates for the
runtime to persist and hand back to that provider's own probe and teardown.
Without it the only channel back is the URL, which forces the tool layer to parse
a provider's id format out of a path — a silent-failure hazard and a duplicate of
a formula the provider had in hand.

## Consequences

- A brokered connector's tools are dispatched by the same `McpSource` as any
  other remote server, with the same recovery, the same task augmentation, and
  the same `_meta` handling.
- Adding a broker is one registered implementation rather than a set of hardwired
  modules, and the runtime's dispatch layer learns nothing about it.
- The runtime depends on the broker for liveness truth about a credential it
  cannot see, which is what `ConnectionHealthProbe` exists for (ADR-0028).
- A brokered connector's tool surface is whatever the broker exposes, which may
  differ from the vendor's own MCP server. That is the broker's product decision,
  and the runtime has no view into it.
- `providerRef` is opaque to the *seam*, not to the runtime: the install path
  validates the fields its provider's block declares and lands them in a typed
  shape. So a provider still needs its own typed persisted block and its own
  wiring — the field carries values, not schema. That remaining coupling is
  ADR-0032.

## Alternatives considered

- **A provider abstraction covering invocation too** — rejected: a second
  invocation path, reimplementing MCP's semantics behind a vendor-shaped
  interface.
- **Folding `dcr` and `static` behind the same seam** — rejected: the seam's
  narrowness is what makes it describable. A "connector auth, somehow" interface
  is the union of every vendor's model, and its methods stop meaning anything.
- **Per-vendor modules with no seam** — rejected on evidence: the second brokered
  vendor touched a dozen files outside its own folder.
- **Returning only a URL from `createSession`** — rejected: the id has to come
  back somehow, and parsing it out of a path is a formula in the wrong place that
  fails silently when the broker changes its URL shape.
