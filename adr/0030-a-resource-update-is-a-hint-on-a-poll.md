# 0030. A resource update is a hint on a poll, and nothing else subscribes

- Status: Accepted
- Date: 2026-09-03
- Serves: orchestrate remote MCP

## Context

The runtime reads MCP resources on demand: a skill entrypoint at chat build
(ADR-0011), a `ui://` panel when a placement mounts. Deliberate reading is what
lets the runtime pace its own load — under push, a server chooses when to spend
the runtime's cycles, and a tenant runtime is one pod, so one server's bug wakes
every tenant at once. That reasoning decided the notifications outbox (ADR-0008).

One reader is an exception, and the shape of the exception is the interesting
part. `McpSource` consumes `notifications/resources/updated`: it subscribes a
URI, remembers it and re-subscribes after every reconnect, and fans the signal
out to listeners without deciding what it means (`subscribeResourceUpdates`,
`subscribeResourceUpdated`, `src/tools/mcp-source.ts`). On a 2026-07-28
connection the URI joins the filter of the source's `subscriptions/listen`
stream; on an older connection it is a `resources/subscribe` request. It is
capability-gated: a server that did not advertise `resources.subscribe` gets
nothing sent, because
declared capabilities are authoritative per spec and probing past them costs
every tools-only server a round trip to be told the method does not exist.

**The one consumer uses it as a latency hint, not as a transport.** The
notifications poller subscribes to the outbox it is already polling and reads at
once when a signal arrives (`#arrangeUpdateHint`, `src/notifications/poller.ts`);
the poll is unchanged and still paces the load. So the pull design is intact and
the subscription only removes waiting from it — which is why the arrangement
sits on the same predicate as the poll rather than on a separate install-time
seam nothing would keep in step.

What the consumer leaves out:

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

The 2026-07-28 specification replaces `resources/subscribe` and
`resources/unsubscribe` with `subscriptions/listen`: a client opts into
notification categories on a long-lived stream, and the server tags what it
delivers with the subscription id. A 2026 connection holds that stream anyway,
because the era sends no notification unsolicited, so subscribing a URI there
adds a filter entry, not a stream.

## Decision

**A resource update is a latency hint on a reader that already polls, carried on
`subscriptions/listen` where the connection speaks the 2026-07-28 revision.**

- The notifications poller is the one subscriber. A signal makes it read at
  once; the poll still paces the load (ADR-0008).
- Every other reader stays on demand. A skill body read at chat build is not
  invalidated by a server's signal.
- Built-in in-process apps advertise no `resources.subscribe`, so their emit
  reaches no one until one of them serves subscriptions (ADR-0022, ADR-0023).
- The subscription is capability-gated: a server that does not advertise
  `resources.subscribe` is sent nothing.

## Consequences

- Load pacing stays the runtime's: a server's signal can make a poll come sooner,
  never make the runtime read more than the poll allows.
- A server that republishes a corrected skill has no way to reach a chat build
  that already read it. The correction lands on the next build.
- A server flooding updates costs the poller early reads, bounded by the read it
  was going to make anyway.

## Alternatives considered

- **Invalidate cached readers on a signal** (skill bodies first) — rejected: it is
  a new invalidation mechanism, not the hint pattern, and nothing measures a
  skill body going stale within a chat build.
- **Serve `resources.subscribe` on in-process sources** — deferred until a client
  of the built-ins would act on the signal. It must be per source when it comes,
  or every built-in claims a capability it does not keep.
