# 0030. Whether the host consumes resource-update notifications

- Status: Proposed
- Date: 2026-09-03
- Serves: orchestrate remote MCP

## Context

The runtime reads MCP resources on demand: a skill entrypoint at chat build
(ADR-0011), a notifications outbox on a poll (ADR-0008), a `ui://` panel when a
placement mounts. Every one of those is a read at the moment the value is needed,
and nothing subscribes to changes.

The emit side is half-built and honest about it. `McpSource` exposes
`notifyResourceListChanged` and `notifyResourceUpdated`
(`src/tools/mcp-source.ts`), meaningful only for in-process sources where this
source owns the server end. But in-process sources do not advertise
`resources.subscribe` and register no handler for it (ADR-0022, ADR-0023), so
nothing subscribes and the update notification is delivered to no one. The emit
stays because it is the correct signal at that seam; whether the host consumes
resource updates — and therefore whether `subscribe` should be served — is
unsettled.

The consume side has meanwhile moved underneath the question. The 2026-07-28
specification replaces `resources/subscribe` and `resources/unsubscribe` with
`subscriptions/listen`: a client opts into notification categories on a
long-lived stream, and the server tags what it delivers with the subscription id.
So "should we subscribe?" is now also "are we willing to hold a stream per
source?", which is a different operational question with a different answer.

The pull design has a real argument behind it, not just inertia. Deliberate
polling means the runtime paces its own load: under push, a server chooses when
to spend the runtime's cycles, and a tenant runtime is one pod, so one server's
bug wakes every tenant at once. That reasoning already decided the notifications
outbox (ADR-0008), and it applies here.

But it does not obviously apply everywhere. A skill body read at chat build is
cached for the life of that build; a server that republishes a corrected skill
has no way to say so, and the stale copy stands until the next build.

## Options

**A. Re-read on demand is permanent; say so and delete the emit.** The runtime
reads when it needs a value and never subscribes. Removes the half-built seam and
the question. Costs: no mechanism for a server to invalidate anything the host
cached.

**B. Consume `subscriptions/listen`, per source.** Hold a stream to each remote
source and act on resource-updated notifications — invalidate the cached skill,
re-read the changed resource. Costs: a held stream per source per workspace, and
the load-pacing property inverts. Needs an answer for what a server flooding the
category does.

**C. Consume it narrowly, for one category.** Subscribe only where staleness has
a demonstrated cost — skill resources are the candidate — and keep everything
else on demand. Smaller blast radius; two mechanisms to reason about.

**D. Serve `subscribe`/`listen` on in-process sources without consuming
anything upstream.** Makes the existing emit reach someone (the web shell, an
embedded client) without the host taking on remote streams. Orthogonal to A–C
and possibly the only part with a caller today.

## What would decide it

- **Whether anything actually goes stale.** How often does a resource the host
  read change within the window the host holds it? For skill bodies, that is how
  often a server republishes a skill inside a chat build's lifetime. A rate near
  zero decides A.
- **What the staleness costs when it happens.** A stale `ui://` panel is a
  refresh. A stale skill body is the model following withdrawn guidance, which is
  a different severity and may justify C on its own.
- **Whether there is a consumer for the in-process emit today.** If the web shell
  would act on a resource-updated notification, D has a caller and is worth doing
  independently of the rest.
- **What a held stream per source costs at fleet scale.** Sources per tenant ×
  tenants per pod, against the pod's connection budget. This is the number that
  decides B against C.
- **Whether the load-pacing argument survives the category opt-in.**
  `subscriptions/listen` lets the client choose which categories it accepts,
  which is a real bound the old GET stream did not have. Whether it is a
  sufficient one — against a server that emits its chosen category in a loop — is
  the crux, and the answer is a rate limit the runtime would have to own.
