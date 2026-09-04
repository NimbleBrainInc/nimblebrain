# 0029. Long-running tools are task-augmented; inline calls retry on transport error, task calls never do

- Status: Accepted
- Date: 2026-09-03
- Serves: orchestrate remote MCP

## Context

Some tool calls take minutes: a research sweep, a batch import, a deployment. A
blocking request over HTTP does not survive one — an idle timeout somewhere in
the path kills the socket long before the work finishes, and the failure looks
like a transport error rather than like "still working."

MCP's answer is task augmentation: the client attaches a task to `tools/call`,
the server acknowledges immediately with a task handle, and progress and the
eventual result arrive on a stream the client polls. The client can cancel what
it started.

That changes what a failure means, in a way that matters more than the plumbing.
An inline call that fails on transport either never reached the server or never
came back, and the server holds nothing either way — so re-issuing it is
recovering, not duplicating. A task-augmented call that fails on transport has
already created server-side state: the task exists, and whatever the work does
has begun. Re-issuing it starts a second one.

## Decision

**Long-running tools are task-augmented, and the retry policy inverts with the
augmentation.** Both halves live in `src/tools/mcp-source.ts` — task start,
polling, and cancellation on one side, and the shared recovery path
(`handleExecuteError`, `RecoveryShape`) that reads the idempotency flag on the
other.

The client advertises `tasks` because it exercises it (ADR-0023): the stream is
opened, status is polled, and cancellation dispatches `tasks/cancel`. A server
marks a tool `execution.taskSupport`, and the runtime reads that off the listing
and attaches a task rather than blocking.

**An inline call is treated as idempotent for recovery purposes.** On a transport
failure it routes through the shared recovery path — classify, then surface,
flip to reauth, or re-establish and retry — with a deliberately narrow budget: a
single immediate attempt, not a schedule. It is re-issued with the *scrubbed*
arguments the first dispatch used, because the model's original input may carry
no-op sentinels an upstream API rejects.

**A task-augmented call is never retried.** The recovery policy marks it
non-idempotent, so every failure is surfaced to the agent rather than replayed.
The agent, which can see the task handle and ask about it, is the right party to
decide whether to resume, cancel, or start over — the transport layer is not, and
it cannot know whether the side effect happened.

**Cancellation is not a crash.** A client abort emits a terminal progress event
for task-augmented calls so a watching UI leaves its working state, and returns a
cancellation result. The source is healthy; nothing is restarted and nothing is
marked dead.

**Reads have a different shape again.** A resource read leaves the
recover-on-unclassifiable behaviour off and uses a wider retry window: a
malformed result or a server-side code error should surface rather than
restart-storm the whole source.

## Consequences

- A minutes-long tool is expressible without holding a socket open, and the model
  gets progress rather than a timeout.
- A non-idempotent operation is never silently performed twice by the transport
  layer. The strongest guarantee in this design is the one that comes from *not*
  retrying.
- A task-augmented call that fails on transport surfaces an error to the agent
  even when the work is still running server-side. That is the correct trade —
  the alternative is a duplicate — but it means the agent has to reason about a
  task it can no longer watch.
- The idempotency judgment is made from the augmentation, not from the tool's
  own `idempotentHint`. That is a hint from an untrusted server, and the
  augmentation is a fact about what this client already did.
- Retry budgets differ by call site — one attempt for tool calls, a wider window
  for reads — which is three policies to keep straight rather than one.

## Alternatives considered

- **Blocking on long calls and raising the timeout** — rejected: the timeout is
  not only ours. Proxies and load balancers in the path have their own, and the
  failure is a hung socket with no handle to ask about.
- **Retrying task calls with an idempotency key** — rejected: it requires every
  server to implement one correctly, and a client cannot verify that it did. The
  guarantee would be a hope.
- **Reading `idempotentHint` to decide whether to retry** — rejected: it is a
  hint from an untrusted server. Read it to be more careful, never to relax a
  check.
- **Polling a task's status after a transport failure and resuming** — not
  rejected on principle, but out of scope here: it needs the task handle to have
  survived the failure and a defined resume semantic, neither of which is settled.
