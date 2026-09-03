# 0030. How far resource-update consumption generalizes

- Status: Proposed
- Date: 2026-09-03
- Serves: orchestrate remote MCP

## Context

The runtime reads MCP resources on demand: a skill entrypoint at chat build
(ADR-0011), a `ui://` panel when a placement mounts. Deliberate reading is what
lets the runtime pace its own load — under push, a server chooses when to spend
the runtime's cycles, and a tenant runtime is one pod, so one server's bug wakes
every tenant at once. That reasoning decided the notifications outbox (ADR-0008).

One reader is now an exception, and the shape of the exception is the
interesting part. `McpSource` consumes `notifications/resources/updated`: it
registers a client-side handler, sends `resources/subscribe` for a URI, remembers
the URI and re-subscribes after every reconnect, and fans the signal out to
listeners without deciding what it means (`subscribeResourceUpdates`,
`subscribeResourceUpdated`, `src/tools/mcp-source.ts`). It is capability-gated:
a server that did not advertise `resources.subscribe` gets nothing sent, because
declared capabilities are authoritative per spec and probing past them costs
every tools-only server a round trip to be told the method does not exist.

**The one consumer uses it as a latency hint, not as a transport.** The
notifications poller subscribes to the outbox it is already polling and reads at
once when a signal arrives (`#arrangeUpdateHint`, `src/notifications/poller.ts`);
the poll is unchanged and still paces the load. So the pull design is intact and
the subscription only removes waiting from it — which is why the arrangement
sits on the same predicate as the poll rather than on a separate install-time
seam nothing would keep in step.

Three things that shipping this did not settle.

- **No other reader subscribes.** A skill body read at chat build is cached for
  the life of that build, and a server republishing a corrected skill has no way
  to say so. Unlike the poller, these readers have no poll for a hint to
  accelerate — a signal would have to invalidate a cache, which is a different
  mechanism.
- **The emit direction still reaches nobody.** `notifyResourceUpdated` emits from
  in-process sources, but `defineInProcessApp` advertises no `resources.subscribe`
  and registers no handler, so a platform built-in emitting one reaches no
  subscriber. That is the rule from ADR-0022 and ADR-0023 holding — a capability
  declared is a capability served, and every built-in would otherwise claim a
  promise none of them keeps.
- **No production server exercises it.** No fleet server advertises
  `resources.subscribe` today, so the path runs against a test fixture rather
  than against traffic.

The consume side has also moved underneath the question. The 2026-07-28
specification replaces `resources/subscribe` and `resources/unsubscribe` with
`subscriptions/listen`: a client opts into notification categories on a
long-lived stream, and the server tags what it delivers with the subscription id.
So "should we subscribe more widely?" is also "are we willing to hold a stream
per source?", which is a different operational question.

## Options

**A. Hint-on-poll is the pattern, and it generalizes to nothing else.** The one
consumer keeps its hint; every other reader stays on demand, permanently.
Cheapest, and it keeps the load-pacing property exactly as ADR-0008 argued it.
Costs: a stale skill body stands until the next chat build, with no way for a
server to say otherwise.

**B. Extend the hint to readers that hold a cache.** Skill bodies are the
candidate: subscribe to the entrypoints discovered at chat build and invalidate
on a signal. Smaller than a general subscription model, and it reuses the seam
that exists. Costs: it is invalidation rather than acceleration, so it is a new
mechanism and not the same pattern wearing a second hat.

**C. Serve `resources.subscribe` on in-process sources.** Makes the existing
emit reach the web shell or an embedded client without the host taking on
anything upstream. Orthogonal to A and B, and the only part with a plausible
caller today. Costs: it has to be per-source rather than blanket, or the
built-ins that serve no subscriptions claim a capability they do not keep.

**D. Migrate to `subscriptions/listen`.** Track the current specification's
shape. Not an alternative to A–C so much as the form whichever of them wins will
eventually take. Costs: a held stream per source per workspace, and an answer for
a server that floods its chosen category.

## What would decide it

- **Whether anything actually goes stale.** How often a resource the host holds
  changes inside the window it holds it — for skill bodies, how often a server
  republishes one within a chat build's lifetime. A rate near zero decides A and
  closes B.
- **What the staleness costs when it happens.** A stale `ui://` panel is a
  refresh. A stale skill body is the model following withdrawn guidance, which is
  a different severity and could carry B alone.
- **Whether any server advertises `resources.subscribe`.** The capability gate
  means every option above is inert against servers that do not. If the answer
  stays "none in production," the measurements that would decide A against B
  cannot be taken from traffic, and the question is answered by design intent
  rather than by data — which is worth saying out loud rather than waiting on.
- **Whether the in-process emit has a consumer.** If the web shell would act on a
  resource-updated notification, C has a caller and is worth doing independently
  of the rest.
- **What a held stream per source costs at fleet scale.** Sources per tenant ×
  tenants per pod, against the pod's connection budget. This is the number that
  gates D.
- **Whether the category opt-in bounds a flooding server.** `subscriptions/listen`
  lets the client choose which categories it accepts, which the old GET stream did
  not. Whether that is a sufficient bound — against a server emitting its chosen
  category in a loop — is the crux of D, and the answer is a rate limit the
  runtime would have to own.
