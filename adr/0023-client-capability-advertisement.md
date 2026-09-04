# 0023. The client advertises `tasks` and `extensions`, and nothing it does not serve

- Status: Accepted
- Date: 2026-09-03
- Serves: orchestrate remote MCP

## Context

MCP's `initialize` handshake is where a client tells every server what it can
do. A server reads that block and changes its behaviour: it will hand back a
task rather than block a request, or route a question back through the client,
or emit log notifications, depending on what the client claimed.

That makes an advertised capability a promise, not a preference. A client that
claims something it does not serve produces a server waiting for a client that
will never arrive — and the failure lands on the server's side of the wire, at
call time, where it looks like the server's bug.

There are two ways to declare a non-standard capability. `experimental` is the
spec's free-for-all bag, unkeyed and uncoordinated. `extensions` is the
standardized vendor mechanism, keyed by reverse-DNS so two vendors cannot
collide.

## Decision

**One builder produces the client and its claims** (`buildClient`,
`src/tools/mcp-source.ts`), called on the initial start and again on the OAuth
retry rebuild, so two connections to the same server cannot claim different
things. It advertises exactly two blocks.

**`tasks`, because it is exercised.** The client honours task-augmented
`tools/call` and can cancel what it started: a server that marks a tool with
`execution.taskSupport` sees that this client will attach a task rather than
block the request. The stream is opened, polled, and cancelled by real code paths
(ADR-0029), so the claim is backed. `tasks/list` is not claimed — nothing here
lists tasks, and SEP-2663 removes the method from the spec, so claiming it would
invite a client that never arrives.

**`extensions`, for NimbleBrain-namespaced vendor capabilities** (ADR-0024) —
never `experimental`. `extensions` is the coordinated mechanism, the keys are
reverse-DNS so they cannot collide, and a server reads the block to decide
whether to use an extension or fall back. The field is taken from the SDK's
generated spec types, which track the specification's draft schema and run ahead
of the revision the SDK negotiates on the wire; it travels on the SDK's
authority, not the pinned revision's, and that gap closes on its own as the
revision lands.

**Sampling, elicitation, roots, and logging are not advertised**, and this is not
a not-yet.

- **Roots, sampling, and logging are deprecated by SEP-2577.** New
  implementations are told not to adopt them. Adopting one now would be building
  against a feature already on a removal path.
- **Elicitation has no answerer here.** It asks the client to put a question to a
  human and wait. This runtime is a server-side host: the agent's turn is running
  unattended as often as not, and the human — when there is one — is at the far
  end of an event stream, not synchronously behind the tool call. There is no
  correct implementation of "block this call until someone answers" in a
  scheduled automation, so the honest advertisement is silence.

The same rule binds the other direction. An in-process source does not advertise
`resources.subscribe`, because it registers no handler for it (ADR-0022).

## Consequences

- Every capability in the handshake is backed by code that runs. A server that
  adapts to what this client claims gets the behaviour it adapted to.
- The runtime cannot use sampling to borrow a server's model choice, cannot ask
  a user a mid-call question through MCP, and gets no server log stream. The
  first two are permanent for a server-side host; the third is a deprecation to
  live with.
- Vendor capabilities have exactly one home. `experimental` never appears, so
  there is no second convention to migrate off later.
- `extensions` running ahead of the negotiated revision means a server pinned to
  an older SDK may not model the block at all. It is optional and ignorable by
  construction, so the cost of that is a fallback, not a failure.
- Adding a capability is a two-part change by construction: the claim and the
  code that serves it. Neither half is meaningful alone.

## Alternatives considered

- **Advertise everything the SDK supports** — rejected: the SDK's support is not
  this host's support, and the gap surfaces as a server-side failure at call
  time.
- **`experimental` for the host-resources capability** — rejected: unkeyed, so a
  second vendor's key can collide with ours, and the spec's own guidance points
  at `extensions`.
- **Advertise elicitation and fail the request** — rejected: a server that
  designed a flow around asking the user is worse off than one that knew it
  could not.
- **Wait for `extensions` to land in the negotiated revision** — rejected: the
  block is optional and ignorable, so early adoption costs nothing a server does
  not already have to handle, and the alternative is a second private convention
  to migrate off.
